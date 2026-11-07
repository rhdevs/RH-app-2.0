import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { createTRPCRouter, scrcProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { userIDSchema } from "~/server/api/services/roles";
import { isDirectorsEnabled } from "~/server/api/services/directorGuard";
import {
  assertScrcEnabled,
  isScrcEnabled,
} from "~/server/api/services/scrcFlag";
import { mayEditFlaggedPosition } from "~/server/api/services/jcrcPositionLock";
import {
  addPositionHolder,
  deletePosition,
  listPositions,
  removePositionHolder,
  replacePositionCcas,
  updatePosition,
  type EditContext,
} from "~/server/api/services/jcrcPositionEdits";

/**
 * THE STAFF DOOR to flagged JCRC positions: what the panel on /scrc calls.
 *
 * Admins, RFs (`scrc`) and Hall Office (`hall_office`) may list the FLAGGED
 * positions and change their holders and CCA list, rename them and delete them.
 * Every one of those calls goes through the same functions as the Positions
 * router (services/jcrcPositionEdits.ts): the same transaction, the same lock
 * check and the same audit row. There is no second copy of the rules here.
 *
 * WHAT THE STAFF DOOR DOES NOT HAVE, on purpose:
 *  - no way to set or clear a flag. That is admin only and stays in the
 *    Positions router; there is simply no such procedure here;
 *  - no way to touch an unflagged position. Each call is `flaggedOnly`, and
 *    the position it reads inside its transaction decides, so a position that
 *    was unflagged a moment ago is refused (NOT_FLAGGED);
 *  - no way to add oneself to a flagged position. The shared function refuses
 *    it for everyone, admins included. Staff cannot hold `jcrc` anyway.
 *
 * THE `scrc.enabled` KILL SWITCH. Every call except `status` asserts it and is
 * refused with SCRC_DISABLED when the row is off, absent or unreadable
 * (services/scrcFlag.ts fails closed). Then only admins edit, through the
 * Positions page. `directors.enabled` does not gate these calls: the lock on a
 * flagged position stays on whether or not the powers are switched on, and so
 * does the right of staff to maintain it. It only decides whether the panel is
 * shown (`status`).
 *
 * WHO. scrcProcedure admits admin, scrc and hall_office from the session; the
 * roles are read again live here (I-5) and must satisfy the same rule the lock
 * uses, so the two cannot drift. A plain `jcrc` member is not admitted.
 */

const objectIDSchema = z.string().regex(/^[a-f0-9]{24}$/i, "Not a valid id");
const nameSchema = z.string().trim().min(1).max(80);
const MAX_CCAS_PER_POSITION = 200;

/** The caller's live roles, refused unless they are staff (or an admin). */
async function staffContext(
  db: PrismaClient,
  userID: string,
): Promise<EditContext> {
  const actorRoles = await getUserRoles(db, userID);
  if (!mayEditFlaggedPosition(actorRoles)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_STAFF" });
  }
  return { actor: userID, actorRoles, flaggedOnly: true };
}

/** Staff, and the kill switch on. */
async function openStaffContext(db: PrismaClient, userID: string) {
  const ctx = await staffContext(db, userID);
  await assertScrcEnabled(db);
  return ctx;
}

export const jcrcPositionsStaffRouter = createTRPCRouter({
  /**
   * Whether the panel shows: `scrc.enabled` AND `directors.enabled` both on.
   * It does not throw when either is off; "off" is its answer. A failed read of
   * either counts as off.
   */
  status: scrcProcedure.query(async ({ ctx }) => {
    await staffContext(ctx.db, ctx.session.user.userID);
    const [scrcOn, directorsOn] = await Promise.all([
      isScrcEnabled(ctx.db),
      isDirectorsEnabled(ctx.db),
    ]);
    return { visible: scrcOn && directorsOn };
  }),

  /** The flagged positions with CCAs, holders and vacancy, and every CCA to choose from. */
  list: scrcProcedure.query(async ({ ctx }) => {
    await openStaffContext(ctx.db, ctx.session.user.userID);
    const [positions, ccas] = await Promise.all([
      listPositions(ctx.db, { flaggedOnly: true }),
      ctx.db.cCA.findMany({
        select: { ccaID: true, ccaName: true },
        orderBy: { ccaName: "asc" },
      }),
    ]);
    return { positions, ccas };
  }),

  addHolder: scrcProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) =>
      addPositionHolder(
        ctx.db,
        await openStaffContext(ctx.db, ctx.session.user.userID),
        input,
      ),
    ),

  removeHolder: scrcProcedure
    .input(z.object({ id: objectIDSchema, userID: userIDSchema }))
    .mutation(async ({ ctx, input }) =>
      removePositionHolder(
        ctx.db,
        await openStaffContext(ctx.db, ctx.session.user.userID),
        input,
      ),
    ),

  setCcas: scrcProcedure
    .input(
      z.object({
        id: objectIDSchema,
        ccaIDs: z
          .array(z.number().int().nonnegative())
          .max(MAX_CCAS_PER_POSITION),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      replacePositionCcas(
        ctx.db,
        await openStaffContext(ctx.db, ctx.session.user.userID),
        input,
      ),
    ),

  /** Rename only: the order and the oversees-all switch stay on the Positions page. */
  rename: scrcProcedure
    .input(z.object({ id: objectIDSchema, name: nameSchema }))
    .mutation(async ({ ctx, input }) =>
      updatePosition(
        ctx.db,
        await openStaffContext(ctx.db, ctx.session.user.userID),
        input,
      ),
    ),

  delete: scrcProcedure
    .input(z.object({ id: objectIDSchema }))
    .mutation(async ({ ctx, input }) =>
      deletePosition(
        ctx.db,
        await openStaffContext(ctx.db, ctx.session.user.userID),
        input,
      ),
    ),
});
