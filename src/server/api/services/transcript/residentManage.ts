import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";
import { residentStateOf } from "~/lib/transcript/corrections";
import { normaliseYearStatus } from "~/lib/transcript/lifecycle";
import { retryWriteConflicts } from "~/lib/transcript/writeConflict";
import type {
  historyInput,
  relockInput,
  releaseInput,
  residentScope,
  unlockInput,
  withholdInput,
} from "~/lib/transcript/residentInput";
import { JCRC_ROLE } from "~/lib/roleNames";
import { getUserRoles } from "~/server/api/services/access";
import { getPeriod } from "./periods";
import {
  NOT_RELEASED,
  NOT_RELOCKED,
  recordResidentEvent,
} from "./residentRecords";
import { actorLabels, lookupResidents, requireResident } from "./residents";

/**
 * ONE RESIDENT'S YEAR, as a manager sees it: whether it is unlocked for
 * corrections, whether it is withheld from the resident, and the history of
 * both. Nothing here is ever deleted: relocking and releasing set a timestamp,
 * and every change adds a ResidentEvent.
 *
 * Who may call these (admin or jcrc) is decided by the router; the resident is
 * always resolved to their canonical key first, so a record is filed under one
 * key however the client names them.
 */

const fail = (
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED",
  message: string,
) => new TRPCError({ code, message });

type Scope = z.infer<typeof residentScope>;

/* ---- reading the two switches ------------------------------------------------ */

export const activeUnlock = (
  db: PrismaClient,
  academicYear: string,
  userID: string,
) =>
  db.residentUnlock.findFirst({
    where: { academicYear, userID, ...NOT_RELOCKED },
    orderBy: { unlockedAt: "desc" },
  });

export const activeWithhold = (
  db: PrismaClient,
  academicYear: string,
  userID: string,
) =>
  db.residentWithhold.findFirst({
    where: { academicYear, userID, ...NOT_RELEASED },
    orderBy: { withheldAt: "desc" },
  });

/** Is this resident's year on hold? `userID` is their canonical key. */
export async function isWithheld(
  db: PrismaClient,
  academicYear: string,
  userID: string,
): Promise<boolean> {
  return (
    (await db.residentWithhold.count({
      where: { academicYear, userID, ...NOT_RELEASED },
    })) > 0
  );
}

/* ---- the panel's status ------------------------------------------------------- */

export interface ResidentPanel {
  userID: string;
  displayName: string | null;
  academicYear: string;
  status: "collecting" | "closed" | "published";
  /** What the resident would see: draft, published, or nothing yet. */
  state: "collecting" | "draft" | "published";
  withheld: boolean;
  unlocked: boolean;
  isJcrcMember: boolean;
  unlock: {
    reason: string;
    byName: string | null;
    at: Date | null;
  } | null;
  withhold: {
    reason: string;
    byName: string | null;
    at: Date | null;
  } | null;
}

export async function residentPanel(
  db: PrismaClient,
  input: Scope,
): Promise<ResidentPanel> {
  const resident = await requireResident(db, input.userID);
  const [period, unlock, withhold, roles, jcrcRecord] = await Promise.all([
    getPeriod(db, input.academicYear),
    activeUnlock(db, input.academicYear, resident.key),
    activeWithhold(db, input.academicYear, resident.key),
    getUserRoles(db, resident.key),
    db.jcrcService.count({
      where: { academicYear: input.academicYear, userID: resident.key },
    }),
  ]);
  const label = await actorLabels(db, [
    unlock?.unlockedBy,
    withhold?.withheldBy,
  ]);
  const status = normaliseYearStatus(period?.status);
  return {
    userID: resident.key,
    displayName: resident.displayName,
    academicYear: input.academicYear,
    status,
    state: residentStateOf(status),
    withheld: withhold !== null,
    unlocked: unlock !== null,
    // A JCRC member by role, or anyone who already has a page on file.
    isJcrcMember: roles.includes(JCRC_ROLE) || jcrcRecord > 0,
    unlock: unlock
      ? {
          reason: unlock.reason,
          byName: label(unlock.unlockedBy),
          at: unlock.unlockedAt ?? null,
        }
      : null,
    withhold: withhold
      ? {
          reason: withhold.reason,
          byName: label(withhold.withheldBy),
          at: withhold.withheldAt ?? null,
        }
      : null,
  };
}

/* ---- unlock / relock ---------------------------------------------------------- */

const isDuplicateKey = (error: unknown) =>
  (error as { code?: string }).code === "P2002";

/** "<year>|<userID>" while a row is active; unique, so at most one is. */
const activeKeyOf = (academicYear: string, userID: string) =>
  `${academicYear}|${userID}`;

/** The key an ended row is rewritten to, so a new one can take the active key. */
const endedKeyOf = (academicYear: string, userID: string, id: string) =>
  `${academicYear}|${userID}|ended|${id}`;

/**
 * Unlock ONE resident's records so a manager can correct them while the year is
 * in review or published. Needs a reason. At most one unlock is active at a
 * time, kept by a unique key, so asking again (or twice at once) leaves the one
 * unlock and one history line.
 */
