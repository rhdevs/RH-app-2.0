import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { resolveEntry } from "~/lib/transcript/duration";
import { retryWriteConflicts } from "~/lib/transcript/writeConflict";
import {
  FREEZE_REASONS,
  FREEZE_STATE_LABEL,
  freezeTarget,
  normaliseYearStatus,
  termAcademicYear,
  type FreezeReason,
  type FreezeSkipReason,
  type FreezeTarget,
} from "~/lib/transcript/lifecycle";
import { liveMembers } from "./liveRoster";
import { NOT_UNFROZEN } from "./loader";
import { actorLabels } from "./residents";

/**
 * FREEZING A CCA'S MEMBER LIST FOR A YEAR.
 *
 * CCAs are cleared and re-recruited after each handover, so a CCA's list is
 * frozen at its own handover (or when a head is removed, when its head locks it,
 * or when the year is closed). A freeze writes one frozen TranscriptRosterEntry
 * for every live member, resolved exactly as the head's screen shows them
 * (overrides, else defaults, with the role inside the membership), and one
 * CcaYearFreeze record, in ONE transaction.
 *
 * Nothing here ever writes CCA / UserCCA / User.
 */

/** Rows per write, so one call never carries thousands of documents. */
export const WRITE_CHUNK = 1000;

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Updates that write the same values, as one `{ ids, data }` per distinct
 * payload and at most WRITE_CHUNK ids each. Most members share a payload (a
 * full year, no role, no extra), so a freeze needs a handful of round trips
 * rather than one per member.
 */
export function groupByPayload<D extends object>(
  updates: ReadonlyArray<{ id: string; data: D }>,
): Array<{ ids: string[]; data: D }> {
  const byPayload = new Map<string, { ids: string[]; data: D }>();
  for (const u of updates) {
    const key = JSON.stringify(u.data);
    const group = byPayload.get(key);
    if (group) group.ids.push(u.id);
    else byPayload.set(key, { ids: [u.id], data: u.data });
  }
  return [...byPayload.values()].flatMap((g) =>
    chunked(g.ids, WRITE_CHUNK).map((ids) => ({ ids, data: g.data })),
  );
}

const isDuplicateKey = (error: unknown) =>
  (error as { code?: string }).code === "P2002";

/** The years a CCA has an ACTIVE freeze for. */
export async function activeFrozenYears(
  db: PrismaClient,
  ccaID: number,
): Promise<Set<string>> {
  const rows = await db.ccaYearFreeze.findMany({
    where: { ccaID, ...NOT_UNFROZEN },
    select: { academicYear: true },
  });
  return new Set(rows.map((r) => r.academicYear));
}

/** The years whose transcripts are published: never a CCA's working year. */
export async function publishedYears(db: PrismaClient): Promise<Set<string>> {
  const rows = await db.transcriptPeriod.findMany({
    where: { status: "published" },
    select: { academicYear: true },
  });
  return new Set(rows.map((r) => r.academicYear));
}

/** The year a CCA is working on (see termAcademicYear). */
export async function termYearOf(
  db: PrismaClient,
  ccaID: number,
  now: Date = new Date(),
): Promise<string> {
  const [frozen, published] = await Promise.all([
    activeFrozenYears(db, ccaID),
    publishedYears(db),
  ]);
  return termAcademicYear(frozen, now, published);
}

/**
 * The LATE-HANDOVER rule: when a CCA's most recent active freeze was made by
 * Close year and no head has been appointed since, a handover or head removal
 * does not freeze again. Last year's members are already recorded; the new
 * recruits fill the new year. A head appointed after that freeze (a handover
 * that installed new heads) means the next head change freezes as usual.
 */
async function lateHandoverAfterClose(
  db: PrismaClient,
  ccaID: number,
): Promise<boolean> {
  const latest = await db.ccaYearFreeze.findFirst({
    where: { ccaID, ...NOT_UNFROZEN },
    orderBy: { frozenAt: "desc" },
    select: { reason: true, frozenAt: true },
  });
  if (latest?.reason !== "close_year") return false;
  const newer = await db.ccaHead.count({
    where: { ccaID, grantedAt: { gt: latest.frozenAt } },
  });
  return newer === 0;
}

/**
 * The year a head change (handover or head removal) would freeze, or why it
 * would not. Shared by the freeze itself and the handover dialog's warning,
 * so the warning never names a year the freeze would not touch.
 */
