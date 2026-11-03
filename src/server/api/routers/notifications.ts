import { z } from "zod";

import {
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
} from "~/server/api/trpc";
import {
  areNotificationsEnabled,
  assertNotificationsEnabled,
} from "~/server/api/services/notifications";

/** The most rows one list call returns, whatever the client asks for. */
export const LIST_MAX = 50;
export const LIST_DEFAULT = 20;
const MARK_MAX = 100;

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

/**
 * The signed-in user's own inbox. Every procedure but `enabled` checks the
 * `notifications.enabled` switch first, and every query is scoped by the
 * session's user id: there is no input that names another person, so one user
 * can neither see nor change another's rows. Rows are written only by
 * `notify` (services/notifications.ts); nothing here creates one.
 */
const inbox = identifiedProcedure.use(async ({ ctx, next }) => {
  await assertNotificationsEnabled(ctx.db);
  return next();
});

export const notificationsRouter = createTRPCRouter({
  /** The bell asks this to decide whether to draw itself. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await areNotificationsEnabled(ctx.db),
  })),

  /** A pure read: it writes nothing, so a refetch on focus is harmless. */
  unreadCount: inbox.query(async ({ ctx }) => ({
    count: await ctx.db.notification.count({
      where: { userID: ctx.session.user.userID, readAt: null },
    }),
  })),

  /** Newest first, one bounded page at a time. */
  list: inbox
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(LIST_MAX).default(LIST_DEFAULT),
          cursor: objectId.optional(),
        })
        .default({}),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.notification.findMany({
        where: { userID: ctx.session.user.userID },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor && { cursor: { id: input.cursor }, skip: 1 }),
        select: {
          id: true,
          kind: true,
          title: true,
          body: true,
          href: true,
          createdAt: true,
          readAt: true,
        },
      });
      const hasMore = rows.length > input.limit;
      const items = hasMore ? rows.slice(0, input.limit) : rows;
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]!.id : null,
      };
    }),

  /** Ids that are not the caller's are ignored, so they reveal nothing. */
  markRead: inbox
    .input(z.object({ ids: z.array(objectId).min(1).max(MARK_MAX) }))
    .mutation(async ({ ctx, input }) => {
      const res = await ctx.db.notification.updateMany({
        where: {
          id: { in: input.ids },
          userID: ctx.session.user.userID,
          readAt: null,
        },
        data: { readAt: new Date() },
      });
      return { updated: res.count };
    }),

  markAllRead: inbox.mutation(async ({ ctx }) => {
    const res = await ctx.db.notification.updateMany({
      where: { userID: ctx.session.user.userID, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }),
});
