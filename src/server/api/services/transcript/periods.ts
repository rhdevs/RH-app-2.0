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

/**
 * THE ACADEMIC YEAR, ONE STEP: collecting -> published ("Open"), driven only by
 * jcrc/admin (the router checks that). Everything here takes the Prisma client
 * (and, where time matters, `now`) as a parameter.
 *
 *  - COLLECTING: the current heads and the JCRC fill in records. Residents see
 *    nothing. Each CCA's member list is its live list.
 *  - OPEN TRANSCRIPTS locks every CCA's member list for the year as it is, one
 *    CCA at a time, then opens the year to residents. If any CCA cannot be
 *    locked, the year stays collecting, and running it again locks EVERY CCA
 *    again from its current list (replacing the earlier locks), so what heads
 *    changed in between reaches the published transcripts.
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

export function listPeriods(db: PrismaClient) {
  return db.transcriptPeriod.findMany({ orderBy: { academicYear: "desc" } });
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
  return db.transcriptPeriod.upsert({
    where: { academicYear },
    create: { academicYear, downloadBy, status: STATUS_COLLECTING },
    update: { downloadBy },
  });
}

export interface OpenResult {
  academicYear: string;
  /** True once every CCA is locked and the year is open to residents. */
  opened: boolean;
  /** CCAs locked by this run, from their current lists. */
  lockedNow: number;
  /**
   * Of those, the CCAs an earlier run that stopped part way had locked: their
   * old locks were replaced.
   */
  relocked: number;
  /** CCAs that could not be locked, with a short code; run it again to finish. */
  failures: Array<{ name: string; code: string }>;
  /** Members, across the CCAs locked now, the roster resolver could not match. */
  unresolved: number;
}

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
 * OPEN TRANSCRIPTS for a year: the CURRENT one only, still collecting. A past
 * year is refused (YEAR_ENDED) because its member lists have already changed in
 * August; a future one has not started. Locks every CCA's member list exactly
 * as it is now, one CCA at a time, each in its own transaction; a CCA an earlier run
 * already locked is locked AGAIN from its current list, replacing that lock and
 * its entries, because heads could still change the list and the records while
 * the year stayed collecting. If ANY CCA fails, the year stays collecting,
 * nothing is opened, and the failures are returned (and logged without any
 * message text or member ids). Once every CCA is locked the year becomes
 * published, with who opened it and when.
 */
export async function openTranscripts(
  db: PrismaClient,
  academicYear: string,
  actorUserID: string,
  now: Date = new Date(),
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

  let relocked = 0;
  let lockedNow = 0;
  let unresolved = 0;
  const failures: Array<{ name: string; code: string }> = [];
  // The CCAs THIS run locked. Locks from an earlier run do not count: every
  // CCA is locked again from its current list.
  const done = new Set<number>();

  // Lock every CCA. Run twice: the second pass, right before the year is
  // claimed, catches a CCA created while the first pass was running.
  for (let pass = 0; pass < 2; pass += 1) {
    const ccas = await db.cCA.findMany({
      select: { ccaID: true, ccaName: true },
    });
    const todo = ccas.filter((c) => !done.has(c.ccaID));
    failures.length = 0;
    for (const cca of todo) {
      try {
        const result = await freezeCca(db, {
          ccaID: cca.ccaID,
          academicYear,
          actorUserID,
          now,
        });
        done.add(cca.ccaID);
        lockedNow += 1;
        if (result.replaced) relocked += 1;
        unresolved += result.unresolvedCount;
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
          return {
            academicYear,
            lockedNow,
            relocked,
            failures: [],
            unresolved,
            opened: true,
          };
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
    // Some CCA could not be locked: stop here, the year stays collecting.
    if (failures.length > 0) break;
  }
  const counts = {
    academicYear,
    lockedNow,
    relocked,
    failures: [...failures],
    unresolved,
  };
  // Some CCA is still not locked: the year stays collecting, so running it
  // again locks every CCA again and a year is never half open.
  if (failures.length > 0) return { ...counts, opened: false };

  await claimYear(db, academicYear, actorUserID, now);
  return { ...counts, opened: true };
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
    await claimYearOnce(db, academicYear, actorUserID, now);
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
