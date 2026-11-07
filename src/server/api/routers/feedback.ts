import { z } from "zod";

import { feedbackSubmitInput } from "~/lib/schemas/feedback";
import {
  adminProcedure,
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
} from "~/server/api/trpc";
import {
  assertFeedbackEnabled,
  isFeedbackEnabled,
  submitFeedback,
} from "~/server/api/services/feedback";

/** The most reports one list call returns, whatever the client asks for. */
export const LIST_MAX = 50;
export const LIST_DEFAULT = 20;

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * Every procedure but `enabled` checks `feedback.enabled` first. Reports are
 * written only by `submitFeedback`, with the submitter taken from the session:
 * no input names a user. Only an admin can read them.
 */
const gatedUser = identifiedProcedure.use(async ({ ctx, next }) => {
  await assertFeedbackEnabled(ctx.db);
  return next();
});
const gatedAdmin = adminProcedure.use(async ({ ctx, next }) => {
  await assertFeedbackEnabled(ctx.db);
  return next();
});

export const feedbackRouter = createTRPCRouter({
  /** The form and the admin tab ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isFeedbackEnabled(ctx.db),
  })),

  submit: gatedUser
    .input(feedbackSubmitInput)
    .mutation(({ ctx, input }) =>
      submitFeedback(ctx.db, ctx.session.user.userID, input),
    ),

  /** Newest first, one bounded page at a time. */
  list: gatedAdmin
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(LIST_MAX).default(LIST_DEFAULT),
          cursor: objectId.optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.feedback.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
        select: {
          id: true,
          userID: true,
          category: true,
          message: true,
          createdAt: true,
        },
      });
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]!.id : null,
      };
    }),
});
