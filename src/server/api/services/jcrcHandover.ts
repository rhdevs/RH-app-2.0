import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { applyRoleChange, writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import { activeHolderWhere } from "~/server/api/services/jcrcPositions";
import {
  ADMIN_ROLE,
  holdsStaffRole,
  isGrantableRole,
  JCRC_ROLE,
  type GrantableRole,
} from "~/server/api/services/roles";

/**
 * JCRC SELF-HANDOVER (HOTO).
 *
 * An outgoing JCRC member hands over positions THEY HOLD to one or more
 * successors. Successors get `jcrc` and the positions at once; the outgoing
 * member keeps them until a step-out date they pick, then loses the positions
 * and, if those were their last, `jcrc` too.
 *
 * D-3 RELAXED, ON THIS PATH ONLY. The generic role path still refuses a jcrc
 * granting jcrc (ASSIGNABLE_BY.jcrc stays []). This dedicated path may, and
 * only in the one shape it exists for: the caller must hold `jcrc` and every
 * position being handed over, and the only role it ever adds is `jcrc`. It
 * goes through applyRoleChange, so the exclusion pair, the compare-and-set and
 * the audit row all still apply. RFs and Hall Office keep appointing and
 * removing JCRC directly from the staff page.
 *
 * WHAT STOPS THIS FROM MINTING JCRC. Holding a position is the only gate, so
 * holding must not be something a member can give themselves, or repeat:
 *  - a holder row the caller assigned to themselves never qualifies (and
 *    addHolder refuses self-assignment for anyone but an admin);
 *  - each holder row hands over ONCE (`handedOverAt`). Cancelling the step-out
 *    keeps the position but not a second handover; someone else has to assign
 *    the position again first.
 * Every grant is still audited as `jcrc.handover`.
 *
 * SUCCESSORS MUST HAVE SIGNED IN. A pending grant is redeemed against the
 * granter's own assignable roles, and a jcrc may assign none, so a queued
 * `jcrc` would be refused at the successor's first login. Rather than widen
 * redemption, the handover asks the successor to sign in once first.
 */

const HANDOVER_REASON_MAX = 500;

export type HandoverInput = {
  actorUserID: string;
  positionIDs: readonly string[];
  successorIDs: readonly string[];
  stepOutAt: Date;
  reason?: string;
};

export type HandoverResult = {
  /** Successors who now hold `jcrc`. */
  granted: string[];
  /** When the outgoing member's `jcrc` ends, or null if they keep it. */
  termEndsAt: Date | null;
};

const refuse = (message: string): never => {
  throw new TRPCError({ code: "FORBIDDEN", message });
};

function storedRoles(
  row: { roles: string[]; role: string | null } | null,
): string[] {
  if (row?.roles?.length) return row.roles;
  return row?.role ? [row.role] : [];
}

type SuccessorPlan = {
  userID: string;
  stored: string[];
};

async function planSuccessors(
  db: PrismaClient,
  actorUserID: string,
  successorIDs: readonly string[],
): Promise<SuccessorPlan[]> {
  const ids = [...new Set(successorIDs)];
  if (ids.length === 0) refuse("NO_SUCCESSOR");
  if (ids.includes(actorUserID)) refuse("SUCCESSOR_IS_YOU");
  const rows = await db.userRole.findMany({
    where: { userID: { in: ids } },
    select: { userID: true, roles: true, role: true },
  });
  // Every check runs before anything is written, so a refusal writes nothing.
  return ids.map((userID) => {
    const row = rows.find((r) => r.userID === userID);
    if (!row) refuse("SUCCESSOR_NOT_SIGNED_IN");
    const stored = storedRoles(row!);
    if (holdsStaffRole(stored)) refuse("SUCCESSOR_IS_STAFF");
    return { userID, stored };
  });
}

async function grantJcrc(
  db: PrismaClient,
  actorUserID: string,
  actorRoles: string[],
  plan: SuccessorPlan,
  reason: string,
): Promise<void> {
  if (!plan.stored.includes(ADMIN_ROLE) && !plan.stored.includes(JCRC_ROLE)) {
    const before = plan.stored.filter(isGrantableRole);
    await applyRoleChange({
      db,
      actorUserID,
      actorRoles,
      targetUserID: plan.userID,
      before,
      after: [...before, JCRC_ROLE],
      added: [JCRC_ROLE],
      removed: [],
      reason,
    });
  }
  // A successor taking on a position starts a fresh term. Cleared only once
  // the grant has landed, so a failed grant leaves an existing term alone.
  await db.jcrcTerm.deleteMany({ where: { userID: plan.userID } });
}

/**
 * The latest end date across a user's holder rows, or null if any is open (or
 * they hold none). Reads ended-but-unswept rows too, so a step-out of "now"
 * still yields a term end.
 */
async function termEndFor(
  db: PrismaClient,
  userID: string,
): Promise<Date | null> {
  const rows = await db.jcrcPositionHolder.findMany({
    where: { userID },
    select: { endsAt: true },
  });
  if (rows.some((r) => r.endsAt === null)) return null;
  const ends = rows.map((r) => r.endsAt!.getTime());
  return ends.length === 0 ? null : new Date(Math.max(...ends));
}

export async function handOverPositions(
  db: PrismaClient,
  input: HandoverInput,
  now: Date = new Date(),
): Promise<HandoverResult> {
  const { actorUserID } = input;
  const actorRoles = await getUserRoles(db, actorUserID); // I-5 live read
  if (!actorRoles.includes(JCRC_ROLE)) refuse("NOT_JCRC");

  const positionIDs = [...new Set(input.positionIDs)];
  if (positionIDs.length === 0) refuse("NO_POSITION");
  const held = await db.jcrcPositionHolder.findMany({
    where: {
      userID: actorUserID,
      positionID: { in: positionIDs },
      ...activeHolderWhere(now),
    },
    select: { positionID: true, assignedBy: true, handedOverAt: true },
  });
  if (held.length !== positionIDs.length) refuse("NOT_YOUR_POSITION");
  if (held.some((h) => h.assignedBy === actorUserID)) {
    refuse("SELF_ASSIGNED_POSITION");
  }
  if (held.some((h) => h.handedOverAt != null)) refuse("ALREADY_HANDED_OVER");

  const positions = await db.jcrcPosition.findMany({
    where: { id: { in: positionIDs } },
    select: { name: true },
  });
  const stepOutAt =
    input.stepOutAt.getTime() < now.getTime() ? now : input.stepOutAt;
  const reason = [
    `Handover of ${positions.map((p) => p.name).join(", ")}`,
    `step-out ${stepOutAt.toISOString()}`,
    input.reason,
  ]
    .filter(Boolean)
    .join("; ")
    .slice(0, HANDOVER_REASON_MAX);

  const plans = await planSuccessors(db, actorUserID, input.successorIDs);

  // NOT ATOMIC: successors are granted one by one. A failure part-way leaves
  // the earlier successors granted and the caller's own rows untouched, and a
  // retry is safe (every write here is an idempotent upsert or a no-op).
  const granted: string[] = [];
  for (const plan of plans) {
    await grantJcrc(db, actorUserID, actorRoles, plan, reason);
    granted.push(plan.userID);
    for (const positionID of positionIDs) {
      await db.jcrcPositionHolder.upsert({
        where: { positionID_userID: { positionID, userID: plan.userID } },
        create: {
          positionID,
          userID: plan.userID,
          assignedBy: actorUserID,
          endsAt: null,
        },
        update: {
          endsAt: null,
          handedOverAt: null,
          assignedBy: actorUserID,
          assignedAt: now,
        },
      });
    }
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID: plan.userID,
      action: "jcrc.handover",
      reason,
    });
  }

  await db.jcrcPositionHolder.updateMany({
    where: { userID: actorUserID, positionID: { in: positionIDs } },
    data: { endsAt: stepOutAt, handedOverAt: now },
  });
  const termEndsAt = await termEndFor(db, actorUserID);
  if (termEndsAt) {
    await db.jcrcTerm.upsert({
      where: { userID: actorUserID },
      create: { userID: actorUserID, endsAt: termEndsAt },
      update: { endsAt: termEndsAt, setAt: now },
    });
  }
  if (stepOutAt.getTime() <= now.getTime()) await sweepEndedJcrcTerms(db, now);
  return { granted, termEndsAt };
}

