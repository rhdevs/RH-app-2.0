import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { JcrcPosition, PrismaClient } from "@prisma/client";

import {
  createTRPCRouter,
  positionHolderProcedure,
  roleManagerProcedure,
} from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import {
  ADMIN_ROLE,
  holdsStaffRole,
  JCRC_ROLE,
  userIDSchema,
} from "~/server/api/services/roles";
import { assertScrcEnabled } from "~/server/api/services/scrcFlag";
import {
  activeHolderWhere,
  myPositionCcas,
} from "~/server/api/services/jcrcPositions";
import {
  handOverPositions,
  setStepOut,
  sweepEndedJcrcTerms,
} from "~/server/api/services/jcrcHandover";
import { isDirectorsEnabled } from "~/server/api/services/directorGuard";
import {
  POSITION_AUDIT,
  assertMayEditFlaggedPosition,
  assertNoListedCcaHead,
  mayEditFlaggedPosition,
  auditFlaggedChange,
  describeSnapshot,
  isFlaggedPosition,
  nextUpdatedAt,
  positionTransaction,
  sameMembers,
  snapshotPosition,
  touchPosition,
} from "~/server/api/services/jcrcPositionLock";

/**
 * JCRC positions: CRUD, holders, the caller's own view scope and the
 * self-handover.
 *
 * VIEWS ONLY, EXCEPT FOR A FLAGGED POSITION. Any JCRC member or admin may
 * create, edit and delete a position with neither flag, set its CCAs and its
 * holders, with no audit row: it only sets the default "My positions" filter
 * on JCRC lists. A position flagged `vetsProposals` or `handlesDisposables` is
 * a permission (services/directorGuard.ts), so it is LOCKED: changing its
 * holders or CCAs, renaming it and deleting it need an admin (RFs and Hall
 * Office edit through the staff panel, with the same check), and each change
 * writes an audit row. The lock reads the flag from the stored row at each
 * call and stays on when `directors.enabled` is off. Only an admin sets or
 * clears a flag, and self-assignment to a flagged position is refused for
 * everyone. The one holder change left to a holder is `handOver`, limited to
 * positions the caller holds (services/jcrcHandover.ts); it is not locked.
 *
 * Each change to a position runs its read, its lock check and its writes in
 * one transaction that also writes the position row (services/jcrcPositionLock.ts),
 * so a flag change and a holder or CCA change that overlap cannot both commit:
 * the loser gets CONFLICT CONFIRMATION_STALE and the person tries again.
 *
 * HOLDERS are also set by staff (RFs and Hall Office), from the Staff page:
 * only a row staff or an admin assigned can be handed over, which is what stops
 * the handover from minting `jcrc` (services/jcrcHandover.ts).
 *
 * Every procedure re-reads roles LIVE (I-5): roleManagerProcedure admits on the
 * session, and a member whose term ended a minute ago must not keep editing.
 */

const objectIDSchema = z.string().regex(/^[a-f0-9]{24}$/i, "Not a valid id");
const nameSchema = z.string().trim().min(1).max(80);
const MAX_SUCCESSORS = 10;
const MAX_CCAS_PER_POSITION = 200;
const MAX_STEP_OUT_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

async function assertManager(db: PrismaClient, userID: string) {
  const roles = await getUserRoles(db, userID);
  if (!roles.includes(ADMIN_ROLE) && !roles.includes(JCRC_ROLE)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_JCRC" });
  }
  return roles;
}

type PositionRow = JcrcPosition;

/**
 * May see and set holders: admin, jcrc, or staff. Staff also need the
 * `scrc.enabled` switch, like every other Staff-page tool.
 */
async function assertHolderManager(db: PrismaClient, userID: string) {
  const roles = await getUserRoles(db, userID);
  if (roles.includes(ADMIN_ROLE) || roles.includes(JCRC_ROLE)) return roles;
  if (!holdsStaffRole(roles)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_JCRC" });
  }
  await assertScrcEnabled(db);
  return roles;
}