export async function headChangeFreezeTarget(
  db: PrismaClient,
  ccaID: number,
  now: Date = new Date(),
): Promise<FreezeTarget> {
  const [frozen, published] = await Promise.all([
    activeFrozenYears(db, ccaID),
    publishedYears(db),
  ]);
  const target = freezeTarget(frozen, now, published);
  if (target.kind === "skipped") return target;
  if (await lateHandoverAfterClose(db, ccaID)) {
    return { kind: "skipped", reason: "late_handover_after_close_year" };
  }
  return target;
}

/** The ACTIVE freeze of a CCA for a year, or null. */
export function activeFreeze(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
) {
  return db.ccaYearFreeze.findFirst({
    where: { ccaID, academicYear, ...NOT_UNFROZEN },
  });
}

export type FreezeResult =
  | {
      kind: "frozen";
      academicYear: string;
      memberCount: number;
      /** Members the roster resolver could not match to a person (not frozen). */
      unresolvedCount: number;
      reason: FreezeReason;
    }
  | { kind: "unchanged"; academicYear: string }
  | { kind: "skipped"; reason: FreezeSkipReason };

/**
 * A freeze that lost a race: a unique key collided but no active freeze exists,
 * so the CCA is NOT frozen. Labelled as a transient transaction error, so
 * retryWriteConflicts runs the freeze again from a fresh read; after the bound
 * it is thrown, and the caller refuses (a head change) or reports it.
 */
function freezeRaceError(cause: unknown): Error {
  return Object.assign(
    new Error("FREEZE_RACE: the member list changed while it was being frozen"),
    { errorLabels: ["TransientTransactionError"], cause },
  );
}

export interface FreezeInput {
  ccaID: number;
  reason: FreezeReason;
  actorUserID: string;
  now?: Date;
  /**
   * Close year names the year it is closing. Everything else leaves it out and
   * freezes the CCA's own term year (never a future one).
   */
  academicYear?: string;
}

/**
 * Freeze a CCA's member list. Idempotent: a year that is already frozen is left
 * as it is. Refuses a year whose period is published. A freeze that loses a
 * write conflict is run again from the start (it re-reads what is frozen, so a
 * freeze that won meanwhile makes it "unchanged").
 */
export function freezeCca(
  db: PrismaClient,
  input: FreezeInput,
): Promise<FreezeResult> {
  return retryWriteConflicts(() => freezeOnce(db, input));
}

