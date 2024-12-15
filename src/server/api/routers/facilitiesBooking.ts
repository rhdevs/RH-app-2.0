import { z } from "zod";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

export const facilityBookingRouter = createTRPCRouter({
  // Get all facilities in ascending order
  getAllFacilities: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.facilities.findMany({
      orderBy: { facilityID: "asc" },
    });
  }),

  // Get facility by facilityID
  getFacility: protectedProcedure
    .input(z.number())
    .query(async ({ ctx, input }) => {
      const facility = await ctx.db.facilities.findUnique({
        where: { facilityID: input },
      });
      if (!facility) throw new Error("Facility not found");
      return facility;
    }),

  // Get available facilities within a specific period
  getAvailableFacilities: protectedProcedure
    .input(
      z.object({
        startTime: z.number(),
        endTime: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.endTime <= input.startTime) {
        throw new Error("Invalid start and end time");
      }
      const allFacilities = await ctx.db.facilities.findMany({
        orderBy: { facilityID: "asc" },
      });
      const occupiedBookings = await ctx.db.bookings.findMany({
        where: {
          AND: [
            { startTime: { lt: input.endTime } },
            { endTime: { gt: input.startTime } },
          ],
        },
        select: {
          facilityID: true,
        },
      });
      const occupiedFacilityIds = new Set(
        occupiedBookings.map((b) => b.facilityID),
      );
      return allFacilities.filter(
        (f) => !occupiedFacilityIds.has(f.facilityID),
      );
    }),

  // Get booking by bookingID
  getBooking: protectedProcedure
    .input(z.number())
    .query(async ({ ctx, input }) => {
      const booking = await ctx.db.bookings.findFirst({
        where: { bookingID: input },
      });

      if (!booking) throw new Error("Booking not found");

      const [user, facility, cca] = await Promise.all([
        ctx.db.user.findFirst({ where: { userID: booking.userID } }),
        ctx.db.facilities.findFirst({
          where: { facilityID: booking.facilityID },
        }),
        ctx.db.cCA.findFirst({ where: { ccaID: booking.ccaID } }),
      ]);

      return {
        ...booking,
        user,
        facility,
        cca,
      };
    }),

  // Get bookings of a user
  getUserBookings: protectedProcedure
    .input(z.string())
    .query(async ({ ctx, input }) => {
      const currentTime = Math.floor(Date.now() / 1000);
      const bookings = await ctx.db.bookings.findMany({
        where: {
          userID: input,
          endTime: { gte: currentTime },
        },
      });
      const bookingsWithDetails = await Promise.all(
        bookings.map(async (booking) => {
          const [user, facility, cca] = await Promise.all([
            ctx.db.user.findFirst({
              where: { userID: booking.userID },
              select: { displayName: true },
            }),
            ctx.db.facilities.findFirst({
              where: { facilityID: booking.facilityID },
              select: { facilityName: true },
            }),
            ctx.db.cCA.findFirst({
              where: { ccaID: booking.ccaID },
              select: { ccaName: true },
            }),
          ]);
          return {
            ...booking,
            displayName: user?.displayName,
            facilityName: facility?.facilityName,
            ccaName: cca?.ccaName,
          };
        }),
      );
      return bookingsWithDetails.sort((a, b) => a.startTime - b.startTime);
    }),

  // Create booking
  createBooking: protectedProcedure
    .input(
      z.object({
        bookingID: z.number(),
        ccaID: z.number(),
        description: z.string().optional(),
        endTime: z.number(),
        facilityID: z.number(),
        startTime: z.number(),
        userID: z.string(),
        repeat: z.number().optional(),
        bookUntil: z.number().optional(),
        forceBook: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.endTime <= input.startTime) {
        throw new Error("End time earlier than start time");
      }
      const conflicts = await ctx.db.bookings.findMany({
        where: {
          facilityID: input.facilityID,
          AND: [
            { endTime: { gt: input.startTime } },
            { startTime: { lt: input.endTime } },
          ],
        },
      });
      if (conflicts.length > 0 && !input.forceBook) {
        throw new Error("Conflicting bookings exist");
      }
      return ctx.db.bookings.create({
        data: input,
      });
    }),
});
