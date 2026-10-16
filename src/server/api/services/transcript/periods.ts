import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { parseAcademicYear } from "~/lib/transcript/academicYear";
import {
  NEXT_STATUS,
  normaliseYearStatus,
  transitionBlocker,
  type TransitionBlocker,
  type YearAction,
} from "~/lib/transcript/lifecycle";
import { freezeCca } from "./freeze";
import { NOT_UNFROZEN } from "./loader";

/**
 * The academic-year state machine, driven only by jcrc/admin (the router checks
 * that); everything here takes the Prisma client (and, where time matters, `now`)
 * as a parameter.
 *
 *   collecting --close--> closed --publish--> published
 *        ^------back------+  ^------reopen------+
 *
 *  - COLLECTING: heads and the JCRC edit. Residents see nothing.
 *  - CLOSE YEAR freezes every CCA that is not frozen yet, then moves to closed.
 *    It needs the semester 2 start date and a year that has begun.
 *  - CLOSED is the review: residents see a DRAFT, and the JCRC fixes data.
 *  - PUBLISH (from closed only) lets residents download. It freezes nothing.
 *  - REOPEN goes back to closed; BACK TO COLLECTING goes from closed to
 *    collecting. Frozen member lists stay frozen either way.
 *
 * Nothing here ever writes CCA / UserCCA / User.
 */

export const STATUS_COLLECTING = "collecting";
export const STATUS_CLOSED = "closed";
export const STATUS_PUBLISHED = "published";

const BLOCKER_CODE: Record<
  TransitionBlocker | "PERIOD_NOT_FOUND",
  "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED"
> = {
  PERIOD_NOT_FOUND: "NOT_FOUND",
  NOT_COLLECTING: "CONFLICT",
  NOT_CLOSED: "CONFLICT",
  NOT_PUBLISHED: "CONFLICT",
  SEM2_START_REQUIRED: "PRECONDITION_FAILED",
  YEAR_NOT_STARTED: "PRECONDITION_FAILED",
};

function fail(reason: keyof typeof BLOCKER_CODE): never {
  throw new TRPCError({ code: BLOCKER_CODE[reason], message: reason });
}

/**
 * MongoDB aborts the loser of two overlapping transactions with a write
 * conflict (Prisma P2034). That is the same outcome as losing the status claim:
 * someone else is changing this year right now.
 */
async function transitioning<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: string }).code === "P2034") {
      throw new TRPCError({ code: "CONFLICT", message: "PERIOD_CHANGING" });
    }
    throw error;
  }
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

/**
 * The academic years residents can download, oldest first. Names only: a
 * resident learns nothing else about a period (no dates, no who published it).
 */
export async function listPublishedYears(db: PrismaClient): Promise<string[]> {
  const rows = await db.transcriptPeriod.findMany({
    where: { status: STATUS_PUBLISHED },
    select: { academicYear: true },
  });
  return rows.map((r) => r.academicYear).sort();
}

/** The years a resident can OPEN: published ones, and closed ones as drafts. */
export async function listViewableYears(
  db: PrismaClient,
): Promise<Array<{ academicYear: string; draft: boolean }>> {
  const rows = await db.transcriptPeriod.findMany({
    where: { status: { in: [STATUS_PUBLISHED, STATUS_CLOSED] } },
    select: { academicYear: true, status: true },
  });
  return rows
    .map((r) => ({
      academicYear: r.academicYear,
      draft: r.status === STATUS_CLOSED,
    }))
    .sort((a, b) => a.academicYear.localeCompare(b.academicYear));
}

export function listPeriods(db: PrismaClient) {
  return db.transcriptPeriod.findMany({ orderBy: { academicYear: "desc" } });
}

/**
 * THE GUARD THE EDIT SCREENS CALL before changing anything year-scoped (roster
 * annotations, volunteer hours, awards, JCRC service). A year with no period
 * row has never been published, so it is still collecting. Only a PUBLISHED
 * year refuses here; who may edit a closed year, or a frozen CCA, is decided by
 * `assertCanEditCcaYear` (editRights.ts).
 */
