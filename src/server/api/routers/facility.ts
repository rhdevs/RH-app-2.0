import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const facilityRouter = createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({
        description: z.string(),
        openingHours: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const facility = await ctx.db.facility.create({
        data: input,
      });
      return facility;
    }),

  delete: publicProcedure.input(z.number()).mutation(async ({ ctx, input }) => {
    const facility = await ctx.db.facility.delete({
      where: { id: input },
    });
    return facility;
  }),

  getAll: publicProcedure.query(async ({ ctx }) => {
    return await ctx.db.facility.findMany();
  }),

  getById: publicProcedure.input(z.number()).query(async ({ ctx, input }) => {
    return await ctx.db.facility.findUnique({
      where: { id: input },
    });
  }),
});
