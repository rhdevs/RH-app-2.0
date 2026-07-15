import { protectedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const userRouter = createTRPCRouter({
  getCurrentUserData: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    const user = await ctx.db.user.findUnique({
      where: { id: userId },
      // Never ship passwordHash to the client (#9).
      select: {
        id: true,
        userID: true,
        email: true,
        displayName: true,
        telegramHandle: true,
        bio: true,
        block: true,
        createdAt: true,
      },
    });

    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });

    return user;
  }),

  updateUserData: protectedProcedure
    .input(
      z.object({
        telegramHandle: z.string(),
        bio: z.string(),
        block: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const updatedUser = await ctx.db.user.update({
        where: { id: userId },
        data: {
          telegramHandle: input.telegramHandle,
          bio: input.bio,
          block: input.block,
        },
      });

      return updatedUser;
    }),
});
