import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { applyRoleChange, writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import {
  POSITION_AUDIT,
  assertNoListedCcaHead,
  auditFlaggedChange,
  flaggedPositionsAmong,
} from "~/server/api/services/jcrcPositionLock";
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
 *  - only a row assigned by staff (an RF or Hall Office) or an admin hands
 *    over. A row a handover created was assigned by the outgoing member, so a
 *    successor cannot pass the position straight on: staff assign it to them
 *    first. Without this, every successor could hand over to more successors;
 *  - each holder row hands over ONCE (`handedOverAt`), claimed with a
 *    conditional write so two concurrent handovers cannot both pass;
 *  - after a handover the step-out can only move EARLIER. Cancelling it, or
 *    pushing it back again and again, would keep `jcrc` for the outgoing
 *    member on top of the successors'. Staff re-assigning the position is
 *    how a mistaken handover is undone.
 * Every grant is still audited as `jcrc.handover`.
 *
 * A FLAGGED POSITION (a director position) IS HANDED OVER TO EXACTLY ONE
 * SUCCESSOR, WITH NO CHAINS. The holder list of a flagged position is what an
 * admin confirmed, so a handover may replace one holder with one successor and
 * nothing more:
 *  - one successor, who must not head a CCA the position lists;
 *  - the successor's row is marked (`handoverFrom`) and cannot be handed over
 *    again until an admin, RF or Hall Office assigns the person again, which
 *    clears the mark (a clearer refusal than the staff-assigned rule above,
 *    which would also stop it);
 *  - once a row is handed over, the outgoing holder cannot cancel the step-out
 *    or push it later (setStepOut refuses with STEP_OUT_LOCKED here, where an
 *    unflagged position says STEP_OUT_ONLY_EARLIER), or they would stay a
 *    director beside the successor;
 *  - the successor's row writes the same audit row as any other holder added
 *    to a flagged position.
 * A position with no flag keeps the rules above.
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
 * Only a row assigned by staff or an admin hands over. Read live (I-5): an RF
 * who has since left no longer vouches for the rows they assigned.
 */
async function assertStaffAssigned(
  db: PrismaClient,
  held: readonly { assignedBy: string }[],
): Promise<void> {
  const assigners = [...new Set(held.map((h) => h.assignedBy))];
  for (const assigner of assigners) {
    const roles = await getUserRoles(db, assigner);
    if (!roles.includes(ADMIN_ROLE) && !holdsStaffRole(roles)) {
      refuse("POSITION_NOT_STAFF_ASSIGNED");
    }
  }
}

/**
 * Marks the caller's rows handed over, with their step-out date, BEFORE any
 * grant, and only rows not yet handed over, so of two concurrent handovers of
 * the same row one is refused.
 *
 * ONE ROW AT A TIME, so each call knows exactly which rows it claimed and
 * releases only those. Two calls in the same millisecond share a timestamp,
 * so releasing "rows claimed at `now`" could release the other call's claim.
 */
async function claimRows(
  db: PrismaClient,
  actorUserID: string,
  positionIDs: readonly string[],
  stepOutAt: Date,
  now: Date,
): Promise<void> {
  const claimed: string[] = [];
  try {
    for (const positionID of positionIDs) {
      const { count } = await db.jcrcPositionHolder.updateMany({
        where: {
          userID: actorUserID,
          positionID,
          // A row addHolder created has no handedOverAt at all, and on Mongo
          // `null` alone does not match a missing field.
          OR: [{ handedOverAt: null }, { handedOverAt: { isSet: false } }],
        },
        data: { handedOverAt: now, endsAt: stepOutAt },
      });
      if (count === 0) refuse("ALREADY_HANDED_OVER");
      claimed.push(positionID);
    }
  } catch (err) {
    await releaseClaim(db, actorUserID, claimed, now);
    throw err;
  }
}

/**
 * Undoes claimRows for rows this call claimed, then brings the term back in
 * line. The rows were open before the claim (activeHolderWhere plus the
 * handedOverAt check), so they reopen. Never throws: it runs while another
 * error is on its way out, and a failure is logged rather than masking it.
 */
async function releaseClaim(
  db: PrismaClient,
  actorUserID: string,
  claimedIDs: readonly string[],
  now: Date,
): Promise<void> {
  if (claimedIDs.length === 0) return;
  try {
    await db.jcrcPositionHolder.updateMany({
      where: {
        userID: actorUserID,
        positionID: { in: [...claimedIDs] },
        handedOverAt: now,
      },
      data: { handedOverAt: null, endsAt: null },
    });
    await syncTerm(db, actorUserID, now);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "jcrc_handover_release_failed",
        userID: actorUserID,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
}

/**
 * Record the member's term end from their holder rows, or clear it once they
 * hold a position with no end again.
 *
 * NEVER CLEARED WHEN THEY HOLD NO ROWS. A sweep can delete rows that have
 * just ended (a step-out of now) between a write and this read; the term is
 * then the only thing left that ends `jcrc`, so it stays.
 */
async function syncTerm(
  db: PrismaClient,
  userID: string,
  now: Date,
): Promise<Date | null> {
  const rows = await db.jcrcPositionHolder.findMany({
    where: { userID },
    select: { endsAt: true },
  });
  if (rows.some((r) => r.endsAt === null)) {
    await db.jcrcTerm.deleteMany({ where: { userID } });
    return null;
  }
  if (rows.length === 0) {
    const term = await db.jcrcTerm.findUnique({ where: { userID } });
    return term?.endsAt ?? null;
  }
  const termEndsAt = new Date(
    Math.max(...rows.map((r) => r.endsAt!.getTime())),
  );
  await db.jcrcTerm.upsert({
    where: { userID },
    create: { userID, endsAt: termEndsAt },
    update: { endsAt: termEndsAt, setAt: now },
  });
  return termEndsAt;
}

async function giveSuccessorPositions(
  db: PrismaClient,
  actorUserID: string,
  successorID: string,
  positionIDs: readonly string[],
  now: Date,
  flaggedIDs: ReadonlySet<string>,
): Promise<void> {
  for (const positionID of positionIDs) {
    // The mark that stops a handed-on director position being handed on again
    // (only staff assigning the person again clears it).
    const viaHandover = flaggedIDs.has(positionID)
      ? { handoverFrom: actorUserID }
      : {};
    await db.jcrcPositionHolder.upsert({
      where: { positionID_userID: { positionID, userID: successorID } },
      create: {
        positionID,
        userID: successorID,
        assignedBy: actorUserID,
        endsAt: null,
        ...viaHandover,
      },
      update: {
        endsAt: null,
        handedOverAt: null,
        assignedBy: actorUserID,
        assignedAt: now,
        ...viaHandover,
      },
    });
  }
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
    select: {
      positionID: true,
      assignedBy: true,
      handedOverAt: true,
      handoverFrom: true,
    },
  });
  if (held.length !== positionIDs.length) refuse("NOT_YOUR_POSITION");
  if (held.some((h) => h.assignedBy === actorUserID)) {
    refuse("SELF_ASSIGNED_POSITION");
  }
  if (held.some((h) => h.handedOverAt != null)) refuse("ALREADY_HANDED_OVER");
  const flagged = await flaggedPositionsAmong(db, positionIDs);
  const flaggedIDs = new Set(flagged.map((p) => p.id));
  if (flagged.length > 0) {
    if (new Set(input.successorIDs).size > 1) refuse("ONE_SUCCESSOR_ONLY");
    if (held.some((h) => flaggedIDs.has(h.positionID) && h.handoverFrom)) {
      refuse("NEEDS_STAFF_CONFIRMATION");
    }
  }
  await assertStaffAssigned(db, held);

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
  if (flagged.length > 0) {
    await assertNoListedCcaHead(
      db,
      plans.map((p) => p.userID),
      flagged.map((p) => p.id),
    );
  }

  await claimRows(db, actorUserID, positionIDs, stepOutAt, now);
  // NOT ATOMIC: successors are granted one by one. A failure anywhere after
  // the claim leaves the earlier successors granted and releases the
  // caller's claim, so a retry is safe (every write here is an idempotent
  // upsert or a no-op).
  const granted: string[] = [];
  let termEndsAt: Date | null;
  try {
    // The term is recorded BEFORE any grant. With a step-out of now, a sweep
    // may delete the claimed rows at any moment from here on; the term is
    // what still ends `jcrc` once they are gone.
    termEndsAt = await syncTerm(db, actorUserID, now);
    for (const plan of plans) {
      await grantJcrc(db, actorUserID, actorRoles, plan, reason);
      granted.push(plan.userID);
      await giveSuccessorPositions(
        db,
        actorUserID,
        plan.userID,
        positionIDs,
        now,
        flaggedIDs,
      );
      for (const position of flagged) {
        await auditFlaggedChange(db, {
          actorUserID,
          actorRoles,
          action: POSITION_AUDIT.addHolder,
          position,
          targetUserID: plan.userID,
          detail: `holder added by handover from ${actorUserID}`,
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
  } catch (err) {
    await releaseClaim(db, actorUserID, positionIDs, now);
    throw err;
  }

  if (stepOutAt.getTime() <= now.getTime()) await sweepEndedJcrcTerms(db, now);
  return { granted, termEndsAt };
}

/**
 * Bring the caller's own step-out date forward. It cannot be cancelled or
 * moved later: either would let the outgoing member keep `jcrc` on top of the
 * successors' (see the header). Staff re-assigning the position undoes a
 * handover made by mistake.
 *
 * `null` (a cancel) is always refused. The refusal is STEP_OUT_LOCKED when a
 * pending row is on a flagged position and STEP_OUT_ONLY_EARLIER otherwise; a
 * later date is refused the same two ways. The router passes `null` through
 * rather than letting a date parser read it as the start of 1970, which would
 * be read as "step out now".
 */
export async function setStepOut(
  db: PrismaClient,
  actorUserID: string,
  stepOutAt: Date | null,
  now: Date = new Date(),
): Promise<{ termEndsAt: Date | null }> {
  const pendingRows = { userID: actorUserID, endsAt: { gt: now } };
  const pending = await db.jcrcPositionHolder.findMany({
    where: pendingRows,
    select: { positionID: true, endsAt: true },
  });
  if (pending.length === 0) refuse("NO_STEP_OUT_PENDING");
  const earliest = Math.min(...pending.map((r) => r.endsAt!.getTime()));
  if (stepOutAt === null || stepOutAt.getTime() > earliest) {
    const flaggedPending = await flaggedPositionsAmong(
      db,
      pending.map((r) => r.positionID),
    );
    return refuse(
      flaggedPending.length > 0 ? "STEP_OUT_LOCKED" : "STEP_OUT_ONLY_EARLIER",
    );
  }
  const endsAt = stepOutAt.getTime() < now.getTime() ? now : stepOutAt;
  await db.jcrcPositionHolder.updateMany({
    where: pendingRows,
    data: { endsAt },
  });
  const termEndsAt = await syncTerm(db, actorUserID, now);
  if (endsAt.getTime() <= now.getTime()) {
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