/** The subset of `userIDs` who hold a staff role or admin right now. */
async function staffOrAdmin(
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
 * Staff re-assigning is how a mistaken handover is undone.
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
  if (!position) {
    throw new TRPCError({ code: "NOT_FOUND", message: "POSITION_NOT_FOUND" });
  }
  return position;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

const stepOutSchema = z.coerce
  .date()
  .refine(
    (d) => d.getTime() <= Date.now() + MAX_STEP_OUT_DAYS * DAY_MS,
    "Step-out date is too far ahead",
  );

export const jcrcPositionsRouter = createTRPCRouter({
  /** Every position with its CCAs and current holders. */
  list: positionHolderProcedure.query(async ({ ctx }) => {
    await assertHolderManager(ctx.db, ctx.session.user.userID);
    const now = new Date();
    await sweepEndedJcrcTerms(ctx.db, now);
    const [positions, links, holders] = await Promise.all([
      ctx.db.jcrcPosition.findMany({
        orderBy: [{ order: "asc" }, { name: "asc" }],
      }),
      ctx.db.jcrcPositionCca.findMany(),
      ctx.db.jcrcPositionHolder.findMany({ where: activeHolderWhere(now) }),
    ]);
    const ccaIDs = [...new Set(links.map((l) => l.ccaID))];
    const userIDs = [...new Set(holders.map((h) => h.userID))];
    const [ccas, users] = await Promise.all([
      ctx.db.cCA.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, ccaName: true },
      }),
      ctx.db.user.findMany({
        where: { userID: { in: userIDs } },
        select: { userID: true, displayName: true, email: true },
      }),
    ]);
    return positions.map((p) => ({
      id: p.id,
      name: p.name,
      overseesAll: p.overseesAll,
      order: p.order,
      vetsProposals: p.vetsProposals === true,
      handlesDisposables: p.handlesDisposables === true,
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
  }),

  /**
   * The caller's own view: the CCAs "My positions" shows ("all" when they
   * hold none or an oversees-all position), what they hold, and their term end.
   */
  mine: roleManagerProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    await assertManager(ctx.db, userID);
    const now = new Date();
    const [scope, held, term] = await Promise.all([
      myPositionCcas(ctx.db, userID, now),
      ctx.db.jcrcPositionHolder.findMany({
        where: { userID, ...activeHolderWhere(now) },
      }),
      ctx.db.jcrcTerm.findUnique({ where: { userID } }),
    ]);
    const [positions, staffAssigners] = await Promise.all([
      ctx.db.jcrcPosition.findMany({
        where: { id: { in: held.map((h) => h.positionID) } },
        select: { id: true, name: true },
      }),
      staffOrAdmin(
        ctx.db,
        held.map((h) => h.assignedBy),
      ),
    ]);
    return {
      scope,
      positions: positions.map((p) => {
        const row = held.find((h) => h.positionID === p.id);
        return {
          id: p.id,
          name: p.name,
          endsAt: row?.endsAt ?? null,
          // A hint for the page only; handOver re-checks all of this.
          canHandOver:
            row != null &&
            row.handedOverAt == null &&
            row.assignedBy !== userID &&
            staffAssigners.has(row.assignedBy),
        };
      }),
      termEndsAt: term?.endsAt ?? null,
    };
  }),

  /** Current JCRC members: the people a position can be given to. */
  jcrcMembers: positionHolderProcedure.query(async ({ ctx }) => {
    await assertHolderManager(ctx.db, ctx.session.user.userID);
    const rows = await ctx.db.userRole.findMany({
      where: { OR: [{ roles: { has: JCRC_ROLE } }, { role: JCRC_ROLE }] },
      select: { userID: true },
    });
    const userIDs = rows.map((r) => r.userID);
    const users = await ctx.db.user.findMany({
      where: { userID: { in: userIDs } },
      select: { userID: true, displayName: true, email: true },
    });
    return userIDs
      .map((userID) => {
        const user = users.find((u) => u.userID === userID);
        return { userID, name: user?.displayName ?? user?.email ?? userID };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }),

  /**
   * What the screen shows: whether `directors.enabled` is on (fail closed),
   * whether the caller is an admin (read live), and so whether the flag
   * controls show. The lock does not depend on the switch.
   */
  directorsStatus: roleManagerProcedure.query(async ({ ctx }) => {
    const roles = await assertManager(ctx.db, ctx.session.user.userID);
    const enabled = await isDirectorsEnabled(ctx.db);
    const isAdmin = roles.includes(ADMIN_ROLE);
    return { enabled, isAdmin, canSetFlags: enabled && isAdmin };
  }),

  /**
   * Set or clear one director flag. ADMIN ONLY, and only while
   * `directors.enabled` is on.
   *
   * The admin confirms the position's holders and CCAs on screen first: the
   * screen sends what it showed, and a change since then (CONFIRMATION_STALE)
   * writes nothing, so the audit row lists what the admin actually confirmed.
   * Setting is refused while any current holder's row was self-assigned
   * (`assignedBy` equals `userID`): a row made before the flag must not carry
   * power nobody approved. Clearing only removes power, so it is not blocked
   * by that.
   */
  setFlag: roleManagerProcedure
    .input(
      z.object({
        id: objectIDSchema,
        flag: z.enum(["vetsProposals", "handlesDisposables"]),
        value: z.boolean(),
        seen: z.object({
          holderIDs: z.array(userIDSchema).max(200),
          ccaIDs: z.array(z.number().int().nonnegative()).max(200),
        }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      if (!actorRoles.includes(ADMIN_ROLE)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "ADMIN_REQUIRED" });
      }
      if (!(await isDirectorsEnabled(ctx.db))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "DIRECTORS_DISABLED",
        });
      }
      // The snapshot, its comparison with what the admin saw and the flag
      // write are one transaction that writes the position row: a holder or
      // CCA change that overlaps it conflicts, so the audit row below lists
      // exactly the holders and CCAs the flag took effect over.
      const done = await positionTransaction(ctx.db, async (tx) => {
        const stored = await assertPositionExists(tx, input.id);
        const snapshot = await snapshotPosition(tx, input.id);
        if (
          !sameMembers(
            snapshot.holders.map((h) => h.userID),
            input.seen.holderIDs,
          ) ||
          !sameMembers(snapshot.ccaIDs, input.seen.ccaIDs)
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "CONFIRMATION_STALE",
          });
        }
        if (
          input.value &&
          snapshot.holders.some((h) => h.assignedBy === h.userID)
        ) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "SELF_ASSIGNED_HOLDER",
          });
        }
        if ((stored[input.flag] === true) === input.value) return null;
        await tx.jcrcPosition.update({
          where: { id: input.id },
          data: {
            ...(input.flag === "vetsProposals"
              ? { vetsProposals: input.value }
              : { handlesDisposables: input.value }),
            updatedAt: nextUpdatedAt(stored.updatedAt),
          },
        });
        return { stored, snapshot };
      });
      if (!done) return { id: input.id, changed: false };
      await auditFlaggedChange(ctx.db, {
        actorUserID: actor,
        actorRoles,
        action: input.value ? POSITION_AUDIT.flagSet : POSITION_AUDIT.flagClear,
        position: done.stored,
        detail: `${input.flag} ${input.value ? "set" : "cleared"}; ${describeSnapshot(done.snapshot)}`,
      });
      return { id: input.id, changed: true };
    }),

  create: roleManagerProcedure
    .input(
      z.object({
        name: nameSchema,
        overseesAll: z.boolean().default(false),
        order: z.number().int().min(0).max(999).default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      await assertManager(ctx.db, userID);
      try {
        const created = await ctx.db.jcrcPosition.create({
          data: { ...input, createdBy: userID },
        });
        return { id: created.id };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({ code: "CONFLICT", message: "NAME_TAKEN" });
        }
        throw err;
      }
    }),

  update: roleManagerProcedure
    .input(
      z.object({
        id: objectIDSchema,
        name: nameSchema.optional(),
        overseesAll: z.boolean().optional(),
        order: z.number().int().min(0).max(999).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      const { id, ...data } = input;
      let result: { stored: PositionRow; locked: boolean };
      try {
        result = await positionTransaction(ctx.db, async (tx) => {
          const stored = await assertPositionExists(tx, id);
          // Only a RENAME is locked: overseesAll grants no approval power and
          // the order is cosmetic, so neither is a change to what the
          // position grants.
          const renaming =
            input.name !== undefined && input.name !== stored.name;
          const locked = isFlaggedPosition(stored) && renaming;
          if (locked) assertMayEditFlaggedPosition(actorRoles);
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
        await auditFlaggedChange(ctx.db, {
          actorUserID: actor,
          actorRoles,
          action: POSITION_AUDIT.rename,
          position: result.stored,
          detail: `renamed to "${input.name}"`,
        });
      }
      return { id };
    }),

  /** Deletes the position with its CCA list and holders. Roles are untouched. */
  delete: roleManagerProcedure
    .input(z.object({ id: objectIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      // One transaction: the check, the snapshot the audit row records, the
      // removal of the rows and the delete of the position row itself.
      const { stored, before } = await positionTransaction(
        ctx.db,
        async (tx) => {
          const row = await assertPositionExists(tx, input.id);
          const locked = isFlaggedPosition(row);
          if (locked) assertMayEditFlaggedPosition(actorRoles);
          const snapshot = locked
            ? await snapshotPosition(tx, input.id)
            : undefined;
          await tx.jcrcPositionCca.deleteMany({
            where: { positionID: input.id },
          });
          await tx.jcrcPositionHolder.deleteMany({
            where: { positionID: input.id },
          });
          await tx.jcrcPosition.delete({ where: { id: input.id } });
          return { stored: row, before: snapshot };
        },
      );
      if (before) {
        await auditFlaggedChange(ctx.db, {
          actorUserID: actor,
          actorRoles,
          action: POSITION_AUDIT.delete,
          position: stored,
          detail: `deleted; ${describeSnapshot(before)}`,
        });
      }
      return { id: input.id };
    }),

  /** Replaces a position's CCA list. */
  setCcas: roleManagerProcedure
    .input(
      z.object({
        id: objectIDSchema,
        ccaIDs: z
          .array(z.number().int().nonnegative())
          .max(MAX_CCAS_PER_POSITION),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, userID);
      const wanted = [...new Set(input.ccaIDs)];
      const { stored, locked, toAdd, toRemove } = await positionTransaction(
        ctx.db,
        async (tx) => {
          const row = await assertPositionExists(tx, input.id);
          const isLocked = isFlaggedPosition(row);
          if (isLocked) assertMayEditFlaggedPosition(actorRoles);
          const known = await tx.cCA.findMany({
            where: { ccaID: { in: wanted } },
            select: { ccaID: true },
          });
          if (known.length !== wanted.length) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "UNKNOWN_CCA",
            });
          }
          // Writing the position row first makes this transaction conflict
          // with an overlapping flag change or edit.
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
              create: { positionID: input.id, ccaID, addedBy: userID },
              update: {},
            });
          }
          return {
            stored: row,
            locked: isLocked,
            toAdd: add,
            toRemove: remove,
          };
        },
      );
      if (locked && (toAdd.length > 0 || toRemove.length > 0)) {
        await auditFlaggedChange(ctx.db, {
          actorUserID: userID,
          actorRoles,
          action: POSITION_AUDIT.setCcas,
          position: stored,
          detail: `ccas added: ${toAdd.join(", ") || "none"}; removed: ${toRemove.join(", ") || "none"}`,
        });
      }
      return { added: toAdd.length, removed: toRemove.length };
    }),

  /**
   * Adds a holder. The person must already hold `jcrc`: appointing JCRC is the
   * RFs' and Hall Office's job (or the handover's), not this list's.
   *
   * NO SELF-ASSIGNMENT, except by an admin on a position with no flag. A held
   * position is what lets a member hand `jcrc` on (services/jcrcHandover.ts),
   * so a member must not be able to give themselves one. On a flagged position
   * nobody may, admins included, because the holder is a director.
   */
  addHolder: positionHolderProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertHolderManager(ctx.db, actor);
      const { stored, locked } = await positionTransaction(
        ctx.db,
        async (tx) => {
          const row = await tx.jcrcPosition.findUnique({
            where: { id: input.id },
          });
          const isLocked = row !== null && isFlaggedPosition(row);
          if (isLocked) assertMayEditFlaggedPosition(actorRoles);
          if (input.userID === actor) {
            if (isLocked) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "SELF_ASSIGN_FLAGGED",
              });
            }
            if (!actorRoles.includes(ADMIN_ROLE)) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "SELF_ASSIGN",
              });
            }
          }
          if (!row) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "POSITION_NOT_FOUND",
            });
          }
          // What a JCRC member may not do to a row staff assigned, or to
          // someone stepping out. (A flagged position never gets here for a
          // member: the lock above refuses them.)
          if (!isStaffOrAdmin(actorRoles)) {
            await assertJcrcMayChangeRow(ctx.db, input.id, input.userID, true);
          }
          const targetRoles = await getUserRoles(ctx.db, input.userID);
          if (!targetRoles.includes(JCRC_ROLE)) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "TARGET_NOT_JCRC",
            });
          }
          // A director who also heads a CCA the position lists would vet
          // their own CCA's proposals.
          if (isLocked)
            await assertNoListedCcaHead(tx, [input.userID], [input.id]);
          await touchPosition(tx, row);
          const key = {
            positionID_userID: { positionID: input.id, userID: input.userID },
          };
          // A row the person made for themselves keeps that mark: setFlag and
          // the handover refuse such a row. Only someone else with authority
          // (admin, RF, Hall Office), re-assigning it, clears the mark; a plain
          // member's re-add and the holder's own re-add leave it.
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
              // Staff assigning again confirms a handover successor: the row
              // can be handed over once more (services/jcrcHandover.ts).
              ...(isLocked ? { handoverFrom: null } : {}),
              assignedAt: new Date(),
            },
          });
          return { stored: row, locked: isLocked };
        },
      );
      // An open position means no term end: drop any step-out left over.
      await ctx.db.jcrcTerm.deleteMany({ where: { userID: input.userID } });
      if (locked) {
        await auditFlaggedChange(ctx.db, {
          actorUserID: actor,
          actorRoles,
          action: POSITION_AUDIT.addHolder,
          position: stored,
          targetUserID: input.userID,
          detail: "holder added",
        });
      }
      return { id: input.id, userID: input.userID };
    }),

  /** Removes a holder from a position. Their `jcrc` role is untouched. */
  removeHolder: positionHolderProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertHolderManager(ctx.db, actor);
      // A position that does not exist has nothing to lock; the delete below
      // is a no-op for it, as before.
      const { stored, locked, count } = await positionTransaction(
        ctx.db,
        async (tx) => {
          const row = await tx.jcrcPosition.findUnique({
            where: { id: input.id },
          });
          const isLocked = row !== null && isFlaggedPosition(row);
          if (isLocked) assertMayEditFlaggedPosition(actorRoles);
          if (!isStaffOrAdmin(actorRoles)) {
            await assertJcrcMayChangeRow(ctx.db, input.id, input.userID, false);
          }
          if (row) await touchPosition(tx, row);
          const removed = await tx.jcrcPositionHolder.deleteMany({
            where: { positionID: input.id, userID: input.userID },
          });
          return { stored: row, locked: isLocked, count: removed.count };
        },
      );
      if (stored && locked && count > 0) {
        await auditFlaggedChange(ctx.db, {
          actorUserID: actor,
          actorRoles,
          action: POSITION_AUDIT.removeHolder,
          position: stored,
          targetUserID: input.userID,
          detail: "holder removed",
        });
      }
      return { id: input.id, userID: input.userID };
    }),

  /** JCRC self-handover. See services/jcrcHandover.ts. */
  handOver: roleManagerProcedure
    .input(
      z.object({
        positionIDs: z.array(objectIDSchema).min(1).max(20),
        successorIDs: z.array(userIDSchema).min(1).max(MAX_SUCCESSORS),
        stepOutAt: stepOutSchema,
        reason: z.string().trim().max(300).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return handOverPositions(ctx.db, {
        actorUserID: ctx.session.user.userID,
        ...input,
      });
    }),

  /**
   * Bring the caller's own pending step-out forward (never later). `null`
   * stays in the input so the service can refuse a cancel by name; a date
   * parser would read it as the start of 1970, which is "step out now".
   */
  setStepOut: roleManagerProcedure
    .input(z.object({ stepOutAt: stepOutSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const userID = ctx.session.user.userID;
      const roles = await assertManager(ctx.db, userID);
      if (!roles.includes(JCRC_ROLE)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "NOT_JCRC" });
      }
      return setStepOut(ctx.db, userID, input.stepOutAt);
    }),
});