/**
 * Move or cancel the caller's own step-out date. `null` cancels it: they keep
 * their handed-over positions (alongside the successors) and `jcrc`.
 */
export async function setStepOut(
  db: PrismaClient,
  actorUserID: string,
  stepOutAt: Date | null,
  now: Date = new Date(),
): Promise<{ termEndsAt: Date | null }> {
  const pendingRows = { userID: actorUserID, endsAt: { gt: now } };
  const count = await db.jcrcPositionHolder.count({ where: pendingRows });
  if (count === 0) refuse("NO_STEP_OUT_PENDING");
  const endsAt =
    stepOutAt && stepOutAt.getTime() < now.getTime() ? now : stepOutAt;
  await db.jcrcPositionHolder.updateMany({
    where: pendingRows,
    data: { endsAt },
  });
  const termEndsAt = await termEndFor(db, actorUserID);
  if (termEndsAt) {
    await db.jcrcTerm.upsert({
      where: { userID: actorUserID },
      create: { userID: actorUserID, endsAt: termEndsAt },
      update: { endsAt: termEndsAt, setAt: now },
    });
  } else {
    await db.jcrcTerm.deleteMany({ where: { userID: actorUserID } });
  }
  if (endsAt && endsAt.getTime() <= now.getTime()) {
    await sweepEndedJcrcTerms(db, now);
  }
  return { termEndsAt };
}

