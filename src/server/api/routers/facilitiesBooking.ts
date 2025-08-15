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
        facilityIDs: z.array(z.number()).optional(),
        userId: z.string().optional(),
        seeAll: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { startTime, endTime, facilityIDs, userId, seeAll } = input;
      const timeFilter = seeAll
        ? {}
        : {
            startTime: { lte: endTime },
            endTime: { gte: startTime },
          };
      const bookings = await ctx.db.bookings.findMany({
        where: {
          ...timeFilter,
          ...(facilityIDs && facilityIDs.length > 0
            ? { facilityID: { in: facilityIDs } }
            : {}),
          ...(userId ? { userID: userId } : {}),
        },
      });
      const userIDs = [...new Set(bookings.map((b) => b.userID))];

      const users = await ctx.db.user.findMany({
        where: {
          userID: { in: userIDs },
        },
      });
      const userDict = Object.fromEntries(
        users.map((u) => [
          u.userID,
          {
            displayName: u.displayName,
            telegramHandle: u.telegramHandle,
          },
        ]),
      );

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
          user: userDict[booking.userID].displayName,
          eventName: booking.eventName,
          eventDescription: booking.description,
          userTeleHandle: userDict[booking.userID].telegramHandle,
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

      const nextBookingID = (lastBooking?.bookingID ?? 0) + 1;

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

  updateBooking: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        eventName: z.string().optional(),
        description: z.string().optional(),
        startTime: z.number().optional(),
        endTime: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, eventName, description, startTime, endTime } = input;

      // Get the existing booking first
      const existingBooking = await ctx.db.bookings.findUnique({
        where: { id },
      });

      if (!existingBooking) {
        throw new Error("Booking not found");
      }

      // Ensure user can only edit their own bookings
      if (existingBooking.userID !== ctx.session?.user?.userID) {
        throw new Error("Unauthorized: Can only edit your own bookings");
      }

      // If time is being updated, validate the new times
      const newStartTime = startTime ?? existingBooking.startTime;
      const newEndTime = endTime ?? existingBooking.endTime;

      if (newEndTime <= newStartTime) {
        throw new Error("End time must be after start time");
      }

      // Check for conflicts only if time is being changed
      if (startTime !== undefined || endTime !== undefined) {
        const conflicts = await ctx.db.bookings.findMany({
          where: {
            facilityID: existingBooking.facilityID,
            id: { not: id }, // Exclude current booking
            AND: [
              { endTime: { gt: newStartTime } },
              { startTime: { lt: newEndTime } },
            ],
          },
        });

        if (conflicts.length > 0) {
          throw new Error("Time conflicts with existing bookings");
        }
      }

      // Update the booking
      const updated = await ctx.db.bookings.update({
        where: { id },
        data: {
          ...(eventName !== undefined && { eventName }),
          ...(description !== undefined && { description }),
          ...(startTime !== undefined && { startTime }),
          ...(endTime !== undefined && { endTime }),
        },
      });

      return updated;
    }),
});
