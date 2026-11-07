import {
  reminderCreateInput,
  reminderIdInput,
  reminderMarkDoneInput,
} from "~/lib/schemas/reminder";
import {
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import {
  assertRemindersEnabled,
  isRemindersEnabled,
} from "~/server/api/services/reminders/flag";
import {
  broadcastDetail,
  ccaChoices,
  getEntry,
  loadHeadItems,
  outbox,
} from "~/server/api/services/reminders/read";
import {
  cancelBroadcast,
  markDone,
  sendBroadcast,
} from "~/server/api/services/reminders/write";

/**
 * Deadline broadcasts (merge proposal F22), behind `reminders.enabled`.
 *
 * EVERY procedure but `enabled` and `entry` checks the flag first, through one
 * gated builder, so a new procedure cannot forget it. Who may act is decided
 * inside the services from stored rows, never from the session's roles:
 *  - send / cancel: a director of EVERY CCA the broadcast addresses, by the
 *    strict guard (A9). The sender is the caller; the CCA ids from the browser
 *    only name what to check;
 *  - outbox / get / ccaChoices: a director, and only for the CCAs they direct;
 *  - mine / markDone: a head, and only for the CCAs they head. A head of another
 *    CCA is refused, and gets the same answer for a row that does not exist.
 * An admin who is none of these is refused. Every write carries a per-person
 * hourly ceiling (services/reminders/limits.ts). Errors pass through
 * `sanitizeErrors`, so a database error reaches the caller as "Something went
 * wrong.". The deadline nudges are the due check's (dueCheck/broadcastNudge.ts).
 */
const gated = identifiedProcedure
  .use(sanitizeErrors)
  .use(async ({ ctx, next }) => {
    await assertRemindersEnabled(ctx.db);
    return next();
  });

export const reminderRouter = createTRPCRouter({
  /** The screens ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isRemindersEnabled(ctx.db),
  })),

  /**
   * What the navigation shows. NOT gated: off and "nothing to show" are both a
   * plain all-false. A failed guard read is an error, which the header treats
   * as "hide it".
   */
  entry: identifiedProcedure
    .use(sanitizeErrors)
    .query(({ ctx }) => getEntry(ctx.db, ctx.session.user.userID)),

  ccaChoices: gated.query(({ ctx }) =>
    ccaChoices(ctx.db, ctx.session.user.userID),
  ),

  send: gated
    .input(reminderCreateInput)
    .mutation(({ ctx, input }) =>
      sendBroadcast(ctx.db, ctx.session.user.userID, input),
    ),

  outbox: gated.query(({ ctx }) => outbox(ctx.db, ctx.session.user.userID)),

  get: gated
    .input(reminderIdInput)
    .query(({ ctx, input }) =>
      broadcastDetail(ctx.db, ctx.session.user.userID, input.id),
    ),

  cancel: gated
    .input(reminderIdInput)
    .mutation(({ ctx, input }) =>
      cancelBroadcast(ctx.db, ctx.session.user.userID, input.id),
    ),

  mine: gated.query(({ ctx }) =>
    loadHeadItems(ctx.db, ctx.session.user.userID),
  ),

  markDone: gated
    .input(reminderMarkDoneInput)
    .mutation(({ ctx, input }) =>
      markDone(ctx.db, ctx.session.user.userID, input),
    ),
});
