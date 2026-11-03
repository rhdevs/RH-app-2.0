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

/**
 * JCRC positions: CRUD, holders, the caller's own view scope and the
 * self-handover.
 *
 * VIEWS ONLY. Any JCRC member or admin may create, edit and delete any
 * position, set its CCAs and its holders, because a position grants nothing:
 * it only sets the default "My positions" filter on JCRC lists. The one write
 * here that touches a ROLE is `handOver`, and that is limited to positions the
 * caller holds (services/jcrcHandover.ts).
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

async function assertPositionExists(db: PrismaClient, id: string) {
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
  list: roleManagerProcedure.query(async ({ ctx }) => {
    await assertManager(ctx.db, ctx.session.user.userID);
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
    const positions = await ctx.db.jcrcPosition.findMany({
      where: { id: { in: held.map((h) => h.positionID) } },
      select: { id: true, name: true },
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
      await assertManager(ctx.db, ctx.session.user.userID);
      await assertPositionExists(ctx.db, input.id);
      const { id, ...data } = input;
      try {
        await ctx.db.jcrcPosition.update({
          where: { id },
          data: { ...data, updatedAt: new Date() },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({ code: "CONFLICT", message: "NAME_TAKEN" });
        }
        throw err;
      }
      return { id };
    }),

  /** Deletes the position with its CCA list and holders. Roles are untouched. */
  delete: roleManagerProcedure
    .input(z.object({ id: objectIDSchema }))
    .mutation(async ({ ctx, input }) => {
      await assertManager(ctx.db, ctx.session.user.userID);
      await assertPositionExists(ctx.db, input.id);
      await ctx.db.jcrcPositionCca.deleteMany({
        where: { positionID: input.id },
      });
      await ctx.db.jcrcPositionHolder.deleteMany({
        where: { positionID: input.id },
      });
      await ctx.db.jcrcPosition.delete({ where: { id: input.id } });
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
      await assertManager(ctx.db, userID);
      await assertPositionExists(ctx.db, input.id);
      const wanted = [...new Set(input.ccaIDs)];
      const known = await ctx.db.cCA.findMany({
        where: { ccaID: { in: wanted } },
        select: { ccaID: true },
      });
      if (known.length !== wanted.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "UNKNOWN_CCA" });
      }
      const current = await ctx.db.jcrcPositionCca.findMany({
        where: { positionID: input.id },
        select: { ccaID: true },
      });
      const have = current.map((c) => c.ccaID);
      const toAdd = wanted.filter((c) => !have.includes(c));
      const toRemove = have.filter((c) => !wanted.includes(c));
      if (toRemove.length > 0) {
        await ctx.db.jcrcPositionCca.deleteMany({
          where: { positionID: input.id, ccaID: { in: toRemove } },
        });
      }
      for (const ccaID of toAdd) {
        await ctx.db.jcrcPositionCca.upsert({
          where: { positionID_ccaID: { positionID: input.id, ccaID } },
          create: { positionID: input.id, ccaID, addedBy: userID },
          update: {},
        });
      }
      return { added: toAdd.length, removed: toRemove.length };
    }),

  /**
   * Adds a holder. The person must already hold `jcrc`: appointing JCRC is the
   * RFs' and Hall Office's job (or the handover's), not this list's.
   *
   * NO SELF-ASSIGNMENT, except by an admin. A held position is what lets a
   * member hand `jcrc` on (services/jcrcHandover.ts), so a member must not be
   * able to give themselves one.
   */
  addHolder: roleManagerProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) => {
      const actor = ctx.session.user.userID;
      const actorRoles = await assertManager(ctx.db, actor);
      if (input.userID === actor && !actorRoles.includes(ADMIN_ROLE)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "SELF_ASSIGN" });
      }
      await assertPositionExists(ctx.db, input.id);
      const targetRoles = await getUserRoles(ctx.db, input.userID);
      if (!targetRoles.includes(JCRC_ROLE)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "TARGET_NOT_JCRC",
        });
      }
      await ctx.db.jcrcPositionHolder.upsert({
        where: {
          positionID_userID: { positionID: input.id, userID: input.userID },
        },
        create: {
          positionID: input.id,
          userID: input.userID,
          assignedBy: actor,
          endsAt: null,
        },
        update: {
          endsAt: null,
          handedOverAt: null,
          assignedBy: actor,
          assignedAt: new Date(),
        },
      });
      // An open position means no term end: drop any step-out left over.
      await ctx.db.jcrcTerm.deleteMany({ where: { userID: input.userID } });
      return { id: input.id, userID: input.userID };
    }),

  /** Removes a holder from a position. Their `jcrc` role is untouched. */
  removeHolder: roleManagerProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) => {
      await assertManager(ctx.db, ctx.session.user.userID);
      await ctx.db.jcrcPositionHolder.deleteMany({
        where: { positionID: input.id, userID: input.userID },
      });
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