export async function unlockResident(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof unlockInput>,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  const period = await getPeriod(db, input.academicYear);
  if (normaliseYearStatus(period?.status) === "collecting") {
    throw fail("PRECONDITION_FAILED", "YEAR_NOT_IN_REVIEW");
  }
  // Each try re-reads first: a call that lost a write conflict to another
  // unlock at the same moment finds that unlock and stops there.
  await retryWriteConflicts(async () => {
    if (await activeUnlock(db, input.academicYear, resident.key)) return;
    try {
      await db.$transaction(async (tx) => {
        await tx.residentUnlock.create({
          data: {
            academicYear: input.academicYear,
            userID: resident.key,
            reason: input.reason,
            activeKey: activeKeyOf(input.academicYear, resident.key),
            unlockedBy: actorUserID,
            unlockedAt: now,
          },
        });
        await recordResidentEvent(tx, {
          academicYear: input.academicYear,
          userID: resident.key,
          action: "unlock",
          reason: input.reason,
          actor: actorUserID,
          at: now,
        });
      });
    } catch (error) {
      // Someone unlocked this resident at the same moment: that unlock stands.
      if (!isDuplicateKey(error)) throw error;
    }
  });
  return { userID: resident.key };
}

/** Close the active unlock; the resident's records are read-only again. */
export async function relockResident(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof relockInput>,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  const active = await activeUnlock(db, input.academicYear, resident.key);
  if (!active) throw fail("CONFLICT", "NOT_UNLOCKED");
  // A retry re-runs the claim: if another relock won, it claims nothing.
  await retryWriteConflicts(() =>
    db.$transaction(async (tx) => {
      // Claim it: of two relocks at once, only one ends it and logs it.
      const claimed = await tx.residentUnlock.updateMany({
        where: { id: active.id, ...NOT_RELOCKED },
        data: {
          relockedAt: now,
          relockedBy: actorUserID,
          activeKey: endedKeyOf(input.academicYear, resident.key, active.id),
        },
      });
      if (claimed.count !== 1) return;
      await recordResidentEvent(tx, {
        academicYear: input.academicYear,
        userID: resident.key,
        action: "relock",
        reason: input.note ? input.note : null,
        actor: actorUserID,
        at: now,
      });
    }),
  );
  return { userID: resident.key };
}

/* ---- withhold / release -------------------------------------------------------- */

/** Put ONE resident's transcript on hold for the year. Needs a reason. */
export async function withholdResident(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof withholdInput>,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  // As for unlock: re-read on every try, so a lost conflict ends quietly.
  await retryWriteConflicts(async () => {
    if (await activeWithhold(db, input.academicYear, resident.key)) return;
    try {
      await db.$transaction(async (tx) => {
        await tx.residentWithhold.create({
          data: {
            academicYear: input.academicYear,
            userID: resident.key,
            reason: input.reason,
            activeKey: activeKeyOf(input.academicYear, resident.key),
            withheldBy: actorUserID,
            withheldAt: now,
          },
        });
        await recordResidentEvent(tx, {
          academicYear: input.academicYear,
          userID: resident.key,
          action: "withhold",
          reason: input.reason,
          actor: actorUserID,
          at: now,
        });
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  });
  return { userID: resident.key };
}

/** Lift the hold. The resident sees their transcript again. */
export async function releaseResident(
  db: PrismaClient,
  actorUserID: string,
  input: z.infer<typeof releaseInput>,
  now: Date = new Date(),
) {
  const resident = await requireResident(db, input.userID);
  const active = await activeWithhold(db, input.academicYear, resident.key);
  if (!active) throw fail("CONFLICT", "NOT_WITHHELD");
  await retryWriteConflicts(() =>
    db.$transaction(async (tx) => {
      const claimed = await tx.residentWithhold.updateMany({
        where: { id: active.id, ...NOT_RELEASED },
        data: {
          releasedAt: now,
          releasedBy: actorUserID,
          releaseNote: input.note ? input.note : null,
          activeKey: endedKeyOf(input.academicYear, resident.key, active.id),
        },
      });
      if (claimed.count !== 1) return;
      await recordResidentEvent(tx, {
        academicYear: input.academicYear,
        userID: resident.key,
        action: "release",
        reason: input.note ? input.note : null,
        actor: actorUserID,
        at: now,
      });
    }),
  );
  return { userID: resident.key };
}

/* ---- history ---------------------------------------------------------------------- */

export interface ResidentHistoryEntry {
  id: string;
  action: string;
  reason: string | null;
  summary: string | null;
  byName: string | null;
  at: Date | null;
}

/** Every event for this resident and year, newest first, with who did it by name. */
export async function residentHistory(
  db: PrismaClient,
  input: z.infer<typeof historyInput>,
): Promise<ResidentHistoryEntry[]> {
  const resident = await requireResident(db, input.userID);
  const rows = await db.residentEvent.findMany({
    where: { academicYear: input.academicYear, userID: resident.key },
    orderBy: [{ at: "desc" }, { id: "desc" }],
  });
  const names = await lookupResidents(
    db,
    rows.flatMap((r) => (r.actor ? [r.actor] : [])),
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    reason: r.reason ?? null,
    summary: r.summary ?? null,
    byName: r.actor
      ? (names.get(r.actor)?.displayName?.trim() ?? r.actor)
      : null,
    at: r.at ?? null,
  }));
}
