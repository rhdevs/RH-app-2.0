import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { canonicalUserID } from "~/lib/identity";
import { parseAcademicYear } from "~/lib/transcript/academicYear";
import { resolveEntry } from "~/lib/transcript/duration";
import { resolveRoster } from "~/server/api/services/ccaRoster";

/**
 * The academic-year state machine: collecting -> published -> (reopen) ->
 * collecting. Only jcrc/admin drive it (the router checks that); everything
 * here takes the Prisma client as a parameter.
 *
 *  - While COLLECTING, heads/JCRC edit and residents cannot download.
 *  - PUBLISH requires sem2Start, freezes the roster in ONE transaction, and
 *    locks edits (`assertCollecting`, for the edit screens to call).
 *  - REOPEN goes back to collecting and supersedes every live issued
 *    transcript of that year, so a resident re-downloads the corrected one.
 *
 * Nothing here ever writes CCA / UserCCA / User.
 */

export const STATUS_COLLECTING = "collecting";
export const STATUS_PUBLISHED = "published";

export type PeriodState = {
  status: string | null;
  sem2Start: Date | null;
} | null;

const isPublished = (p: PeriodState): boolean => p?.status === STATUS_PUBLISHED;

/** Why `publish` must refuse right now, or null if it may proceed. PURE. */
export function publishBlocker(
  period: PeriodState,
): "PERIOD_NOT_FOUND" | "ALREADY_PUBLISHED" | "SEM2_START_REQUIRED" | null {
  if (!period) return "PERIOD_NOT_FOUND";
  if (isPublished(period)) return "ALREADY_PUBLISHED";
  if (!period.sem2Start) return "SEM2_START_REQUIRED";
  return null;
}

/** Why `reopen` must refuse right now, or null if it may proceed. PURE. */
export function reopenBlocker(
  period: PeriodState,
): "PERIOD_NOT_FOUND" | "NOT_PUBLISHED" | null {
  if (!period) return "PERIOD_NOT_FOUND";
  return isPublished(period) ? null : "NOT_PUBLISHED";
}

const BLOCKER_CODE = {
  PERIOD_NOT_FOUND: "NOT_FOUND",
  ALREADY_PUBLISHED: "CONFLICT",
  NOT_PUBLISHED: "CONFLICT",
  SEM2_START_REQUIRED: "PRECONDITION_FAILED",
} as const;

function fail(reason: keyof typeof BLOCKER_CODE): never {
  throw new TRPCError({ code: BLOCKER_CODE[reason], message: reason });
}

function requireValidYear(academicYear: string) {
  const ay = parseAcademicYear(academicYear);
  if (!ay) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "INVALID_ACADEMIC_YEAR",
    });
  }
  return ay;
}

export function getPeriod(db: PrismaClient, academicYear: string) {
  return db.transcriptPeriod.findUnique({ where: { academicYear } });
}

export function listPeriods(db: PrismaClient) {
  return db.transcriptPeriod.findMany({ orderBy: { academicYear: "desc" } });
}

/**
 * THE GUARD THE EDIT SCREENS CALL before changing anything year-scoped (roster
 * annotations, volunteer hours, awards, JCRC service). A year with no period
 * row has never been published, so it is still collecting.
 */
export async function assertCollecting(
  db: PrismaClient,
  academicYear: string,
): Promise<void> {
  requireValidYear(academicYear);
  const period = await getPeriod(db, academicYear);
  if (isPublished(period)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "PERIOD_PUBLISHED" });
  }
}

/** Set (or clear) the date semester 2 begins; creates the period if needed. */
export async function upsertSem2Start(
  db: PrismaClient,
  academicYear: string,
  sem2Start: Date | null,
) {
  const ay = requireValidYear(academicYear);
  if (sem2Start && !(sem2Start >= ay.start && sem2Start < ay.endExclusive)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "SEM2_START_OUTSIDE_YEAR",
    });
  }
  await assertCollecting(db, academicYear);
  return db.transcriptPeriod.upsert({
    where: { academicYear },
    create: { academicYear, sem2Start, status: STATUS_COLLECTING },
    update: { sem2Start },
  });
}

