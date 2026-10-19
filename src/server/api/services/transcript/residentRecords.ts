import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import {
  ONLY_UNLOCKED_RESIDENTS,
  decideWrite,
  type ResidentEventAction,
} from "~/lib/transcript/corrections";
import {
  normaliseYearStatus,
  type EditRefusal,
} from "~/lib/transcript/lifecycle";
import { accessFor } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import { editRefusalFor } from "./editRights";
import { retryYearConflicts } from "./yearRetry";
import { getPeriod, STATUS_COLLECTING } from "./periods";

/**
 * THE WRITE GUARD FOR RESIDENT-SPECIFIC RECORDS, and the history it feeds.
 *
 * `assertCanEditForResidents` is the one place a write that changes a known set
 * of residents asks "may this happen?". It allows what the ordinary edit guard
 * allows. In a PUBLISHED year it also lets a manager through when EVERY affected
 * resident has an ACTIVE unlock, and says so (`correction: true`) so the caller
 * logs a ResidentEvent. Heads never get that: the ordinary guard refuses them.
 *
 * The affected residents are always computed on the server from the diff a write
 * would make, never taken from what the client claims.
 */

/** Unlock and withhold rows are "active" until relockedAt / releasedAt is set. */
export const NOT_RELOCKED = {
  OR: [{ relockedAt: null }, { relockedAt: { isSet: false } }],
};
export const NOT_RELEASED = {
  OR: [{ releasedAt: null }, { releasedAt: { isSet: false } }],
};

const PUBLISHED_REFUSAL = "PERIOD_PUBLISHED" as const;

/** Residents (of `userIDs`) with an ACTIVE unlock for the year. */
export async function unlockedAmong(
  db: PrismaClient,
  academicYear: string,
  userIDs: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(userIDs)];
  if (unique.length === 0) return new Set();
  const rows = await db.residentUnlock.findMany({
    where: { academicYear, userID: { in: unique }, ...NOT_RELOCKED },
    select: { userID: true },
  });
  return new Set(rows.map((r) => r.userID));
}

export interface ResidentWriteScope {
  /** The CCA the write belongs to; omitted for awards and JCRC pages. */
  ccaID?: number;
  academicYear: string;
  /** Canonical keys of every resident whose records the write changes. */
  affectedUserIDs: readonly string[];
}

/**
 * Throws the refusal, or returns whether the write is a CORRECTION (allowed only
 * because every affected resident is unlocked in a published year).
 */
export async function assertCanEditForResidents(
  db: PrismaClient,
  actor: { userID: string },
  scope: ResidentWriteScope,
): Promise<{ correction: boolean }> {
  const [roles, period] = await Promise.all([
    getUserRoles(db, actor.userID),
    getPeriod(db, scope.academicYear),
  ]);
  const isManager = accessFor("manager", roles);
  const status = normaliseYearStatus(period?.status);

  let ordinary: EditRefusal | null;
  if (scope.ccaID !== undefined) {
    ordinary = await editRefusalFor(
      db,
      actor.userID,
      scope.ccaID,
      scope.academicYear,
    );
  } else {
    // No CCA: awards and JCRC pages, which only managers write.
    if (!isManager) {
      throw new TRPCError({ code: "FORBIDDEN", message: "INSUFFICIENT_ROLE" });
    }
    ordinary = status === "published" ? PUBLISHED_REFUSAL : null;
  }

  const decision = decideWrite({
    ordinary,
    isManager,
    status,
    affected: scope.affectedUserIDs,
    unlocked:
      status === "published" && isManager
        ? await unlockedAmong(db, scope.academicYear, scope.affectedUserIDs)
        : new Set(),
  });
  if (decision.allow) return { correction: decision.correction };

  if (decision.refusal === ONLY_UNLOCKED_RESIDENTS) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: ONLY_UNLOCKED_RESIDENTS,
    });
  }
  throw new TRPCError({
    code:
      decision.refusal === PUBLISHED_REFUSAL
        ? "PRECONDITION_FAILED"
        : "FORBIDDEN",
    message: decision.refusal,
  });
}

/**
 * The guard result of a write only `assertCanEditCcaYear` admits (activities,
 * volunteer activities and sessions): never a correction.
 */
export const ORDINARY_WRITE = { correction: false } as const;

/**
 * The same question again, INSIDE the write's transaction: an ordinary write
 * (not a correction) needs the year still collecting. The guard above runs
 * before the transaction, so a head's save in flight while the JCRC presses
 * Open transcripts could otherwise land after the year opened.
 *
 * Two halves (S2, then T1 of the re-review):
 *  - HERE, the first statement of the body, a READ: refuse at once when the
 *    year is open. It also starts the transaction's snapshot.
 *  - At the END of the transaction, a WRITE (`touchYear`, run by `yearWrite`
 *    after the body): a fresh `lastWriteID` on the year's period row. A read
 *    alone does not conflict with Open claiming the year, so a write that read
 *    "collecting" could commit just after the claim. The final write does: a
 *    claim committed after the snapshot makes it lose a write conflict (MongoDB
 *    detects conflicts against the snapshot), so the write runs again, reads the
 *    year open and refuses; a claim that comes while the touch is uncommitted
 *    waits for the commit. Writing the row LAST holds it for the few
 *    milliseconds before the commit, not for the whole save, so one long save
 *    no longer makes every other save of the year fail.
 * A correction is for an open year already, so it is checked by neither half.
 * It must run inside `yearWrite`: anywhere else nothing would write the row.
 */