async function freezeOnce(
  db: PrismaClient,
  input: FreezeInput,
): Promise<FreezeResult> {
  const now = input.now ?? new Date();

  let academicYear: string;
  if (input.academicYear) {
    academicYear = input.academicYear;
    const frozen = await activeFrozenYears(db, input.ccaID);
    if (frozen.has(academicYear)) return { kind: "unchanged", academicYear };
  } else {
    // A head change follows the late-handover rule; a head's lock does not.
    const target =
      input.reason === "handover" || input.reason === "head_removed"
        ? await headChangeFreezeTarget(db, input.ccaID, now)
        : freezeTarget(
            await activeFrozenYears(db, input.ccaID),
            now,
            await publishedYears(db),
          );
    if (target.kind === "skipped") return target;
    academicYear = target.academicYear;
  }

  const period = await db.transcriptPeriod.findUnique({
    where: { academicYear },
  });
  if (normaliseYearStatus(period?.status) === "published") {
    throw new TRPCError({ code: "FORBIDDEN", message: "PERIOD_PUBLISHED" });
  }

  // Who is in the CCA (upstream data), read first; the transcript entries are
  // read INSIDE the transaction, so the diff below and the writes come from one
  // consistent view and a head's save in between cannot slip past.
  const { members, unresolved } = await liveMembers(db, input.ccaID);
  const allKeys = [...new Set(members.flatMap((m) => m.keys))];
  const apps =
    allKeys.length === 0
      ? []
      : await db.ccaApplication.findMany({
          where: {
            ccaID: input.ccaID,
            status: "accepted",
            userID: { in: allKeys },
          },
          select: { userID: true, decidedAt: true },
        });
  const sem2Start = period?.sem2Start ?? null;

  let memberCount = 0;
  try {
    await db.$transaction(
      async (tx) => {
        const stored = await tx.transcriptRosterEntry.findMany({
          where: { academicYear, ccaID: input.ccaID },
        });
        const storedBy = new Map(stored.map((e) => [e.userID, e]));

        const toCreate: Prisma.TranscriptRosterEntryCreateManyInput[] = [];
        const toUpdate: Array<{
          id: string;
          data: Prisma.TranscriptRosterEntryUpdateInput;
        }> = [];
        for (const m of members) {
          let decidedAt: Date | null = null;
          for (const a of apps) {
            if (!m.keys.includes(a.userID) || !a.decidedAt) continue;
            if (!decidedAt || a.decidedAt < decidedAt) decidedAt = a.decidedAt;
          }
          const own = storedBy.get(m.key) ?? null;
          const r = resolveEntry(
            own,
            { decidedAt, isHead: m.entry.isHead, grantedAt: m.entry.grantedAt },
            sem2Start,
          );
          const data = {
            duration: r.duration,
            roleLabel: r.roleLabel,
            roleDuration: r.roleDuration,
            extraContribution: r.extraContribution,
            frozen: true,
            updatedBy: input.actorUserID,
            updatedAt: now,
          };
          if (own) toUpdate.push({ id: own.id, data });
          else
            toCreate.push({
              academicYear,
              userID: m.key,
              ccaID: input.ccaID,
              ...data,
            });
        }

        // The frozen list is exactly today's: clear every older freeze flag
        // for this CCA and year first (people who have left drop out).
        await tx.transcriptRosterEntry.updateMany({
          where: { academicYear, ccaID: input.ccaID },
          data: { frozen: false },
        });
        for (const group of groupByPayload(toUpdate)) {
          await tx.transcriptRosterEntry.updateMany({
            where: { id: { in: group.ids } },
            data: group.data,
          });
        }
        for (const chunk of chunked(toCreate, WRITE_CHUNK)) {
          await tx.transcriptRosterEntry.createMany({ data: chunk });
        }
        // One document per year and CCA: a later freeze reuses it.
        memberCount = toCreate.length + toUpdate.length;
        const record = {
          reason: input.reason,
          frozenAt: now,
          frozenBy: input.actorUserID,
          memberCount,
          unresolvedCount: unresolved,
          unfrozenAt: null,
          unfrozenBy: null,
          unfreezeReason: null,
        };
        await tx.ccaYearFreeze.upsert({
          where: {
            academicYear_ccaID: { academicYear, ccaID: input.ccaID },
          },
          create: { academicYear, ccaID: input.ccaID, ...record },
          update: record,
        });
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // A unique key collided. "Already frozen" ONLY if someone else's freeze
    // of this CCA and year now stands; otherwise the collision was a roster
    // entry written meanwhile, the transaction rolled back and NOTHING is
    // frozen: run it again from a fresh read.
    if (await activeFreeze(db, input.ccaID, academicYear)) {
      return { kind: "unchanged", academicYear };
    }
    throw freezeRaceError(error);
  }

  return {
    kind: "frozen",
    academicYear,
    memberCount,
    unresolvedCount: unresolved,
    reason: input.reason,
  };
}

/**
 * Undo a freeze (an accidental one), while the year is not published. The
 * frozen entries become annotations again, so the CCA's CURRENT member list is
 * used for that year until it is frozen again.
 */
export async function unfreezeCca(
  db: PrismaClient,
  input: {
    ccaID: number;
    academicYear: string;
    reason: string;
    actorUserID: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const period = await db.transcriptPeriod.findUnique({
    where: { academicYear: input.academicYear },
  });
  if (normaliseYearStatus(period?.status) === "published") {
    throw new TRPCError({ code: "FORBIDDEN", message: "PERIOD_PUBLISHED" });
  }
  const freeze = await activeFreeze(db, input.ccaID, input.academicYear);
  if (!freeze) {
    throw new TRPCError({ code: "NOT_FOUND", message: "NOT_FROZEN" });
  }
  await db.$transaction(async (tx) => {
    await tx.ccaYearFreeze.update({
      where: { id: freeze.id },
      data: {
        unfrozenAt: now,
        unfrozenBy: input.actorUserID,
        unfreezeReason: input.reason,
      },
    });
    await tx.transcriptRosterEntry.updateMany({
      where: { academicYear: input.academicYear, ccaID: input.ccaID },
      data: { frozen: false },
    });
  });
  return { ccaID: input.ccaID, academicYear: input.academicYear };
}

export interface UnfreezePreviewPerson {
  userID: string;
  name: string;
}

/**
 * What an Unfreeze would change: an unfrozen list is rebuilt from TODAY's
 * members when it is frozen again, so after a handover new recruits would
 * replace last year's. `dropped`: frozen now, not a live member any more.
 * `added`: a live member now, not on the frozen list.
 */
export async function unfreezePreview(
  db: PrismaClient,
  ccaID: number,
  academicYear: string,
): Promise<{
  dropped: UnfreezePreviewPerson[];
  added: UnfreezePreviewPerson[];
  unresolvedCount: number;
}> {
  const [entries, live] = await Promise.all([
    db.transcriptRosterEntry.findMany({
      where: { academicYear, ccaID, frozen: true },
      select: { userID: true },
    }),
    liveMembers(db, ccaID),
  ]);
  const frozenIDs = new Set(entries.map((e) => e.userID));
  const liveIDs = new Set(live.members.map((m) => m.key));
  const droppedIDs = [...frozenIDs].filter((id) => !liveIDs.has(id));
  const addedIDs = [...liveIDs].filter((id) => !frozenIDs.has(id));
  const label = await actorLabels(db, [...droppedIDs, ...addedIDs]);
  const people = (ids: string[]) =>
    ids
      .map((userID) => ({ userID, name: label(userID) ?? userID }))
      .sort((a, b) => a.name.localeCompare(b.name));
  return {
    dropped: people(droppedIDs),
    added: people(addedIDs),
    unresolvedCount: live.unresolved,
  };
}

/**
 * Freeze a CCA BEFORE a change that removes one of its heads, so the member list
 * is fixed while the outgoing heads can still be asked. Called from the three
 * head-removing paths (handover, revoke, transfer); grant-only changes never
 * call it.
 *
 * `keepOnly` (handover): the heads that will remain; anyone else is removed.
 * `removing` (revoke, transfer): the heads being removed.
 * Nothing happens when no CURRENT head is being removed, and a "skipped"
 * result (the current year is already frozen, or the late-handover rule) never
 * blocks the change. If the freeze itself fails, the head change is refused.
 */
export async function freezeBeforeHeadChange(
  db: PrismaClient,
  input: {
    ccaID: number;
    reason: "handover" | "head_removed";
    actorUserID: string;
    keepOnly?: readonly string[];
    removing?: readonly string[];
    now?: Date;
  },
): Promise<void> {
  const heads = await db.ccaHead.findMany({
    where: { ccaID: input.ccaID },
    select: { userID: true },
  });
  const removed = heads.filter((h) =>
    input.keepOnly
      ? !input.keepOnly.includes(h.userID)
      : (input.removing ?? []).includes(h.userID),
  );
  if (removed.length === 0) return;

  try {
    await freezeCca(db, {
      ccaID: input.ccaID,
      reason: input.reason,
      actorUserID: input.actorUserID,
      now: input.now,
    });
  } catch (cause) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "TRANSCRIPT_FREEZE_FAILED",
      cause,
    });
  }
}

