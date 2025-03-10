import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const eventRouter = createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({
        location: z.string(),
        description: z.string(),
        signUpLink: z.string().url(),
        organiserId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const event = await ctx.db.event.create({
        data: input,
      });
      return event;
    }),

  delete: publicProcedure.input(z.number()).mutation(async ({ ctx, input }) => {
    const event = await ctx.db.event.delete({
      where: { id: input },
    });
    return event;
  }),

  getAll: publicProcedure.query(async ({ ctx }) => {
    return await ctx.db.event.findMany();
  }),
});