export async function assertStillCollecting(
  tx: Pick<PrismaClient, "transcriptPeriod">,
  academicYear: string,
  guard: { correction: boolean },
  now: Date = new Date(),
): Promise<void> {
  if (guard.correction) return;
  const pending = pendingTouches.get(tx);
  if (!pending) {
    throw new Error("YEAR_WRITE_REQUIRED: the year check runs in yearWrite");
  }
  const period = await tx.transcriptPeriod.findUnique({
    where: { academicYear },
    select: { status: true },
  });
  if (normaliseYearStatus(period?.status) === "published") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: PUBLISHED_REFUSAL,
    });
  }
  if (!pending.has(academicYear)) pending.set(academicYear, now);
}

/**
 * The years each open `yearWrite` transaction checked, to touch when its body
 * is done (with the time of the check, for "is this the current year").
 */
const pendingTouches = new WeakMap<object, Map<string, Date>>();

/**
 * The write half of the year check, the LAST statement of every year-scoped
 * write transaction (see assertStillCollecting): a fresh `lastWriteID` on the
 * year's period row. Still refuses when the row is published. The row is
 * created as "collecting" when missing, for the CURRENT year only: only the
 * current year can be opened, and a row for any other year would add it to the
 * admin year lists.
 */
export async function touchYear(
  tx: Pick<PrismaClient, "transcriptPeriod">,
  academicYear: string,
  guard: { correction: boolean },
  now: Date = new Date(),
): Promise<void> {
  if (guard.correction) return;
  const lastWriteID = randomUUID();
  const touched = await tx.transcriptPeriod.updateMany({
    where: { academicYear },
    data: { lastWriteID },
  });
  if (touched.count === 0) {
    // No row: the year was never opened. Only the current year can be.
    if (academicYear !== currentAcademicYear(now)) return;
    try {
      await tx.transcriptPeriod.create({
        data: { academicYear, status: STATUS_COLLECTING, lastWriteID },
      });
    } catch (error) {
      // Created at the same moment (by Open, or another write): run again.
      if ((error as { code?: unknown }).code === "P2002") {
        throw retryableRace(error);
      }
      throw error;
    }
    return;
  }
  const period = await tx.transcriptPeriod.findUnique({
    where: { academicYear },
    select: { status: true },
  });
  if (normaliseYearStatus(period?.status) === "published") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: PUBLISHED_REFUSAL,
    });
  }
}

/** A race lost to a write at the same moment, retried like a write conflict. */
export function retryableRace(cause: unknown): Error {
  return Object.assign(
    new Error("YEAR_ROW_RACE: the year's row was created meanwhile"),
    { errorLabels: ["TransientTransactionError"], cause },
  );
}

/**
 * ONE try of a year-scoped write: the body in a transaction, then the period
 * row of every year the body checked (`assertStillCollecting`) is touched, as
 * the transaction's last statements. Use `yearWrite`, which retries it.
 */
export function yearTransaction<T>(
  db: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return db.$transaction(async (tx) => {
    const pending = new Map<string, Date>();
    pendingTouches.set(tx, pending);
    const result = await body(tx);
    for (const [academicYear, at] of pending) {
      await touchYear(tx, academicYear, ORDINARY_WRITE, at);
    }
    return result;
  }, options);
}

/**
 * The transaction of a year-scoped write that calls `assertStillCollecting`,
 * run again from the start when it loses a write conflict: every such write
 * ends by touching the year's period row, so two saves whose transactions
 * overlap conflict there (and with Open transcripts), and the loser is retried
 * transparently, with exponential, jittered waits inside a total budget of
 * about 5 s (`retryYearConflicts`). When that runs out the save fails with
 * CONFLICT "RECORDS_BUSY". The body must re-read what it depends on: a retry
 * starts afresh.
 */
export function yearWrite<T>(
  db: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number },
): Promise<T> {
  return retryYearConflicts(() => yearTransaction(db, body, options));
}

/* ---- the history ---------------------------------------------------------- */

export interface ResidentEventInput {
  academicYear: string;
  userID: string;
  action: ResidentEventAction;
  reason?: string | null;
  summary?: string | null;
  actor: string;
  at?: Date;
}

/** One line in a resident's year history. */
export function recordResidentEvent(
  db: Pick<PrismaClient, "residentEvent">,
  input: ResidentEventInput,
) {
  return db.residentEvent.create({
    data: {
      academicYear: input.academicYear,
      userID: input.userID,
      action: input.action,
      reason: input.reason ?? null,
      summary: input.summary ?? null,
      actor: input.actor,
      at: input.at ?? new Date(),
    },
  });
}

/**
 * Log what a guarded write did to residents' records, one line per resident:
 *  - a CORRECTION (a published year, the resident unlocked): every resident;
 *  - otherwise only a SELF-MADE change, the actor changing their own records
 *    (a JCRC member giving themself an award while the year is collecting, a
 *    head setting their own role), so it shows in that resident's history in
 *    every year status, flagged as self-made. Self-actions are allowed, never
 *    hidden.
 * An ordinary change to someone else's records while collecting is not logged.
 */
export async function logCorrections(
  db: Pick<PrismaClient, "residentEvent">,
  guard: { correction: boolean },
  actorUserID: string,
  academicYear: string,
  entries: ReadonlyArray<{ userID: string; summary: string }>,
  now: Date = new Date(),
): Promise<void> {
  for (const entry of entries) {
    if (!guard.correction && entry.userID !== actorUserID) continue;
    await recordResidentEvent(db, {
      academicYear,
      userID: entry.userID,
      action: guard.correction ? "correction" : "change",
      summary: entry.summary,
      actor: actorUserID,
      at: now,
    });
  }
}