export async function assertCollecting(
  db: PrismaClient,
  academicYear: string,
): Promise<void> {
  requireValidYear(academicYear);
  const period = await getPeriod(db, academicYear);
  if (normaliseYearStatus(period?.status) === "published") {
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

/**
 * The day residents are asked to download by (a Singapore calendar date stored
 * as midnight there). Informational: it only drives a banner. It can be set or
 * changed at any time, including while the year is published.
 */
export async function upsertDownloadBy(
  db: PrismaClient,
  academicYear: string,
  downloadBy: Date | null,
) {
  requireValidYear(academicYear);
  return db.transcriptPeriod.upsert({
    where: { academicYear },
    create: { academicYear, downloadBy, status: STATUS_COLLECTING },
    update: { downloadBy },
  });
}

/** The check every transition makes first; throws the blocker as an error. */
async function requireTransition(
  db: PrismaClient,
  action: YearAction,
  academicYear: string,
  now: Date,
) {
  requireValidYear(academicYear);
  const period = await getPeriod(db, academicYear);
  const blocker = transitionBlocker(action, period, academicYear, now);
  if (blocker) fail(blocker);
  return period;
}

/** Compare-and-set the status: only the caller that finds `from` wins. */
async function claimStatus(
  db: PrismaClient,
  academicYear: string,
  action: YearAction,
  from: string,
  extra: Record<string, unknown> = {},
) {
  const claimed = await db.transcriptPeriod.updateMany({
    where:
      from === STATUS_COLLECTING
        ? {
            academicYear,
            OR: [{ status: STATUS_COLLECTING }, { status: { isSet: false } }],
          }
        : { academicYear, status: from },
    data: { status: NEXT_STATUS[action], ...extra },
  });
  if (claimed.count !== 1) {
    // Someone else moved the year between our check and our claim.
    throw new TRPCError({ code: "CONFLICT", message: "PERIOD_CHANGING" });
  }
}

export interface CloseResult {
  academicYear: string;
  /** False when some CCA could not be frozen: the year stays collecting. */
  closed: boolean;
  /** CCAs frozen by this close (the ones that were not frozen already). */
  frozenNow: number;
  /** CCAs that already had an active freeze for this year. */
  alreadyFrozen: number;
  /** CCAs a freeze left alone (frozen meanwhile, or nothing to freeze). */
  skipped: number;
  /** CCAs whose freeze failed; run Close year again to finish them. */
  failed: number;
  failedNames: string[];
}

/** The names of the CCAs with no active freeze for a year, A to Z. */
export async function listUnfrozen(
  db: PrismaClient,
  academicYear: string,
): Promise<string[]> {
  const [ccas, frozen] = await Promise.all([
    db.cCA.findMany({ select: { ccaID: true, ccaName: true } }),
    db.ccaYearFreeze.findMany({
      where: { academicYear, ...NOT_UNFROZEN },
      select: { ccaID: true },
    }),
  ]);
  const done = new Set(frozen.map((f) => f.ccaID));
  return ccas
    .filter((c) => !done.has(c.ccaID))
    .map((c) => c.ccaName)
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** How many CCAs a close would freeze, for the confirmation dialog. */
export async function countUnfrozen(
  db: PrismaClient,
  academicYear: string,
): Promise<number> {
  return (await listUnfrozen(db, academicYear)).length;
}

/**
 * CLOSE YEAR: freeze every CCA that has no active freeze for this year (reason
 * "close_year"), then move the year to closed. Each CCA freezes in its own
 * transaction, one CCA at a time. A CCA whose freeze fails is counted and the
 * rest still go on; the year then stays collecting (with the others frozen) and
 * running Close year again finishes the failed ones.
 */
export async function closeYear(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
): Promise<CloseResult> {
  await requireTransition(db, "close", academicYear, now);

  const [ccas, frozen] = await Promise.all([
    db.cCA.findMany({ select: { ccaID: true, ccaName: true } }),
    db.ccaYearFreeze.findMany({
      where: { academicYear, ...NOT_UNFROZEN },
      select: { ccaID: true },
    }),
  ]);
  const done = new Set(frozen.map((f) => f.ccaID));
  const todo = ccas.filter((c) => !done.has(c.ccaID));

  let frozenNow = 0;
  let skipped = 0;
  const failedNames: string[] = [];
  // One CCA at a time: each freeze is its own transaction, and a slow or failing
  // one never races the others.
  for (const cca of todo) {
    try {
      const result = await freezeCca(db, {
        ccaID: cca.ccaID,
        reason: "close_year",
        actorUserID,
        now,
        academicYear,
      });
      if (result.kind === "frozen") frozenNow += 1;
      else skipped += 1;
    } catch {
      failedNames.push(cca.ccaName);
    }
  }
  const counts = {
    academicYear,
    frozenNow,
    alreadyFrozen: ccas.length - todo.length,
    skipped,
    failed: failedNames.length,
    failedNames,
  };
  // Some CCA is still unfrozen: leave the year collecting, so Close year can be
  // run again and a year is never half closed.
  if (failedNames.length > 0) return { ...counts, closed: false };

  await transitioning(() =>
    claimStatus(db, academicYear, "close", STATUS_COLLECTING, {
      closedAt: now,
      closedBy: actorUserID,
    }),
  );
  return { ...counts, closed: true };
}

export interface PublishResult {
  academicYear: string;
}

/**
 * PUBLISH: closed -> published. Freezes nothing, so it refuses while any CCA has
 * no active freeze for the year (one unfrozen during review, or created after
 * Close year): a head change later could not freeze it in a published year.
 */
export async function publish(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
): Promise<PublishResult> {
  await requireTransition(db, "publish", academicYear, now);
  const unfrozen = await listUnfrozen(db, academicYear);
  if (unfrozen.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `CCAS_NOT_FROZEN:${academicYear}:${unfrozen.join(", ")}`,
    });
  }
  await transitioning(() =>
    claimStatus(db, academicYear, "publish", STATUS_CLOSED, {
      publishedAt: now,
      publishedBy: actorUserID,
    }),
  );
  return { academicYear };
}

export interface ReopenResult {
  academicYear: string;
}

/**
 * REOPEN FOR REVIEW: published -> closed. Clears nothing: a transcript is
 * assembled from the data each time it is opened, so once the year is published
 * again residents see the corrected data. Who reopened it, and when, is recorded.
 */
export async function reopen(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
): Promise<ReopenResult> {
  await requireTransition(db, "reopen", academicYear, now);
  await transitioning(() =>
    claimStatus(db, academicYear, "reopen", STATUS_PUBLISHED, {
      reopenedAt: now,
      reopenedBy: actorUserID,
    }),
  );
  return { academicYear };
}

/** BACK TO COLLECTING: closed -> collecting. Frozen member lists stay frozen. */
export async function backToCollecting(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
): Promise<{ academicYear: string }> {
  await requireTransition(db, "backToCollecting", academicYear, now);
  await transitioning(() =>
    claimStatus(db, academicYear, "backToCollecting", STATUS_CLOSED, {
      backToCollectingAt: now,
      backToCollectingBy: actorUserID,
    }),
  );
  return { academicYear };
}