/* ---- what the admin table shows --------------------------------------------- */

export interface FreezeRow {
  ccaID: number;
  ccaName: string;
  category: string;
  reason: FreezeReason | null;
  state: string;
  frozenAt: Date | null;
  frozenByName: string | null;
  memberCount: number | null;
  /** Members the resolver could not match when it was frozen. */
  unresolvedCount: number | null;
}

/** Every CCA's freeze state for one year, for the admin "CCA member lists" table. */
export async function listFreezes(
  db: PrismaClient,
  academicYear: string,
): Promise<{ rows: FreezeRow[]; unfrozen: number }> {
  const [ccas, freezes] = await Promise.all([
    db.cCA.findMany({ orderBy: { ccaName: "asc" } }),
    db.ccaYearFreeze.findMany({ where: { academicYear, ...NOT_UNFROZEN } }),
  ]);
  const by = new Map(freezes.map((f) => [f.ccaID, f]));
  const label = await actorLabels(
    db,
    freezes.map((f) => f.frozenBy),
  );
  const rows = ccas.map((c): FreezeRow => {
    const f = by.get(c.ccaID);
    const reason = f && isReason(f.reason) ? f.reason : null;
    return {
      ccaID: c.ccaID,
      ccaName: c.ccaName,
      category: c.category,
      reason,
      state: FREEZE_STATE_LABEL[reason ?? "none"],
      frozenAt: f?.frozenAt ?? null,
      frozenByName: f ? label(f.frozenBy) : null,
      memberCount: f?.memberCount ?? null,
      unresolvedCount: f?.unresolvedCount ?? null,
    };
  });
  return { rows, unfrozen: rows.filter((r) => r.reason === null).length };
}

const isReason = (v: string): v is FreezeReason =>
  (FREEZE_REASONS as readonly string[]).includes(v);
