import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { resolveEntry } from "~/lib/transcript/duration";
import {
  FREEZE_REASONS,
  FREEZE_STATE_LABEL,
  freezeTarget,
  normaliseYearStatus,
  termAcademicYear,
  type FreezeReason,
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

/** The year a CCA is working on (see termAcademicYear). */
export async function termYearOf(
  db: PrismaClient,
  ccaID: number,
  now: Date = new Date(),
): Promise<string> {
  return termAcademicYear(await activeFrozenYears(db, ccaID), now);
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
      reason: FreezeReason;
    }
  | { kind: "unchanged"; academicYear: string }
  | { kind: "skipped"; reason: "already_frozen_for_current_year" };

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
 * as it is. Refuses a year whose period is published.
 */
export async function freezeCca(
  db: PrismaClient,
  input: FreezeInput,
): Promise<FreezeResult> {
  const now = input.now ?? new Date();
  const frozen = await activeFrozenYears(db, input.ccaID);

  let academicYear: string;
  if (input.academicYear) {
    academicYear = input.academicYear;
    if (frozen.has(academicYear)) return { kind: "unchanged", academicYear };
  } else {
    const target = freezeTarget(frozen, now);
    if (target.kind === "skipped") return target;
    academicYear = target.academicYear;
  }

  const period = await db.transcriptPeriod.findUnique({
    where: { academicYear },
  });
  if (normaliseYearStatus(period?.status) === "published") {
    throw new TRPCError({ code: "FORBIDDEN", message: "PERIOD_PUBLISHED" });
  }

  // Read everything first, then write in one transaction.
  const { members } = await liveMembers(db, input.ccaID);
  const allKeys = [...new Set(members.flatMap((m) => m.keys))];
  const [apps, stored] = await Promise.all([
    allKeys.length === 0
      ? Promise.resolve([])
      : db.ccaApplication.findMany({
          where: {
            ccaID: input.ccaID,
            status: "accepted",
            userID: { in: allKeys },
          },
          select: { userID: true, decidedAt: true },
        }),
    db.transcriptRosterEntry.findMany({
      where: { academicYear, ccaID: input.ccaID },
    }),
  ]);
  const storedBy = new Map(stored.map((s) => [s.userID, s]));
  const sem2Start = period?.sem2Start ?? null;

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

  try {
    await db.$transaction(
      async (tx) => {
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
        const memberCount = toCreate.length + toUpdate.length;
        const record = {
          reason: input.reason,
          frozenAt: now,
          frozenBy: input.actorUserID,
          memberCount,
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
    // Someone froze the same CCA and year at the same moment: it is frozen.
    if (isDuplicateKey(error)) return { kind: "unchanged", academicYear };
    throw error;
  }

  return {
    kind: "frozen",
    academicYear,
    memberCount: toCreate.length + toUpdate.length,
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

/**
 * Freeze a CCA BEFORE a change that removes one of its heads, so the member list
 * is fixed while the outgoing heads can still be asked. Called from the three
 * head-removing paths (handover, revoke, transfer); grant-only changes never
 * call it.
 *
 * `keepOnly` (handover): the heads that will remain; anyone else is removed.
 * `removing` (revoke, transfer): the heads being removed.
 * Nothing happens when no CURRENT head is being removed, and a "skipped"
 * result (the current year is already frozen) never blocks the change. If the
 * freeze itself fails, the head change is refused.
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
    };
  });
  return { rows, unfrozen: rows.filter((r) => r.reason === null).length };
}

const isReason = (v: string): v is FreezeReason =>
  (FREEZE_REASONS as readonly string[]).includes(v);
