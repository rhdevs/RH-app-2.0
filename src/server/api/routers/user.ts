import { protectedProcedure, createTRPCRouter } from "~/server/api/trpc";
import { z } from "zod";

export const userRouter = createTRPCRouter({
  getCurrentUserData: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    const user = await ctx.db.user.findUnique({
      where: { id: userId },
    });

    if (!user) throw new Error("User not found");

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
