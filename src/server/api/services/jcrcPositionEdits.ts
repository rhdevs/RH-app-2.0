import { TRPCError } from "@trpc/server";
import type { JcrcPosition, PrismaClient } from "@prisma/client";

import { getUserRoles } from "~/server/api/services/access";
import {
  ADMIN_ROLE,
  holdsStaffRole,
  JCRC_ROLE,
} from "~/server/api/services/roles";
import { activeHolderWhere } from "~/server/api/services/jcrcPositions";
import { isPositionVacant } from "~/server/api/services/directorGuard";
import {
  POSITION_AUDIT,
  assertMayEditFlaggedPosition,
  assertNoListedCcaHead,
  auditFlaggedChange,
  describeSnapshot,
  isFlaggedPosition,
  mayEditFlaggedPosition,
  nextUpdatedAt,
  positionTransaction,
  snapshotPosition,
  touchPosition,
} from "~/server/api/services/jcrcPositionLock";

/**
 * THE ONE CODE PATH for changing a position's name, CCA list and holders.
 *
 * Two doors lead here and they must behave identically, so neither has its own
 * copy: the Positions router (admins and JCRC members, any position) and the
 * staff router behind the /scrc panel (admins, RFs and Hall Office, FLAGGED
 * positions only). Everything that matters happens in here, inside the one
 * transaction per call that services/jcrcPositionLock.ts describes: the read
 * of the position, the lock check, the writes and the position-row write that
 * makes overlapping calls conflict. The audit row follows the commit.
 *
 * What the caller supplies is only WHO is acting (their live roles) and
 * whether this door is `flaggedOnly`. A flagged-only door refuses an unflagged
 * position (NOT_FLAGGED) from the row it reads inside the transaction, so the
 * staff route can never become a way round #119's rules for unflagged
 * positions. Whether the CALLER may use the door at all (a manager for the
 * Positions router; staff and the `scrc.enabled` switch for the staff router)
 * is the door's own check, made before it calls anything here.
 */

export const NOT_FLAGGED = "NOT_FLAGGED";

export type EditContext = {
  /** The acting user's id, from the session. */
  actor: string;
  /** Their roles, read live by the door. */
  actorRoles: readonly string[];
  /** Refuse any position that carries neither flag. */
  flaggedOnly: boolean;
};

type PositionRow = JcrcPosition;

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

function notFound(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "POSITION_NOT_FOUND" });
}

/**
 * For a flagged-only door: the position must exist and carry a flag. The row
 * is the one read inside the caller's transaction.
 */
function assertInScope(ctx: EditContext, row: PositionRow | null): void {
  if (!ctx.flaggedOnly) return;
  if (!row) throw notFound();
  if (!isFlaggedPosition(row)) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_FLAGGED });
  }
}

export const USE_DIRECTOR_PANEL = "USE_DIRECTOR_PANEL";

/**
 * The Positions router's holder calls are open to staff (they set who may hand
 * a position over), but a FLAGGED position is changed by staff only through the
 * staff door, which is `flaggedOnly` and has its own panel. Someone who is
 * staff and neither an admin nor a JCRC member is refused here; admins and
 * JCRC members are judged by the lock as before.
 */
function assertDoorFitsFlagged(
  ctx: EditContext,
  row: PositionRow | null,
): void {
  if (ctx.flaggedOnly || !row || !isFlaggedPosition(row)) return;
  const roles = ctx.actorRoles;
  if (!roles.includes(ADMIN_ROLE) && !roles.includes(JCRC_ROLE)) {
    throw new TRPCError({ code: "FORBIDDEN", message: USE_DIRECTOR_PANEL });
  }
}

/** The subset of `userIDs` who hold a staff role or admin right now. */
export async function staffOrAdmin(
  db: PrismaClient,
  userIDs: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(userIDs)];
  const roles = await Promise.all(unique.map((id) => getUserRoles(db, id)));
  return new Set(
    unique.filter(
      (_, i) => roles[i]!.includes(ADMIN_ROLE) || holdsStaffRole(roles[i]!),
    ),
  );
}

const isStaffOrAdmin = (roles: readonly string[]) =>
  roles.includes(ADMIN_ROLE) || holdsStaffRole([...roles]);

/**
 * What a JCRC member (not staff) may not do to holder rows. Staff decide who
 * may hand over, so a JCRC member cannot:
 *  - change or remove a row staff or an admin assigned: re-assigning it would
 *    strip its handover right, removing it is staff's call;
 *  - add someone who is stepping out, to any position: an open row cancels
 *    their step-out and keeps them on the JCRC beside their successors.
 * Staff re-assigning is how a mistaken handover is undone. (On a flagged
 * position a member never gets this far: the lock refuses them first.)
 */
