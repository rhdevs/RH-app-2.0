import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { parseAcademicYear } from "~/lib/transcript/academicYear";
import {
  isBeforeFirstYear,
  normaliseYearStatus,
  openBlocker,
  type OpenBlocker,
} from "~/lib/transcript/lifecycle";
import { freezeCca } from "./freeze";
import { NOT_UNFROZEN } from "./loader";
import { retryYearConflicts } from "./yearRetry";

/**
 * THE ACADEMIC YEAR, ONE STEP: collecting -> published ("Open"), driven only by
 * jcrc/admin (the router checks that). Everything here takes the Prisma client
 * (and, where time matters, `now`) as a parameter.
 *
 *  - COLLECTING: the current heads and the JCRC fill in records. Residents see
 *    nothing. Each CCA's member list is its live list.
 *  - OPEN TRANSCRIPTS locks every CCA's member list for the year as it is, one
 *    CCA at a time (over several requests if needed), then opens the year to
 *    residents. If any CCA cannot be locked, the year stays collecting, and
 *    running it again locks EVERY CCA again from its current list (replacing
 *    the earlier locks), so what heads changed in between reaches the
 *    published transcripts.
 *
 * Nothing here ever writes CCA / UserCCA / User.
 */

export const STATUS_COLLECTING = "collecting";
export const STATUS_PUBLISHED = "published";

const BLOCKER_CODE: Record<
  OpenBlocker,
  "CONFLICT" | "PRECONDITION_FAILED" | "BAD_REQUEST"
> = {
  YEAR_BEFORE_START: "BAD_REQUEST",
  ALREADY_PUBLISHED: "CONFLICT",
  YEAR_NOT_STARTED: "PRECONDITION_FAILED",
  YEAR_ENDED: "PRECONDITION_FAILED",
};

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

/** A year that is valid AND not before transcripts began (for writes to a period). */
function requireSupportedYear(academicYear: string) {
  const ay = requireValidYear(academicYear);
  if (isBeforeFirstYear(academicYear)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "YEAR_BEFORE_START",
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

/**
 * What the screens may see of a period row: never `lastWriteID`, the year
 * check's internal write marker.
 */
export const PERIOD_FIELDS = {
  id: true,
  academicYear: true,
  downloadBy: true,
  status: true,
  publishedAt: true,
  publishedBy: true,
} as const;

export function listPeriods(db: PrismaClient) {
  return db.transcriptPeriod.findMany({
    orderBy: { academicYear: "desc" },
    select: PERIOD_FIELDS,
  });
}

/**
 * THE GUARD THE EDIT SCREENS CALL before changing anything year-scoped (roster
 * annotations, volunteer hours, awards, JCRC service). A year with no period
 * row has never been opened, so it is still collecting. Only an OPEN
 * (published) year refuses here; who may edit which CCA and year is decided by
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
  requireSupportedYear(academicYear);
  // A write to the period row like any other: retried when it loses a write
  // conflict. Two upserts of a missing row (this and a head's first save in
  // August) can both try to create it; the loser gets a duplicate, and the
  // row is there now, so it only needs the date.
  return retryYearConflicts(async () => {
    try {
      return await db.transcriptPeriod.upsert({
        where: { academicYear },
        create: { academicYear, downloadBy, status: STATUS_COLLECTING },
        update: { downloadBy },
        select: PERIOD_FIELDS,
      });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "P2002") throw error;
      return db.transcriptPeriod.update({
        where: { academicYear },
        data: { downloadBy },
        select: PERIOD_FIELDS,
      });
    }
  });
}

export interface OpenResult {
  academicYear: string;
  /** True once every CCA is locked and the year is open to residents. */
  opened: boolean;
  /** The run: pass it back to continue it while `opened` is false. */
  runID: string;
  /** CCAs this run has locked so far, over all its requests. */
  lockedInRun: number;
  /** CCAs there are. */
  totalCcas: number;
  /** CCAs locked by this request, from their current lists. */
  lockedNow: number;
  /**
   * Of those, the CCAs an earlier run had locked: their old locks were
   * replaced.
   */
  relocked: number;
  /** CCAs that could not be locked, with a short code; run it again to finish. */
  failures: Array<{ name: string; code: string }>;
  /** Members, across the CCAs locked now, the roster resolver could not match. */
  unresolved: number;
}

/** How long one request of Open transcripts keeps locking CCAs (the route allows 60 s). */
export const OPEN_STEP_BUDGET_MS = 20_000;

/** A runID whose first lock is older than this is not continued: a new run starts. */
export const OPEN_RUN_MAX_AGE_MS = 10 * 60_000;

/** A short, loggable reason a lock failed: a code-shaped word, never free text. */
function failureCode(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown };
  if (error instanceof TRPCError) {
    return /^[A-Z][A-Z0-9_]+/.exec(error.message)?.[0] ?? error.code;
  }
  if (typeof e?.code === "string") return e.code;
  const message = typeof e?.message === "string" ? e.message : "";
  return /^[A-Z][A-Z0-9_]+/.exec(message)?.[0] ?? "UNKNOWN";
}

