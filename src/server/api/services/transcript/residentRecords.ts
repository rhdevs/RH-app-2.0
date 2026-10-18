import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
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
import { getPeriod } from "./periods";

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
