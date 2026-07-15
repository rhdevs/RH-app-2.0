import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { canBookFacility, getUserRole, ADMIN_ROLE } from "../services/access";
import { nextBookingId, withFacilityLock } from "../services/booking";

/**
 * Fields safe to expose about a user (#9). Deliberately excludes passwordHash
 * and anything else sensitive. Reuse everywhere a booking is joined to a user.
 */
const publicUserSelect = {
  id: true,
  userID: true,
  displayName: true,
  telegramHandle: true,
  block: true,
  bio: true,
} satisfies Prisma.UserSelect;

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

      if (!booking) throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });

      const [user, facility, cca] = await Promise.all([
        // booking.userID holds User.userID (the matric-style id), not the
        // ObjectId — the previous `id:` lookup always returned null (#15).
        ctx.db.user.findFirst({
          where: { userID: booking.userID },
          select: publicUserSelect,
        }),
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
  getBookings: protectedProcedure
    .input(
      z.object({
        startTime: z.number(),
        endTime: z.number(),
        facilityIDs: z.array(z.number()).optional(),
        userId: z.string().optional(),
        seeAll: z.boolean().optional(),
        limit: z.number().default(100),
        cursor: z.object({
          startTime: z.number(),
          id: z.string(),
        }).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { startTime, endTime, facilityIDs, userId, seeAll, limit, cursor } = input;
      const callerUserID = ctx.session.user.userID;
      // `seeAll` (full-table dump) is admin-only (#10).
      const role = await getUserRole(ctx.db, callerUserID);
      const canSeeAll = Boolean(seeAll) && role === ADMIN_ROLE;
      const timeFilter = canSeeAll
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
          ...(cursor ? {
            OR: [
              { startTime: { lt: cursor.startTime } },
              {
                startTime: cursor.startTime,
                id: { gt: cursor.id },
              },
            ],
          } : {}),
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

      const facilities = await ctx.db.facilities.findMany({
        select: {
          facilityID: true,
          facilityName: true,
        },
      });
      
      // Create facility dictionary for O(1) lookups
      const facilityDict = Object.fromEntries(
        facilities.map((f) => [f.facilityID, f.facilityName])
      );
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
          });
        }
      }

      const processedBookings = [
        ...bookings.filter((b) => b.endTime - b.startTime <= ONE_DAY), // only single-day ones
        ...splitBookings,
      ];

      // Light resort after splitting (most bookings will already be ordered)
      processedBookings.sort((a, b) => {
        if (b.startTime !== a.startTime) {
          return b.startTime - a.startTime;
        }
        return b.id.localeCompare(a.id);
      });

      const nextCursor = processedBookings.length === limit && processedBookings.length > 0
        ? {
            startTime: processedBookings[processedBookings.length - 1]!.startTime,
            id: processedBookings[processedBookings.length - 1]!.id,
          }
        : undefined;

      return {
        bookings: processedBookings.map((booking) => ({
          id: booking.id,
          start: new Date(booking.startTime * 1000),
          end: new Date(booking.endTime * 1000),
          title: facilityDict[booking.facilityID],
          user: userDict[booking.userID]?.displayName,
          eventName: booking.eventName,
          eventDescription: booking.description,
          // Only reveal a personal Telegram handle on the caller's own
          // bookings (#10).
          userTeleHandle:
            booking.userID === callerUserID
              ? userDict[booking.userID]?.telegramHandle
              : undefined,
        })),
        nextCursor,
      };
    }),

  // Get the signed-in user's own upcoming bookings
  getUserBookings: protectedProcedure.query(async ({ ctx }) => {
    // Owner is always the caller — never a client-supplied id (#8).
    const userID = ctx.session.user.userID;
    const currentTime = Math.floor(Date.now() / 1000);
    const bookings = await ctx.db.bookings.findMany({
      where: {
        userID,
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
        repeat: z.number().optional(),
        bookUntil: z.number().optional(),
        forceBook: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.endTime <= input.startTime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "End time earlier than start time",
        });
      }

      // Owner is always the caller — never client-supplied (#6).
      const userID = ctx.session.user.userID;

      // Facility-level access control (#23), replacing the client-side allowlist.
      if (!(await canBookFacility(ctx.db, userID, input.facilityID))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You are not allowed to book this facility.",
        });
      }

      // Serialize per facility so the conflict check and the create can't
      // interleave with a competing booking (#11/#12).
      return withFacilityLock(ctx.db, input.facilityID, async () => {
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
          throw new TRPCError({
            code: "CONFLICT",
            message: "Conflicting bookings exist",
          });
        }

        // Atomic id allocation instead of a racy max()+1 read (#13).
        const bookingID = await nextBookingId(ctx.db);

        // Persist every field the form collects instead of dropping them and
        // hardcoding ccaID: 0 (#14).
        return ctx.db.bookings.create({
          data: {
            bookingID,
            eventName: input.eventName,
            description: input.description,
            endTime: input.endTime,
            facilityID: input.facilityID,
            startTime: input.startTime,
            userID,
            ccaID: input.ccaID,
            repeat: input.repeat,
            bookUntil: input.bookUntil,
            forceBook: input.forceBook,
          },
        });
      });
    }),
  deleteBooking: protectedProcedure
    .input(
      z.object({
        id: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Load first and verify ownership before deleting (#7).
      const existing = await ctx.db.bookings.findUnique({
        where: { id: input.id },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Booking not found" });
      }

      const role = await getUserRole(ctx.db, ctx.session.user.userID);
      if (existing.userID !== ctx.session.user.userID && role !== ADMIN_ROLE) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only delete your own bookings.",
        });
      }

      return ctx.db.bookings.delete({ where: { id: input.id } });
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