/**
 * Every CCA, in ccaID order; the ones this run has locked; and the ones whose
 * lock is current for this run: its own, or one another Open run made since
 * this run began (two presses at the same moment), so concurrent runs never
 * undo each other. A lock older than this run's first one is stale.
 */
async function runCoverage(
  db: PrismaClient,
  academicYear: string,
  runID: string,
) {
  const [ccas, locks] = await Promise.all([
    db.cCA.findMany({
      select: { ccaID: true, ccaName: true },
      orderBy: { ccaID: "asc" },
    }),
    db.ccaYearFreeze.findMany({
      where: { academicYear, ...NOT_UNFROZEN },
      select: { ccaID: true, openRunID: true, frozenAt: true },
    }),
  ]);
  const mine = locks.filter((l) => l.openRunID === runID);
  const since = Math.min(...mine.map((l) => l.frozenAt.getTime()));
  return {
    ccas,
    since,
    locked: new Set(mine.map((l) => l.ccaID)),
    covered: new Set(
      locks
        .filter((l) => l.openRunID && l.frozenAt.getTime() >= since)
        .map((l) => l.ccaID),
    ),
  };
}

/**
 * OPEN TRANSCRIPTS for a year: the CURRENT one only, still collecting. A past
 * year is refused (YEAR_ENDED) because its member lists have already changed in
 * August; a future one has not started. Locks every CCA's member list exactly
 * as it is now, one CCA at a time, each in its own transaction; a CCA an
 * earlier run already locked is locked AGAIN from its current list, replacing
 * that lock and its entries, because heads could still change the list and the
 * records while the year stayed collecting.
 *
 * One RUN can take several requests: each locks CCAs in ccaID order for about
 * `budgetMs`, skipping the CCAs this run (`runID`) already locked, and returns
 * `opened: false` with the runID to continue. Without a runID a new run starts
 * and locks every CCA again. If ANY CCA fails, the year stays collecting,
 * nothing is opened, and the failures are returned (and logged without any
 * message text or member ids). Once every CCA there is has a lock from this
 * run (or a newer one from a run pressed at the same moment) the year becomes
 * published, with who opened it and when.
 */
