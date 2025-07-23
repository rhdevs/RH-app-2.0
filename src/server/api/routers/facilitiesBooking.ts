import { z } from "zod";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

export const facilityBookingRouter = createTRPCRouter({
  // Get all facilities in ascending order
  getAllFacilities: publicProcedure.query(async ({ ctx }) => {
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
        ctx.db.user.findFirst({ where: { id: booking.userID } }),
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

  // Get all bookings within specific time period, optionally filtered by ccaID
  getBookings: publicProcedure
    .input(
      z.object({
        startTime: z.number(),
        endTime: z.number(),
        facilityID: z.number().optional(),
        userId: z.string().optional(),
        seeAll: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { startTime, endTime, facilityID, userId, seeAll } = input;
      const timeFilter = seeAll
        ? {}
        : {
            startTime: { lte: endTime },
            endTime: { gte: startTime },
          };
      const bookings = await ctx.db.bookings.findMany({
        where: {
          ...timeFilter,
          ...(facilityID ? { facilityID } : {}),
          ...(userId ? { userID: userId } : {}),
        },
      });
      const userIDs = [...new Set(bookings.map((b) => b.userID))];

      const users = await ctx.db.user.findMany({
        where: {
          userID: { in: userIDs },
        },
      });
      const userMap = new Map(users.map((u) => [u.userID, u.displayName]));

      const facilities = await ctx.db.facilities.findMany();
      const ONE_DAY = 86400; // seconds in a day

      const splitBookings = [];

      for (const booking of bookings) {
        const { startTime, endTime } = booking;

        // If booking is more than one day
        if (endTime - startTime > ONE_DAY) {
          let currentStart = startTime;

          // Split into 1-day chunks
          while (currentStart + ONE_DAY < endTime) {
            splitBookings.push({
              ...booking,
              startTime: currentStart,
              endTime: currentStart + ONE_DAY,
            });
            currentStart += ONE_DAY;
          }

          splitBookings.push({
            ...booking,
            startTime: currentStart,
            endTime: endTime,
            originalBookingID: booking.bookingID,
          });
        }
      }

      const processedBookings = [
        ...bookings.filter((b) => b.endTime - b.startTime <= ONE_DAY), // only single-day ones
        ...splitBookings,
      ];

      return processedBookings.map((booking) => {
        return {
          id: booking.id,
          start: new Date(booking.startTime * 1000),
          end: new Date(booking.endTime * 1000),
          title: facilities.find((fac) => fac.facilityID === booking.facilityID)
            ?.facilityName,
          user: userMap.get(booking.userID),
          eventName: booking.eventName,
          eventDescription: booking.description,
        };
      });
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

  createBooking: protectedProcedure
    .input(
      z.object({
        ccaID: z.number(),
        eventName: z.string(),
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

      const lastBooking = await ctx.db.bookings.findFirst({
        orderBy: { bookingID: "desc" },
        select: { bookingID: true },
      });

      const nextBookingID = (lastBooking?.bookingID || 0) + 1;

      return ctx.db.bookings.create({
        data: {
          bookingID: Number(nextBookingID),
          eventName: input.eventName,
          endTime: input.endTime,
          facilityID: input.facilityID,
          startTime: input.startTime,
          userID: input.userID,
          ccaID: 0,
        },
      });
    }),
  deleteBooking: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db.bookings.delete({
        where: {
          id: input.id,
        },
      });

      return deleted;
    }),
});
