import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

export const bookingRouter = createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({
        // Expect a valid date (passed as a JS Date)
        slot: z.date(),
        userId: z.number(),
        facilityId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const booking = await ctx.db.booking.create({
        data: input,
      });
      return booking;
    }),

  delete: publicProcedure.input(z.number()).mutation(async ({ ctx, input }) => {
    const booking = await ctx.db.booking.delete({
      where: { id: input },
    });
    return booking;
  }),

  getAll: publicProcedure.query(async ({ ctx }) => {
    return await ctx.db.booking.findMany();
  }),
});