export async function openTranscripts(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
  options: { runID?: string; budgetMs?: number } = {},
): Promise<OpenResult> {
  requireSupportedYear(academicYear);
  const period = await getPeriod(db, academicYear);
  const blocker = openBlocker(
    academicYear,
    normaliseYearStatus(period?.status),
    now,
  );
  if (blocker) {
    throw new TRPCError({ code: BLOCKER_CODE[blocker], message: blocker });
  }

  const started = Date.now();
  const budgetMs = options.budgetMs ?? OPEN_STEP_BUDGET_MS;
  let runID = options.runID ?? randomUUID();
  const first = await runCoverage(db, academicYear, runID);
  const { ccas } = first;
  let { locked } = first;
  if (
    options.runID &&
    (locked.size === 0 || now.getTime() - first.since > OPEN_RUN_MAX_AGE_MS)
  ) {
    runID = randomUUID();
    locked = new Set();
  }
  // The CCAs THIS run has not locked yet. Locks from an earlier run do not
  // count: every CCA is locked again from its current list.
  const todo = ccas.filter((c) => !locked.has(c.ccaID));

  let relocked = 0;
  let lockedNow = 0;
  let unresolved = 0;
  let attempted = 0;
  const failures: Array<{ name: string; code: string }> = [];
  const result = (
    opened: boolean,
    coverage = { ccas, locked },
  ): OpenResult => ({
    academicYear,
    opened,
    runID,
    lockedInRun: coverage.ccas.filter((c) => coverage.locked.has(c.ccaID))
      .length,
    totalCcas: coverage.ccas.length,
    lockedNow,
    relocked,
    failures: [...failures],
    unresolved,
  });

  for (const cca of todo) {
    // Out of time for this request: the client continues the run.
    if (attempted > 0 && Date.now() - started >= budgetMs) break;
    attempted += 1;
    try {
      const frozen = await freezeCca(db, {
        ccaID: cca.ccaID,
        academicYear,
        actorUserID,
        now,
        openRunID: runID,
      });
      locked.add(cca.ccaID);
      lockedNow += 1;
      if (frozen.replaced) relocked += 1;
      unresolved += frozen.unresolvedCount;
    } catch (error) {
      // Counted and reported; the others still go on. Logged without the
      // error's message, which can carry member ids.
      const code = failureCode(error);
      // Someone else opened the year while this run was locking: they locked
      // every CCA first, so there is nothing left to do.
      if (
        code === "PERIOD_PUBLISHED" &&
        normaliseYearStatus((await getPeriod(db, academicYear))?.status) ===
          "published"
      ) {
        failures.length = 0;
        return result(true);
      }
      console.error(
        JSON.stringify({
          evt: "transcript_lock_failed",
          ccaID: cca.ccaID,
          academicYear,
          code,
          name: error instanceof Error ? error.name : typeof error,
        }),
      );
      failures.push({ name: cca.ccaName, code });
    }
  }
  // Some CCA could not be locked, or this request ran out of time: the year
  // stays collecting, so a year is never half open.
  if (failures.length > 0 || attempted < todo.length) return result(false);

  // Right before the claim: every CCA there is NOW has a current lock. A CCA
  // created while the run was locking has none, so the year is not claimed
  // and the client's next request locks it.
  const final = await runCoverage(db, academicYear, runID);
  if (final.ccas.some((c) => !final.covered.has(c.ccaID))) {
    return result(false, final);
  }

  await claimYear(db, academicYear, actorUserID, now);
  return result(true, final);
}

/**
 * Mark the year open. Any status but "published" is claimed (collecting, unset,
 * or a legacy "closed"), once. With no period row yet it is created; if two
 * runs race, the loser finds the winner's open year and is done.
 */
async function claimYear(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date,
): Promise<void> {
  try {
    // Idempotent, so a claim that loses a write conflict (to a save's final
    // touch of the row) is simply run again, with the year-write bounds.
    await retryYearConflicts(() =>
      claimYearOnce(db, academicYear, actorUserID, now),
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    // Logged without the error's message (which can carry names), then a coded
    // error the screen can explain, never a raw database error.
    const e = error as { code?: unknown; name?: unknown };
    console.error(
      JSON.stringify({
        evt: "transcript_open_failed",
        academicYear,
        code: typeof e.code === "string" ? e.code : "UNKNOWN",
        name: typeof e.name === "string" ? e.name : typeof error,
      }),
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "OPEN_FAILED",
    });
  }
}

async function claimYearOnce(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claimed = await db.transcriptPeriod.updateMany({
      where: {
        academicYear,
        OR: [
          { status: { not: STATUS_PUBLISHED } },
          { status: { isSet: false } },
        ],
      },
      data: {
        status: STATUS_PUBLISHED,
        publishedAt: now,
        publishedBy: actorUserID,
      },
    });
    if (claimed.count === 1) return;
    const again = await getPeriod(db, academicYear);
    if (again && normaliseYearStatus(again.status) === "published") return;
    if (!again) {
      try {
        await db.transcriptPeriod.create({
          data: {
            academicYear,
            status: STATUS_PUBLISHED,
            publishedAt: now,
            publishedBy: actorUserID,
          },
        });
        return;
      } catch (error) {
        // A duplicate: someone created the row at the same moment. Look again.
        if ((error as { code?: unknown }).code !== "P2002") throw error;
      }
    }
  }
  throw new TRPCError({ code: "CONFLICT", message: "PERIOD_CHANGING" });
}