interface LiveMember {
  userID: string;
  ccaID: number;
  isHead: boolean;
  grantedAt: Date | null;
  keys: string[];
}

/**
 * Everyone in every CCA right now, resolved through the same roster resolver
 * the head screens use (UserCCA under either key format, the embedded
 * User.userCCA array, and CcaHead). Rows that cannot be resolved to ONE person
 * are NOT guessed at: they are counted and returned, never frozen.
 */
async function collectLiveMembers(db: PrismaClient) {
  const ccas = await db.cCA.findMany({ select: { ccaID: true } });
  const members = new Map<string, LiveMember>();
  let skippedUnresolved = 0;

  const queue = ccas.map((c) => c.ccaID);
  const worker = async () => {
    for (
      let ccaID = queue.shift();
      ccaID !== undefined;
      ccaID = queue.shift()
    ) {
      const roster = await resolveRoster(db, ccaID);
      for (const e of [...roster.heads, ...roster.members]) {
        if (e.kind !== "resolved") {
          skippedUnresolved += 1;
          continue;
        }
        const userID =
          (e.email ? canonicalUserID(e.email) : null) ??
          e.storedUserID ??
          e.membershipKeys[0] ??
          null;
        if (!userID) {
          skippedUnresolved += 1;
          continue;
        }
        const id = `${userID}|${ccaID}`;
        const seen = members.get(id);
        members.set(id, {
          userID,
          ccaID,
          isHead: (seen?.isHead ?? false) || e.isHead,
          grantedAt: seen?.grantedAt ?? e.grantedAt,
          keys: [
            ...new Set([...(seen?.keys ?? []), userID, ...e.membershipKeys]),
          ],
        });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return { members: [...members.values()], skippedUnresolved };
}

export interface PublishResult {
  academicYear: string;
  frozen: number;
  created: number;
  updated: number;
  skippedUnresolved: number;
}

/**
 * PUBLISH: freeze the roster and open the year to residents, in ONE
 * transaction. The status claim is the first write, as a compare-and-set, so
 * two concurrent publishes cannot both win: the loser aborts with
 * ALREADY_PUBLISHED and its writes never commit.
 *
 * For every LIVE member, in every CCA, an entry is written with frozen=true:
 *   duration     = the stored override ?? ("sem2" if their accepted
 *                  application was decided on/after sem2Start, else "full")
 *   roleLabel    = the stored override ?? ("Head" if they hold a CcaHead row)
 *   roleDuration = the stored override ?? (head: "sem2" if granted on/after
 *                  sem2Start else "full")
 * Members who have since left get NO entry, and any earlier frozen flag on
 * their entry is cleared, so the published roster is exactly today's.
 */
export async function publish(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
): Promise<PublishResult> {
  requireValidYear(academicYear);
  const period = await getPeriod(db, academicYear);
  const blocker = publishBlocker(period);
  if (blocker) fail(blocker);
  const sem2Start = period!.sem2Start;

  const { members, skippedUnresolved } = await collectLiveMembers(db);

  // Earliest accepted application per (cca, any of the person's keys).
  const apps = await db.ccaApplication.findMany({
    where: { status: "accepted" },
    select: { ccaID: true, userID: true, decidedAt: true },
  });
  const decided = new Map<string, Date>();
  for (const a of apps) {
    if (!a.decidedAt) continue;
    const id = `${a.userID}|${a.ccaID}`;
    const prev = decided.get(id);
    if (!prev || a.decidedAt < prev) decided.set(id, a.decidedAt);
  }
  const decidedFor = (m: LiveMember): Date | null => {
    let best: Date | null = null;
    for (const k of m.keys) {
      const d = decided.get(`${k}|${m.ccaID}`);
      if (d && (!best || d < best)) best = d;
    }
    return best;
  };

  const existing = await db.transcriptRosterEntry.findMany({
    where: { academicYear },
  });
  const existingBy = new Map(
    existing.map((r) => [`${r.userID}|${r.ccaID}`, r]),
  );

  const toCreate: Prisma.TranscriptRosterEntryCreateManyInput[] = [];
  const toUpdate: Array<{
    id: string;
    data: Prisma.TranscriptRosterEntryUpdateInput;
  }> = [];

  for (const m of members) {
    const stored = existingBy.get(`${m.userID}|${m.ccaID}`) ?? null;
    const r = resolveEntry(
      stored,
      { decidedAt: decidedFor(m), isHead: m.isHead, grantedAt: m.grantedAt },
      sem2Start,
    );
    const data = {
      duration: r.duration,
      roleLabel: r.roleLabel,
      roleDuration: r.roleDuration,
      extraContribution: r.extraContribution,
      frozen: true,
      updatedBy: actorUserID,
      updatedAt: now,
    };
    if (stored) toUpdate.push({ id: stored.id, data });
    else
      toCreate.push({
        academicYear,
        userID: m.userID,
        ccaID: m.ccaID,
        ...data,
      });
  }

  await db.$transaction(
    async (tx) => {
      const claimed = await tx.transcriptPeriod.updateMany({
        where: { academicYear, NOT: { status: STATUS_PUBLISHED } },
        data: {
          status: STATUS_PUBLISHED,
          publishedAt: now,
          publishedBy: actorUserID,
        },
      });
      if (claimed.count !== 1) fail("ALREADY_PUBLISHED");

      // The published roster is exactly today's: clear every old freeze first.
      await tx.transcriptRosterEntry.updateMany({
        where: { academicYear },
        data: { frozen: false },
      });
      for (const u of toUpdate) {
        await tx.transcriptRosterEntry.update({
          where: { id: u.id },
          data: u.data,
        });
      }
      if (toCreate.length > 0) {
        await tx.transcriptRosterEntry.createMany({ data: toCreate });
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

  return {
    academicYear,
    frozen: toCreate.length + toUpdate.length,
    created: toCreate.length,
    updated: toUpdate.length,
    skippedUnresolved,
  };
}

export interface ReopenResult {
  academicYear: string;
  superseded: number;
}

export const SUPERSEDED_REASON = "Academic year reopened";

/**
 * REOPEN: back to collecting. Clears nothing. Every issued transcript of the
 * year that has not been revoked is SUPERSEDED: revokedAt/revokedBy are set (the
 * schema has no other field for it) and `snapshot.meta` gets
 * `{ superseded: true, reason }`, which is what lets /verify say "superseded"
 * rather than "revoked". A resident then gets a fresh transcript on re-publish.
 */
export async function reopen(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
): Promise<ReopenResult> {
  requireValidYear(academicYear);
  const blocker = reopenBlocker(await getPeriod(db, academicYear));
  if (blocker) fail(blocker);

  return db.$transaction(
    async (tx) => {
      const claimed = await tx.transcriptPeriod.updateMany({
        where: { academicYear, status: STATUS_PUBLISHED },
        data: {
          status: STATUS_COLLECTING,
          reopenedAt: now,
          reopenedBy: actorUserID,
        },
      });
      if (claimed.count !== 1) fail("NOT_PUBLISHED");

      const live = await tx.transcriptIssue.findMany({
        where: { academicYear, revokedAt: null },
      });
      for (const issue of live) {
        const snapshot =
          issue.snapshot &&
          typeof issue.snapshot === "object" &&
          !Array.isArray(issue.snapshot)
            ? (issue.snapshot as Record<string, unknown>)
            : {};
        const meta =
          snapshot.meta && typeof snapshot.meta === "object"
            ? (snapshot.meta as Record<string, unknown>)
            : {};
        await tx.transcriptIssue.update({
          where: { id: issue.id },
          data: {
            revokedAt: now,
            revokedBy: actorUserID,
            snapshot: {
              ...snapshot,
              meta: { ...meta, superseded: true, reason: SUPERSEDED_REASON },
            } as Prisma.InputJsonValue,
          },
        });
      }
      return { academicYear, superseded: live.length };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}
