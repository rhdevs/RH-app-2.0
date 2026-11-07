import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { createTRPCRouter, roleManagerProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import {
  ADMIN_ROLE,
  JCRC_ROLE,
  userIDSchema,
} from "~/server/api/services/roles";
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
  addPositionHolder,
  deletePosition,
  listPositions,
  removePositionHolder,
  replacePositionCcas,
  updatePosition,
} from "~/server/api/services/jcrcPositionEdits";
import {
  POSITION_AUDIT,
  auditFlaggedChange,
  describeSnapshot,
  nextUpdatedAt,
  positionTransaction,
  sameMembers,
  snapshotPosition,
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
 * Office edit through the staff panel, routers/jcrcPositionsStaff.ts, which
 * calls the same functions in services/jcrcPositionEdits.ts), and each change
 * writes an audit row. The lock reads the flag from the stored row at each
 * call and stays on when `directors.enabled` is off. Only an admin sets or
 * clears a flag, and self-assignment to a flagged position is refused for
 * everyone. The one holder change left to a holder is `handOver`, limited to
 * positions the caller holds (services/jcrcHandover.ts); it is not locked.
 *
 * Each change to a position runs its read, its lock check and its writes in
 * one transaction that also writes the position row (services/jcrcPositionEdits.ts,
 * services/jcrcPositionLock.ts),
 * so a flag change and a holder or CCA change that overlap cannot both commit:
 * the loser gets CONFLICT CONFIRMATION_STALE and the person tries again.
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
  /** Every position with its CCAs, current holders and, if flagged, whether it is vacant. */
  list: roleManagerProcedure.query(async ({ ctx }) => {
    await assertManager(ctx.db, ctx.session.user.userID);
    const now = new Date();
    await sweepEndedJcrcTerms(ctx.db, now);
    return listPositions(ctx.db, { flaggedOnly: false, now });
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
    const positions = await ctx.db.jcrcPosition.findMany({
      where: { id: { in: held.map((h) => h.positionID) } },
      select: {
        id: true,
        name: true,
        vetsProposals: true,
        handlesDisposables: true,
      },
    });
    return {
      scope,
      positions: positions.map((p) => ({
        id: p.id,
        name: p.name,
        endsAt: held.find((h) => h.positionID === p.id)?.endsAt ?? null,
      })),
      termEndsAt: term?.endsAt ?? null,
    };
  }),

  /** Current JCRC members: the people a position can be given to. */
  jcrcMembers: roleManagerProcedure.query(async ({ ctx }) => {
    await assertManager(ctx.db, ctx.session.user.userID);
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
      return updatePosition(
        ctx.db,
        { actor, actorRoles, flaggedOnly: false },
        input,
      );
    }),

  /** Deletes the position with its CCA list and holders. Roles are untouched. */
  delete: roleManagerProcedure
    .input(z.object({ id: objectIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      return deletePosition(
        ctx.db,
        { actor, actorRoles, flaggedOnly: false },
        input,
      );
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
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      return replacePositionCcas(
        ctx.db,
        { actor, actorRoles, flaggedOnly: false },
        input,
      );
    }),

  /**
   * Adds a holder. The person must already hold `jcrc`, and nobody may add
   * themselves to a flagged position (an admin may to an unflagged one). The
   * rules live in services/jcrcPositionEdits.ts, shared with the staff panel.
   */
  addHolder: roleManagerProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      return addPositionHolder(
        ctx.db,
        { actor, actorRoles, flaggedOnly: false },
        input,
      );
    }),

  /** Removes a holder from a position. Their `jcrc` role is untouched. */
  removeHolder: roleManagerProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      return removePositionHolder(
        ctx.db,
        { actor, actorRoles, flaggedOnly: false },
        input,
      );
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

  /** Move (a date) or cancel (null) the caller's own pending step-out. */
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