/**
 * Finish every handover whose step-out date has passed: drop the ended holder
 * rows and remove `jcrc` from members whose term ended, with the usual audit
 * row. There is no cron in this app, so this runs lazily from the positions
 * surface; until it runs, getUserRoles already treats `jcrc` as gone.
 *
 * Idempotent and safe to run concurrently: a lost compare-and-set leaves the
 * term in place for the next sweep.
 */
export async function sweepEndedJcrcTerms(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ ended: number }> {
  // `not: null` is load-bearing: Prisma's Mongo connector matches a stored
  // null on `lte`, which would delete every open-ended holder.
  await db.jcrcPositionHolder.deleteMany({
    where: { endsAt: { lte: now, not: null } },
  });
  const due = await db.jcrcTerm.findMany({ where: { endsAt: { lte: now } } });
  let ended = 0;
  for (const term of due) {
    const row = await db.userRole.findUnique({
      where: { userID: term.userID },
      select: { roles: true, role: true },
    });
    const before = storedRoles(row).filter(isGrantableRole);
    if (before.includes(JCRC_ROLE)) {
      // One bad term must not fail the sweep, which runs on a read: log it,
      // leave it for the next sweep, and carry on.
      try {
        await applyRoleChange({
          db,
          actorUserID: term.userID,
          actorRoles: before,
          targetUserID: term.userID,
          before,
          after: before.filter((r): r is GrantableRole => r !== JCRC_ROLE),
          added: [],
          removed: [JCRC_ROLE],
          reason: "JCRC handover: step-out date reached",
        });
      } catch (err) {
        if (!(err instanceof TRPCError && err.code === "CONFLICT")) {
          console.error(
            JSON.stringify({
              evt: "jcrc_term_sweep_failed",
              userID: term.userID,
              // The name only: a driver message can carry stored values.
              error: err instanceof Error ? err.name : typeof err,
            }),
          );
        }
        continue;
      }
      ended += 1;
    }
    await db.jcrcTerm.deleteMany({
      where: { userID: term.userID, endsAt: { lte: now } },
    });
  }
  return { ended };
}