async function assertJcrcMayChangeRow(
  db: PrismaClient,
  positionID: string,
  userID: string,
  adding: boolean,
): Promise<void> {
  if (adding) {
    const [steppingOut, term] = await Promise.all([
      db.jcrcPositionHolder.count({
        where: { userID, endsAt: { not: null } },
      }),
      db.jcrcTerm.findUnique({ where: { userID } }),
    ]);
    if (steppingOut > 0 || term) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "HOLDER_STEPPING_OUT",
      });
    }
  }
  const row = await db.jcrcPositionHolder.findFirst({
    where: { positionID, userID },
    select: { assignedBy: true },
  });
  if (row && (await staffOrAdmin(db, [row.assignedBy])).size > 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: "STAFF_ASSIGNED_ROW" });
  }
}

async function assertPositionExists(
  db: Pick<PrismaClient, "jcrcPosition">,
  id: string,
) {
  const position = await db.jcrcPosition.findUnique({ where: { id } });
  if (!position) throw notFound();
  return position;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

const POWER_LABELS = {
  vetsProposals: "Vets proposals",
  handlesDisposables: "Handles disposables",
} as const;

/**
 * Every position (or only the flagged ones) with its CCAs and current holders.
 * `vacant` is computed here, on read, by the guard module's check, and is only
 * ever true for a flagged position: an unflagged one grants nothing, so it has
 * nothing to be vacant of. This is a DISPLAY read, so it is forgiving: if the
 * check fails for one position its `vacant` is null ("unknown") and only the
 * error name is logged. The guard itself stays strict and still rejects.
 * The checks run one after the other, each a handful of small reads.
 */
export async function listPositions(
  db: PrismaClient,
  opts: { flaggedOnly: boolean; now?: Date },
) {
  const now = opts.now ?? new Date();
  const [all, links, holders] = await Promise.all([
    db.jcrcPosition.findMany({
      orderBy: [{ order: "asc" }, { name: "asc" }],
    }),
    db.jcrcPositionCca.findMany(),
    db.jcrcPositionHolder.findMany({ where: activeHolderWhere(now) }),
  ]);
  const positions = opts.flaggedOnly ? all.filter(isFlaggedPosition) : all;
  const ccaIDs = [...new Set(links.map((l) => l.ccaID))];
  const userIDs = [...new Set(holders.map((h) => h.userID))];
  const [ccas, users] = await Promise.all([
    db.cCA.findMany({
      where: { ccaID: { in: ccaIDs } },
      select: { ccaID: true, ccaName: true },
    }),
    db.user.findMany({
      where: { userID: { in: userIDs } },
      select: { userID: true, displayName: true, email: true },
    }),
  ]);
  const vacancy = new Map<string, boolean | null>();
  for (const p of positions) {
    if (!isFlaggedPosition(p)) {
      vacancy.set(p.id, false);
      continue;
    }
    try {
      vacancy.set(p.id, await isPositionVacant(db, p.id, now));
    } catch (error) {
      console.error(
        "[positions] vacancy read failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      vacancy.set(p.id, null);
    }
  }
  return positions.map((p) => ({
    id: p.id,
    name: p.name,
    overseesAll: p.overseesAll,
    order: p.order,
    vetsProposals: p.vetsProposals === true,
    handlesDisposables: p.handlesDisposables === true,
    /** The powers the flags give, in words, for screens that do not name flags. */
    powers: (Object.keys(POWER_LABELS) as (keyof typeof POWER_LABELS)[])
      .filter((flag) => p[flag] === true)
      .map((flag) => POWER_LABELS[flag]),
    /** true: vacant. false: held (or not flagged). null: could not be read. */
    vacant: vacancy.get(p.id) ?? null,
    ccas: links
      .filter((l) => l.positionID === p.id)
      .map((l) => ({
        ccaID: l.ccaID,
        ccaName:
          ccas.find((c) => c.ccaID === l.ccaID)?.ccaName ?? `CCA ${l.ccaID}`,
      }))
      .sort((a, b) => a.ccaName.localeCompare(b.ccaName)),
    holders: holders
      .filter((h) => h.positionID === p.id)
      .map((h) => {
        const user = users.find((u) => u.userID === h.userID);
        return {
          userID: h.userID,
          name: user?.displayName ?? user?.email ?? h.userID,
          endsAt: h.endsAt,
        };
      }),
  }));
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

/** Rename, and (for the Positions page) the oversees-all switch and the order. */
export async function updatePosition(
  db: PrismaClient,
  ctx: EditContext,
  input: {
    id: string;
    name?: string;
    overseesAll?: boolean;
    order?: number;
  },
) {
  const { id, ...data } = input;
  let result: { stored: PositionRow; locked: boolean };
  try {
    result = await positionTransaction(db, async (tx) => {
      const stored = await assertPositionExists(tx, id);
      assertInScope(ctx, stored);
      // Only a RENAME is locked: overseesAll grants no approval power and the
      // order is cosmetic, so neither is a change to what the position grants.
      const renaming = input.name !== undefined && input.name !== stored.name;
      const locked = isFlaggedPosition(stored) && renaming;
      if (locked) assertMayEditFlaggedPosition(ctx.actorRoles);
      await tx.jcrcPosition.update({
        where: { id },
        data: { ...data, updatedAt: nextUpdatedAt(stored.updatedAt) },
      });
      return { stored, locked };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TRPCError({ code: "CONFLICT", message: "NAME_TAKEN" });
    }
    throw err;
  }
  if (result.locked) {
    await auditFlaggedChange(db, {
      actorUserID: ctx.actor,
      actorRoles: ctx.actorRoles,
      action: POSITION_AUDIT.rename,
      position: result.stored,
      detail: `renamed to "${input.name}"`,
    });
  }
  return { id };
}

/** Deletes the position with its CCA list and holders. Roles are untouched. */
export async function deletePosition(
  db: PrismaClient,
  ctx: EditContext,
  input: { id: string },
) {
  // One transaction: the check, the snapshot the audit row records, the
  // removal of the rows and the delete of the position row itself.
  const { stored, before } = await positionTransaction(db, async (tx) => {
    const row = await assertPositionExists(tx, input.id);
    assertInScope(ctx, row);
    const locked = isFlaggedPosition(row);
    if (locked) assertMayEditFlaggedPosition(ctx.actorRoles);
    const snapshot = locked ? await snapshotPosition(tx, input.id) : undefined;
    await tx.jcrcPositionCca.deleteMany({ where: { positionID: input.id } });
    await tx.jcrcPositionHolder.deleteMany({
      where: { positionID: input.id },
    });
    await tx.jcrcPosition.delete({ where: { id: input.id } });
    return { stored: row, before: snapshot };
  });
  if (before) {
    await auditFlaggedChange(db, {
      actorUserID: ctx.actor,
      actorRoles: ctx.actorRoles,
      action: POSITION_AUDIT.delete,
      position: stored,
      detail: `deleted; ${describeSnapshot(before)}`,
    });
  }
  return { id: input.id };
}

/** Replaces a position's CCA list. */
export async function replacePositionCcas(
  db: PrismaClient,
  ctx: EditContext,
  input: { id: string; ccaIDs: number[] },
) {
  const wanted = [...new Set(input.ccaIDs)];
  const { stored, locked, toAdd, toRemove } = await positionTransaction(
    db,
    async (tx) => {
      const row = await assertPositionExists(tx, input.id);
      assertInScope(ctx, row);
      const isLocked = isFlaggedPosition(row);
      if (isLocked) assertMayEditFlaggedPosition(ctx.actorRoles);
      const known = await tx.cCA.findMany({
        where: { ccaID: { in: wanted } },
        select: { ccaID: true },
      });
      if (known.length !== wanted.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "UNKNOWN_CCA" });
      }
      // Writing the position row first makes this transaction conflict with an
      // overlapping flag change or edit.
      await touchPosition(tx, row);
      const current = await tx.jcrcPositionCca.findMany({
        where: { positionID: input.id },
        select: { ccaID: true },
      });
      const have = current.map((c) => c.ccaID);
      const add = wanted.filter((c) => !have.includes(c));
      const remove = have.filter((c) => !wanted.includes(c));
      if (remove.length > 0) {
        await tx.jcrcPositionCca.deleteMany({
          where: { positionID: input.id, ccaID: { in: remove } },
        });
      }
      for (const ccaID of add) {
        await tx.jcrcPositionCca.upsert({
          where: { positionID_ccaID: { positionID: input.id, ccaID } },
          create: { positionID: input.id, ccaID, addedBy: ctx.actor },
          update: {},
        });
      }
      return { stored: row, locked: isLocked, toAdd: add, toRemove: remove };
    },
  );
  if (locked && (toAdd.length > 0 || toRemove.length > 0)) {
    await auditFlaggedChange(db, {
      actorUserID: ctx.actor,
      actorRoles: ctx.actorRoles,
      action: POSITION_AUDIT.setCcas,
      position: stored,
      detail: `ccas added: ${toAdd.join(", ") || "none"}; removed: ${toRemove.join(", ") || "none"}`,
    });
  }
  return { added: toAdd.length, removed: toRemove.length };
}

/**
 * Adds a holder. The person must already hold `jcrc`: appointing JCRC is the
 * RFs' and Hall Office's job (or the handover's), not this list's.
 *
 * NO SELF-ASSIGNMENT, except by an admin on a position with no flag. A held
 * position is what lets a member hand `jcrc` on (services/jcrcHandover.ts), so
 * a member must not be able to give themselves one. On a flagged position
 * nobody may, admins included, because the holder is a director.
 */
export async function addPositionHolder(
  db: PrismaClient,
  ctx: EditContext,
  input: { id: string; userID: string },
) {
  const { actor, actorRoles } = ctx;
  const { stored, locked } = await positionTransaction(db, async (tx) => {
    const row = await tx.jcrcPosition.findUnique({ where: { id: input.id } });
    assertInScope(ctx, row);
    const isLocked = row !== null && isFlaggedPosition(row);
    if (isLocked) assertMayEditFlaggedPosition(actorRoles);
    assertDoorFitsFlagged(ctx, row);
    if (input.userID === actor) {
      if (isLocked) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "SELF_ASSIGN_FLAGGED",
        });
      }
      if (!actorRoles.includes(ADMIN_ROLE)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "SELF_ASSIGN" });
      }
    }
    if (!row) throw notFound();
    // A JCRC member may not touch a row staff assigned, or add someone who is
    // stepping out.
    if (!isStaffOrAdmin(actorRoles)) {
      await assertJcrcMayChangeRow(db, input.id, input.userID, true);
    }
    const targetRoles = await getUserRoles(db, input.userID);
    if (!targetRoles.includes(JCRC_ROLE)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "TARGET_NOT_JCRC" });
    }
    // A director who also heads a CCA the position lists would vet their own
    // CCA's proposals: refused for the Positions router and the staff panel.
    if (isLocked) await assertNoListedCcaHead(tx, [input.userID], [input.id]);
    await touchPosition(tx, row);
    const key = {
      positionID_userID: { positionID: input.id, userID: input.userID },
    };
    // A row the person made for themselves keeps that mark: setFlag and the
    // handover refuse such a row. Only someone else with authority (admin, RF,
    // Hall Office), re-assigning it, clears the mark; a plain member's re-add
    // and the holder's own re-add leave it.
    const existing = await tx.jcrcPositionHolder.findUnique({
      where: key,
      select: { assignedBy: true },
    });
    const keepsMark =
      existing?.assignedBy === input.userID &&
      !(mayEditFlaggedPosition(actorRoles) && actor !== input.userID);
    await tx.jcrcPositionHolder.upsert({
      where: key,
      create: {
        positionID: input.id,
        userID: input.userID,
        assignedBy: actor,
        endsAt: null,
      },
      update: {
        endsAt: null,
        handedOverAt: null,
        ...(keepsMark ? {} : { assignedBy: actor }),
        // Staff assigning again confirms a handover successor: the row can be
        // handed over once more (services/jcrcHandover.ts).
        ...(isLocked ? { handoverFrom: null } : {}),
        assignedAt: new Date(),
      },
    });
    return { stored: row, locked: isLocked };
  });
  // An open position means no term end: drop any step-out left over.
  await db.jcrcTerm.deleteMany({ where: { userID: input.userID } });
  if (locked) {
    await auditFlaggedChange(db, {
      actorUserID: actor,
      actorRoles,
      action: POSITION_AUDIT.addHolder,
      position: stored,
      targetUserID: input.userID,
      detail: "holder added",
    });
  }
  return { id: input.id, userID: input.userID };
}

