import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

export const bookingRouter = createTRPCRouter({
  create: protectedProcedure
    .input(
      z.object({
        slot: z.date(),
        facilityId: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const booking = await ctx.db.booking.create({
        data: {
          slot: input.slot,
          facilityId: input.facilityId,
          userId: ctx.auth.userId!,
        },
      });
      return booking;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // Fetch the booking to verify ownership
      const booking = await ctx.db.booking.findUnique({
        where: { id: input.id },
      });
      if (!booking) {
        throw new Error("Booking not found");
      }
      if (booking.userId !== ctx.auth.userId) {
        throw new Error("Not authorized to delete this booking");
      }
      const deletedBooking = await ctx.db.booking.delete({
        where: { id: input.id },
      });
      return deletedBooking;
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        slot: z.date().optional(),
        facilityId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the booking exists and belongs to the current user
      const booking = await ctx.db.booking.findUnique({
        where: { id: input.id },
      });
      if (!booking) {
        throw new Error("Booking not found");
      }
      if (booking.userId !== ctx.auth.userId) {
        throw new Error("Not authorized to update this booking");
      }
      const updatedBooking = await ctx.db.booking.update({
        where: { id: input.id },
        data: {
          // Only update the fields provided in the input
          slot: input.slot,
          facilityId: input.facilityId,
        },
      });
      return updatedBooking;
    }),

  getAll: publicProcedure.query(async ({ ctx }) => {
    return await ctx.db.booking.findMany();
  }),
});