/** Removes a holder from a position. Their `jcrc` role is untouched. */
export async function removePositionHolder(
  db: PrismaClient,
  ctx: EditContext,
  input: { id: string; userID: string },
) {
  // A position that does not exist has nothing to lock; the delete below is a
  // no-op for it on the Positions page, as before. A flagged-only door refuses.
  const { stored, locked, count } = await positionTransaction(
    db,
    async (tx) => {
      const row = await tx.jcrcPosition.findUnique({
        where: { id: input.id },
      });
      assertInScope(ctx, row);
      const isLocked = row !== null && isFlaggedPosition(row);
      if (isLocked) assertMayEditFlaggedPosition(ctx.actorRoles);
      assertDoorFitsFlagged(ctx, row);
      if (!isStaffOrAdmin(ctx.actorRoles)) {
        await assertJcrcMayChangeRow(db, input.id, input.userID, false);
      }
      if (row) await touchPosition(tx, row);
      const removed = await tx.jcrcPositionHolder.deleteMany({
        where: { positionID: input.id, userID: input.userID },
      });
      return { stored: row, locked: isLocked, count: removed.count };
    },
  );
  if (stored && locked && count > 0) {
    await auditFlaggedChange(db, {
      actorUserID: ctx.actor,
      actorRoles: ctx.actorRoles,
      action: POSITION_AUDIT.removeHolder,
      position: stored,
      targetUserID: input.userID,
      detail: "holder removed",
    });
  }
  return { id: input.id, userID: input.userID };
}
