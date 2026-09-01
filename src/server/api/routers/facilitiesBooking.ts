import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { randomUUID } from "node:crypto";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
  matricProcedure,
  requireMatric,
  requireRoles,
} from "../trpc";
import {
  evaluateBookingWithMode,
  isAdmin,
  getBookableFacilityMap,
  type BookDecision,
} from "../services/access";
import {
  nextBookingId,
  nextBookingIdBlock,
  withFacilityLock,
} from "../services/booking";
import { JCRC_ROLE, CCA_HEAD_ROLE } from "../services/roles";
import {
  SERIES_MAX_OCCURRENCES,
  seriesWindowSchema,
  validateSeriesWindows,
  type SeriesWindow,
} from "~/lib/schemas/recurrence";

/**
 * WHO MAY CREATE A REPEATING BOOKING: CCA heads and JCRC (and `admin`, which
 * `requireRoles` admits implicitly). Ordinary residents keep single bookings.
 *
 * A series is an N-times claim on a shared hall, so this is a policy decision
 * rather than a technical one, and it was taken deliberately as the STRICT
 * opening position: it is easy to relax later, and very hard to take back once
 * residents have term-long bookings. `SERIES_MAX_OCCURRENCES` is a separate,
 * purely technical bound and is NOT the policy — see its own note.
 *
 * Composed onto `matricProcedure` rather than replacing it: a head still has to
 * clear the same onboarding gate as anyone else making a booking, and layering
 * the two means neither can be forgotten. Ordering follows the existing
 * `identifiedProcedure.use(requireMatric)` idiom in the events router.
 */
const seriesProcedure = protectedProcedure
  .use(requireMatric)
  .use(requireRoles(JCRC_ROLE, CCA_HEAD_ROLE));

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

/**
 * Turns a structured BookDecision into a message the user can act on.
 *
 * The reason codes are deliberately disjoint from matricProcedure's
 * MATRIC_REQUIRED: triage of a lockout must not have to guess which gate fired.
 * The old code discarded the reason and said "not allowed", which turned every
 * lockout into a support ticket (02-backend-authz.md §4.4).
 */
function denialMessage(d: Extract<BookDecision, { ok: false }>): string {
  switch (d.reason) {
    case "NO_IDENTITY":
      // 08 §1.1: distinct from NOT_ELIGIBLE because the remediation differs —
      // this account HAS a session, it just has no canonical id to own a row
      // with, so nothing it writes could ever be found again.
      return "Your account has no NUS student ID associated with it, so a booking could not be attributed to you. Please sign in with your @u.nus.edu email, or contact the JCRC.";
    case "NOT_ELIGIBLE":
      return "Your account is not a verified NUS student account. Please sign in with your @u.nus.edu email.";
    case "NOT_RESIDENT":
      return "Your account is not recognised as a hall resident. Please contact the JCRC.";
    case "ROLE_REQUIRED":
      return `This room is restricted to: ${d.requiredRoles.join(" or ")}.`;
    case "FACILITY_CLOSED":
      // The operator's own copy when there is any, because only they know where
      // the booking actually happens. The fallback says the one true thing we
      // can say without it: not here.
      return (
        d.note ??
        "This room can't be booked through RHApp. Please contact the JCRC to find out who manages it."
      );
  }
}

export const facilityBookingRouter = createTRPCRouter({
  // Get all facilities in ascending order
  getAllFacilities: publicProcedure.query(async ({ ctx }) => {
    return ctx.db.facilities.findMany({
      orderBy: { facilityID: "asc" },
    });
  }),

  /**
   * Server-driven facility permissions for the booking picker, replacing the
   * hardcoded client-side room allowlist.
   *
   * ADVISORY ONLY (I-7): createBooking remains the enforcement point, and this
   * query is never the thing that stops a booking. The I-7 v2 corollary is why
   * `canBook` is computed by getBookableFacilityMap rather than by any rule of
   * the client's own — a client gate must never be STRICTER than the server, so
   * the picker and the enforcement point must read the same flag, the same
   * roles and the same requiredRoles. Under the kill switch "off" that means
   * every facility open today still reports canBook: true.
   *
   * `requiredRoles` is returned alongside so the UI can say WHAT is needed
   * instead of silently hiding a room.
   *
   * getAllFacilities is deliberately RETAINED and unchanged: it is a
   * publicProcedure with display-only consumers (Calendar.tsx, PastBookings.tsx,
   * and the calendar grid in Calender_v2.tsx), which must keep rendering for
   * signed-out visitors. This procedure is the one that gates a booking control.
   */
  getFacilitiesForBooking: protectedProcedure.query(async ({ ctx }) => {
    const [facilities, permMap] = await Promise.all([
      ctx.db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
      getBookableFacilityMap(ctx.db, ctx.session.user.userID),
    ]);
    return facilities.map((f) => ({
      ...f,
      canBook: permMap.get(f.facilityID)?.canBook ?? false,
      requiredRoles: permMap.get(f.facilityID)?.requiredRoles ?? ["resident"],
      // The closure axis, carried through so the picker can say "the Dance CCA
      // Exco books this" rather than showing a role list the user cannot act on.
      // `canBook` already accounts for it; these two are for the COPY.
      closed: permMap.get(f.facilityID)?.closed ?? false,
      closedNote: permMap.get(f.facilityID)?.closedNote ?? null,
    }));
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

  /**
   * Every facility, each annotated with whether it is FREE for a given window
   * and — when it is not — the booking that takes it.
   *
   * Deliberately NOT getAvailableFacilities, which returns the free ones and
   * drops the rest: a picker built on that shows a room vanishing from the list
   * when the head changes the time, with nothing to say why. A room that reads
   * "Dance Studio — booked 3:00–4:00 PM" tells them to move the window; a room
   * that is simply absent tells them the page is broken.
   *
   * ADVISORY, exactly like getFacilitiesForBooking (I-7): the window can be
   * taken between this query and the write, so the booking path re-checks under
   * withFacilityLock and remains the only thing that can refuse. Never gate a
   * write on this result alone.
   *
   * `conflict` is the EARLIEST overlapping booking, not all of them — the picker
   * needs one concrete "taken from X to Y" to act on, and a room with three
   * clashes is no more available than a room with one.
   */
  getFacilityAvailability: protectedProcedure
    .input(
      z.object({
        startTime: z.number().int(),
        endTime: z.number().int(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (input.endTime <= input.startTime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "END_BEFORE_START",
        });
      }
      const [facilities, clashes] = await Promise.all([
        ctx.db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
        // Half-open overlap, matching findFacilityConflict and every other
        // overlap check here: a booking ending exactly when this window starts
        // does not take the room.
        ctx.db.bookings.findMany({
          where: {
            AND: [
              { startTime: { lt: input.endTime } },
              { endTime: { gt: input.startTime } },
            ],
          },
          select: {
            facilityID: true,
            startTime: true,
            endTime: true,
            eventName: true,
          },
          orderBy: { startTime: "asc" },
        }),
      ]);

      const firstClash = new Map<number, (typeof clashes)[number]>();
      for (const c of clashes) {
        if (!firstClash.has(c.facilityID)) firstClash.set(c.facilityID, c);
      }

      return facilities.map((f) => {
        const clash = firstClash.get(f.facilityID);
        return {
          facilityID: f.facilityID,
          facilityName: f.facilityName,
          facilityLocation: f.facilityLocation,
          available: clash === undefined,
          // `eventName` is what the hall calendar already shows publicly for a
          // booking, so surfacing it here leaks nothing new — and "taken by
          // Dance Club auditions" is what makes the clash resolvable.
          conflict: clash
            ? {
                startTime: clash.startTime,
                endTime: clash.endTime,
                eventName: clash.eventName,
              }
            : null,
        };
      });
    }),

  // Get booking by bookingID
  getBooking: protectedProcedure
    .input(z.number())
    .query(async ({ ctx, input }) => {
      const booking = await ctx.db.bookings.findFirst({
        where: { bookingID: input },
      });

      if (!booking)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Booking not found",
        });

      // 09 §2.3: this route had NO ownership check and joined publicUserSelect
      // (telegramHandle, bio, block) for an arbitrary bookingID from a bare
      // z.number(). Iterating the sequential id space handed every owner's
      // Telegram handle to any signed-in user — the payload #10 removed from
      // getBookings, reachable by a route that fix did not touch.
      //
      // Boolean(callerUserID) is load-bearing for the same reason it is in
      // deleteBooking. Pre-C9 the hazard was `"" === ""` matching any
      // ""-keyed row; C9 types the absent identity `null`, which no `string`
      // column value can equal, so the type now proves what this conjunct
      // asserts. RETAINED anyway: it costs nothing, it is the booking path, and
      // it is what still holds if the field is ever re-widened to `string`.
      // An empty id owns nothing.
      //
      // NOT_FOUND, not FORBIDDEN, and byte-identical to the message above: a
      // 403 would confirm the id exists and turn the sequential id space into
      // an enumeration oracle for how many bookings the hall has.
      const callerUserID = ctx.session.user.userID;
      const owns = Boolean(callerUserID) && booking.userID === callerUserID;
      if (!owns && !(await isAdmin(ctx.db, callerUserID))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Booking not found",
        });
      }

      const [user, facility, cca] = await Promise.all([
        // booking.userID holds the CANONICAL session id (E-format, or the
        // legacy uppercased email for pre-merge non-NUS rows) — not the
        // ObjectId, so the previous `id:` lookup always returned null (#15).
        //
        // 08 §0.2: it has never held an A-format matric, but `User.userID` is
        // heterogeneous (E-format, ~515 legacy A-format matrics, and null for
        // Google/adapter-created rows). So this join is correct for E-format
        // owners and MISSES the A-format rows, which render with a blank owner
        // name. That is Problem B, repaired by the re-key, not here.
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
        // 09 §3.1 (S2): `.min(1)` because the consumer below is
        // `...(userId ? { userID: userId } : {})` — the correct spread
        // conditional for an ABSENT filter and the wrong one for an EMPTY one.
        // Without this, a hand-crafted `userId: ""` drops the condition and
        // gets the full dump instead of the empty result it asks for. Reject it
        // where the value enters, not where it is spent. `cursor`'s own
        // optionality is unaffected.
        userId: z.string().min(1).optional(),
        seeAll: z.boolean().optional(),
        limit: z.number().default(100),
        cursor: z
          .object({
            startTime: z.number(),
            id: z.string(),
          })
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { startTime, endTime, facilityIDs, userId, seeAll, limit, cursor } =
        input;
      const callerUserID = ctx.session.user.userID;
      // `seeAll` (full-table dump) is admin-only (#10).
      // I-6: was `getUserRole(...) === ADMIN_ROLE`, i.e. a positional roles[0]
      // read. roles[0] is $addToSet insertion order, so a user holding
      // ["jcrc","admin"] silently lost admin here and was denied their own
      // capability. isAdmin() tests membership over the whole set.
      const canSeeAll =
        Boolean(seeAll) && (await isAdmin(ctx.db, callerUserID));
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
          ...(cursor
            ? {
                OR: [
                  { startTime: { lt: cursor.startTime } },
                  {
                    startTime: cursor.startTime,
                    id: { gt: cursor.id },
                  },
                ],
              }
            : {}),
        },
        /* ---- ORDERING IS CORRECTNESS HERE, NOT PRESENTATION -------------
         * THIS QUERY HAD NO `orderBy` AT ALL, while the `cursor` filter above
         * paginates on `(startTime, id)`. Keyset pagination over an UNORDERED
         * result is undefined: Mongo returns documents in natural order, which
         * is neither stable nor related to the cursor's predicate, so page 2
         * could skip rows page 1 never showed and repeat rows it did. Nobody
         * would see an error — just a booking list quietly missing bookings.
         *
         * THE ORDER IS DICTATED BY THE CURSOR PREDICATE, NOT BY THE UI. Read the
         * cursor filter above: `startTime < cursor.startTime` OR (`startTime ==
         * cursor.startTime` AND `id > cursor.id`). That is startTime DESCENDING
         * with an ASCENDING id tiebreak, and this `orderBy` must mirror it
         * exactly or the cursor walks a different sequence than the one it is
         * cutting.
         *
         * SO: NO `facilityID` HERE, even though both consumers group by room
         * (Q1). Sorting by facility first would put the pagination key third and
         * break the cursor outright. Room grouping is a PRESENTATION concern and
         * is done client-side in Calender_v2 and PastBookings, which is the right
         * place for it: those views group a day or a time frame that has already
         * been fetched whole, whereas grouping at the DB level would fight the
         * keyset walk.
         */
        orderBy: [{ startTime: "desc" }, { id: "asc" }],
      });
      // 09 §3.1 (S5): filter the sentinel out of the JOIN, not out of each read.
      // A ""-keyed booking must resolve to NO user, never to whichever ""-keyed
      // User row Object.fromEntries happened to land on. `null` keys stringify
      // to "null" in the dictionary and collide the same way (09 §1.2), so the
      // filter is on truthiness of the key, not on `!== ""`.
      //
      // Downstream `userDict[booking.userID]?.displayName` then yields
      // `undefined` — a visible blank, which 09 §0.3's ordering principle
      // prefers to a confident false success. Note this is NOT a fix for
      // Problem B (08 §0.1): an A-format legacy owner already renders blank
      // here and continues to.
      const userIDs = [...new Set(bookings.map((b) => b.userID))].filter(
        Boolean,
      );

      const users = await ctx.db.user.findMany({
        where: {
          userID: { in: userIDs },
        },
      });
      const userDict = Object.fromEntries(
        users
          .filter((u) => Boolean(u.userID))
          .map((u) => [
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
        facilities.map((f) => [f.facilityID, f.facilityName]),
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

      /* Resort after splitting multi-day bookings, which inserts rows out of
       * order.
       *
       * THE TIEBREAK MUST AGREE WITH THE CURSOR, and it did not: this sorted
       * `id` DESCENDING while the cursor selects `id: { gt: cursor.id }`, i.e.
       * ascending. `nextCursor` is taken from the LAST element of this array, so
       * with a descending tiebreak the cursor handed back the SMALLEST id in a
       * startTime group and the next page then asked for ids greater than it —
       * re-serving every other row in that group. Ties are common here because
       * hall bookings almost all start on the hour.
       *
       * Now: startTime descending, id ascending — the same sequence as the
       * `orderBy` above and the same one the cursor predicate cuts.
       */
      processedBookings.sort((a, b) => {
        if (b.startTime !== a.startTime) {
          return b.startTime - a.startTime;
        }
        return a.id.localeCompare(b.id);
      });

      const nextCursor =
        processedBookings.length === limit && processedBookings.length > 0
          ? {
              startTime:
                processedBookings[processedBookings.length - 1]!.startTime,
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
          //
          // 08 §1.1: `Boolean(callerUserID) &&` guards the same false match as
          // the two ownership checks below — without it a caller with an empty
          // canonical id matches every ""-keyed booking and is handed a
          // stranger's Telegram handle.
          userTeleHandle:
            Boolean(callerUserID) && booking.userID === callerUserID
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
    // 08 §1.1: an empty canonical id is not a filter, it is a match on every
    // ""-keyed row — so querying with it would return OTHER users' orphaned
    // bookings as if they were the caller's. An empty id owns nothing.
    if (!userID) return [];
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

  // Gated: a user without a matric on file cannot create bookings, even via a
  // hand-crafted API call that bypasses the client MatricGate (#login-gate).
  createBooking: matricProcedure
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
      //
      // I-11: evaluateBookingWithMode reads the SystemFlag kill switch, which
      // defaults to "off" — and "off" means LEGACY semantics, not blanket-allow.
      // With the flag unset this branch is byte-identical to the canBookFacility
      // call it replaces: empty/missing requiredRoles allows, a non-empty one is
      // still enforced with the admin bypass. Flipping the row to "enforce" is
      // what turns on D-1 default-deny, with no redeploy.
      //
      // The 4th argument is the VERIFIED session email, and it is what makes
      // repair-on-deny reachable. Omitting it silently downgrades a recoverable
      // NOT_RESIDENT into a hard denial.
      const decision = await evaluateBookingWithMode(
        ctx.db,
        userID,
        input.facilityID,
        ctx.session.user.email,
      );
      if (!decision.ok) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: denialMessage(decision),
        });
      }

      // C9. NOT a redundant guard and NOT a cast: `evaluateBookingWithMode`
      // already denies an absent identity with reason "NO_IDENTITY" in EVERY
      // mode (access.ts :433) — but that denial lives inside a callee, and no
      // type system does guard-dominance across a call boundary. So the
      // invariant that callee enforces is restated here where the compiler can
      // see it, immediately before `userID` is written into `Bookings.userID`.
      //
      // Unreachable in practice, and deliberately throws the IDENTICAL error
      // the callee would have produced, so even the impossible path is
      // behaviour-identical. Do NOT replace this with `identifiedProcedure`:
      // the callee's denial also writes the `booking.denied.no_identity` audit
      // row that 08 §2 uses to MEASURE the affected population, and narrowing
      // at the procedure boundary would silently stop producing it.
      if (userID === null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: denialMessage({
            ok: false,
            reason: "NO_IDENTITY",
            requiredRoles: [],
          }),
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
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Booking not found",
        });
      }

      // I-6, second and final call site — converted in the SAME commit as the
      // one in getBookings. A deprecated roles[0] shim left here would have
      // kept compiling and kept denying admin-held-second deletions.
      // Short-circuits on ownership, so the role read is skipped for the
      // overwhelmingly common self-delete.
      //
      // 08 §1.1: the `Boolean(callerUserID)` conjunct is load-bearing. A
      // non-NUS session carries `userID === ""`, and `"" === ""` makes a bare
      // equality check a FALSE MATCH against any ""-keyed booking row — i.e. it
      // would hand deletion of a stranger's row to an unattributable session.
      // An empty id owns nothing. (isAdmin("") is already false: getUserRoles
      // returns [] for a falsy id, so there is no bypass through the admin arm.)
      const callerUserID = ctx.session.user.userID;
      const owns = Boolean(callerUserID) && existing.userID === callerUserID;
      if (!owns && !(await isAdmin(ctx.db, callerUserID))) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only delete your own bookings.",
        });
      }

      return ctx.db.bookings.delete({ where: { id: input.id } });
    }),

  // matricProcedure, matching createBooking. An edit is a booking write, and
  // gating creation but not mutation left the matric gate trivially bypassable
  // by creating before the gate landed and editing afterwards.
  //
  // NOTE: unlike everything else in this file, this gate is NOT behind the
  // enforcement kill switch — see the handoff note. It affects only a caller
  // with no UserMatric row editing a pre-existing booking, who is routed to
  // /onboarding/matric rather than locked out.
  updateBooking: matricProcedure
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

      // Ensure user can only edit their own bookings. Was a bare `Error`, which
      // tRPC surfaces as INTERNAL_SERVER_ERROR — an authorization failure must
      // not be reported to the client as a server fault.
      //
      // 08 §1.1: same false-match guard as deleteBooking — pre-C9 `"" === ""`
      // would
      // otherwise make every ""-keyed booking editable by every empty-identity
      // session. An empty id owns nothing.
      const callerUserID = ctx.session?.user?.userID;
      if (!callerUserID || existingBooking.userID !== callerUserID) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only edit your own bookings.",
        });
      }

      // Re-check facility access when the times change. facilityID is not
      // editable, so this is not a cross-facility escalation — it closes the
      // hole where a user whose role was revoked (or a room that was newly
      // gated) could extend an existing booking indefinitely, since the only
      // access check used to live in createBooking.
      //
      // Same kill switch as createBooking: with the flag "off" this reduces to
      // today's legacy predicate, so it denies nobody who is not already denied
      // at create time.
      if (startTime !== undefined || endTime !== undefined) {
        const d = await evaluateBookingWithMode(
          ctx.db,
          ctx.session.user.userID,
          existingBooking.facilityID,
          ctx.session.user.email,
        );
        if (!d.ok) {
          throw new TRPCError({ code: "FORBIDDEN", message: denialMessage(d) });
        }
      }

      // If time is being updated, validate the new times
      const newStartTime = startTime ?? existingBooking.startTime;
      const newEndTime = endTime ?? existingBooking.endTime;

      // TRPCError, not a bare `Error`. This file already makes the argument one
      // guard up: tRPC surfaces a bare throw as INTERNAL_SERVER_ERROR, and a
      // rejected input must not be reported to the client as a server fault —
      // it also trips the `sanitizeErrors` middleware into logging a real
      // incident for what is a typo.
      if (newEndTime <= newStartTime) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "End time must be after start time",
        });
      }

      const timesChanged = startTime !== undefined || endTime !== undefined;

      // A pure metadata edit (rename, description) cannot create an overlap, so
      // it does not contend for the facility and does not pay for the lock.
      if (!timesChanged) {
        return ctx.db.bookings.update({
          where: { id },
          data: {
            ...(eventName !== undefined && { eventName }),
            ...(description !== undefined && { description }),
          },
        });
      }

      /* ---- THE CONFLICT CHECK AND THE WRITE MUST BE ONE CRITICAL SECTION ---
       * createBooking has held `withFacilityLock` since #11/#12; THIS PATH DID
       * NOT, and it is the same race with the same consequence. Read the
       * conflicting rows, decide, then update — with an await between each — so
       * two residents both moving a booking into the same free window each read
       * "no conflict" and both write. The room is then double-booked by two
       * people who each saw the app tell them it was free, which is the exact
       * outcome the lock on the create path exists to prevent.
       *
       * It is REACHABLE WITHOUT MALICE: the picker shows a free slot, two people
       * tap it at once, and neither is doing anything unusual. `forceBook` has
       * no equivalent here, so unlike createBooking there is not even a
       * deliberate override to explain the overlap afterwards.
       *
       * LOCKED ON `existingBooking.facilityID`, which is the right key and the
       * only available one: `facilityID` is not editable through this mutation
       * (see the access-recheck note above), so the booking cannot move between
       * facilities and one lock covers the whole operation. If facility changes
       * are ever added here, this becomes a TWO-lock problem — take them in a
       * deterministic order or it deadlocks.
       */
      return withFacilityLock(ctx.db, existingBooking.facilityID, async () => {
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
          throw new TRPCError({
            code: "CONFLICT",
            message: "Time conflicts with existing bookings",
          });
        }

        return ctx.db.bookings.update({
          where: { id },
          data: {
            ...(eventName !== undefined && { eventName }),
            ...(description !== undefined && { description }),
            ...(startTime !== undefined && { startTime }),
            ...(endTime !== undefined && { endTime }),
          },
        });
      });
    }),

  /* ======================================================================
   * RECURRING BOOKINGS
   *
   * Read src/lib/schemas/recurrence.ts before touching any of the three
   * procedures below — it holds the bounds, the expansion and the shared
   * validation, and it explains why the wire contract is a list of WINDOWS
   * rather than a rule.
   *
   * THE ONE THING NOT TO DO: do not implement recurrence by giving
   * `Bookings.repeat` meaning. Over 14,000 legacy rows carry non-zero values
   * that nothing has ever read; a reader that starts expanding them would
   * retroactively occupy rooms across the whole calendar. See the field's own
   * comment in schema.prisma. Occurrences are MATERIALISED — one row each,
   * sharing a `seriesID` — so every existing reader works on a series unchanged.
   * ====================================================================== */

  /**
   * DRY RUN. Which occurrences are free, and what takes the ones that are not.
   *
   * A QUERY, AND IT WRITES NOTHING. This is the whole UX of the feature: the
   * head sees all 15 Thursdays with their status and decides, rather than
   * discovering on week 7 that the series is full of holes.
   *
   * It deliberately does NOT hold the facility lock. A preview is advisory by
   * construction (I-7) — the window it reports can be taken a second later, and
   * `createSeries` re-checks every occurrence under the lock before writing.
   * Locking a facility for as long as someone reads a form would be a denial of
   * service dressed up as correctness.
   *
   * The access decision is evaluated ONCE, not per occurrence: `facilityID` is
   * fixed for the series, and `evaluateBookingWithMode` answers a question about
   * the caller and the room, not about the time.
   */
  previewSeries: seriesProcedure
    .input(
      z.object({
        facilityID: z.number().int(),
        windows: z.array(seriesWindowSchema),
      }),
    )
    .query(async ({ ctx, input }) => {
      const shapeError = validateSeriesWindows(input.windows);
      if (shapeError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: shapeError });
      }

      const decision = await evaluateBookingWithMode(
        ctx.db,
        ctx.session.user.userID,
        input.facilityID,
        ctx.session.user.email,
      );
      if (!decision.ok) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: denialMessage(decision),
        });
      }

      // ONE query for the whole series rather than one per occurrence. The
      // series spans at most 26 weeks, so the outer bound is a single indexed
      // range read on (facilityID, startTime, endTime); filtering the
      // occurrences against it in memory is far cheaper than 26 round trips,
      // and — unlike 26 sequential reads — it sees a consistent snapshot.
      const first = input.windows[0]!;
      const last = input.windows[input.windows.length - 1]!;
      const candidates = await ctx.db.bookings.findMany({
        where: {
          facilityID: input.facilityID,
          startTime: { lt: last.endTime },
          endTime: { gt: first.startTime },
        },
        select: { startTime: true, endTime: true, eventName: true },
        orderBy: { startTime: "asc" },
      });

      const occurrences = input.windows.map((w) => {
        // Half-open overlap, identical to findFacilityConflict and every other
        // overlap test in this file: a booking ending exactly when this window
        // starts does not take the room.
        const clash = candidates.find(
          (c) => c.startTime < w.endTime && c.endTime > w.startTime,
        );
        return {
          startTime: w.startTime,
          endTime: w.endTime,
          available: clash === undefined,
          conflict: clash
            ? {
                startTime: clash.startTime,
                endTime: clash.endTime,
                eventName: clash.eventName,
              }
            : null,
        };
      });

      return {
        occurrences,
        freeCount: occurrences.filter((o) => o.available).length,
        clashCount: occurrences.filter((o) => !o.available).length,
        maxOccurrences: SERIES_MAX_OCCURRENCES,
      };
    }),

  /**
   * COMMIT. Writes the free occurrences of a series as one unit.
   *
   * `skipConflicts` IS REQUIRED FROM THE CLIENT AND HAS NO DEFAULT, deliberately.
   * The preview has already told the head exactly which weeks clash; this flag is
   * their answer to it. Defaulting it either way would turn a decision they were
   * shown into one the server made for them — silently dropping weeks they
   * expected to get, or refusing a series they had already accepted was partial.
   */
  createSeries: seriesProcedure
    .input(
      z.object({
        facilityID: z.number().int(),
        ccaID: z.number().int(),
        eventName: z.string().min(1),
        description: z.string().optional(),
        windows: z.array(seriesWindowSchema),
        skipConflicts: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const shapeError = validateSeriesWindows(input.windows);
      if (shapeError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: shapeError });
      }

      const userID = ctx.session.user.userID;

      const decision = await evaluateBookingWithMode(
        ctx.db,
        userID,
        input.facilityID,
        ctx.session.user.email,
      );
      if (!decision.ok) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: denialMessage(decision),
        });
      }

      // C9, the same restatement createBooking makes: evaluateBookingWithMode
      // already denies an absent identity with NO_IDENTITY in every mode, but
      // that denial lives in a callee and no type system carries guard dominance
      // across a call boundary. Restated where the compiler can see it,
      // immediately before `userID` is written into `Bookings.userID`.
      if (userID === null) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: denialMessage({
            ok: false,
            reason: "NO_IDENTITY",
            requiredRoles: [],
          }),
        });
      }

      /* EVERY CONFLICT CHECK AND EVERY INSERT INSIDE ONE LOCK HOLD.
       *
       * Checking per occurrence and then writing per occurrence WITHOUT the lock
       * is the same read-then-write race createBooking has held this lock against
       * since #11/#12, multiplied by the length of the series: another resident
       * can take week 5 in the gap between this call checking it and writing it,
       * and the series double-books a room that the preview, the re-check and the
       * confirmation all called free.
       *
       * The cost of holding it is bounded by SERIES_MAX_OCCURRENCES and by the
       * three round trips inside: one read, one id allocation, one createMany.
       */
      return withFacilityLock(ctx.db, input.facilityID, async () => {
        const first = input.windows[0]!;
        const last = input.windows[input.windows.length - 1]!;
        const existing = await ctx.db.bookings.findMany({
          where: {
            facilityID: input.facilityID,
            startTime: { lt: last.endTime },
            endTime: { gt: first.startTime },
          },
          select: { startTime: true, endTime: true },
        });

        const free: SeriesWindow[] = [];
        const skipped: SeriesWindow[] = [];
        for (const w of input.windows) {
          const clashes = existing.some(
            (c) => c.startTime < w.endTime && c.endTime > w.startTime,
          );
          (clashes ? skipped : free).push(w);
        }

        if (skipped.length > 0 && !input.skipConflicts) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              skipped.length === input.windows.length
                ? "Every session in that series is already taken."
                : `${skipped.length} of ${input.windows.length} sessions are already taken.`,
          });
        }

        if (free.length === 0) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Every session in that series is already taken.",
          });
        }

        // One id per row, in one allocation rather than one round trip each.
        const ids = await nextBookingIdBlock(ctx.db, free.length);

        // THE SERIES KEY. A uuid rather than a counter: it needs to be unique,
        // not ordered, and a counter would be a third shared sequence to contend
        // on inside a lock that is already the bottleneck.
        const seriesID = randomUUID();

        await ctx.db.bookings.createMany({
          data: free.map((w, i) => ({
            bookingID: ids[i]!,
            eventName: input.eventName,
            description: input.description,
            startTime: w.startTime,
            endTime: w.endTime,
            facilityID: input.facilityID,
            userID,
            ccaID: input.ccaID,
            seriesID,
            // `repeat` and `bookUntil` are DELIBERATELY NOT WRITTEN. They are
            // legacy write-only columns and this feature does not revive them —
            // see the note on those fields in schema.prisma.
            forceBook: false,
          })),
        });

        return {
          seriesID,
          created: free.length,
          skipped: skipped.length,
          skippedWindows: skipped,
        };
      });
    }),

  /**
   * Cancel a series, or the tail of one.
   *
   * `fromTime` is what makes "this and all future sessions" expressible without
   * a second procedure: omit it to drop the whole series, pass an occurrence's
   * startTime to drop that one and everything after it. Cancelling a SINGLE
   * middle occurrence is just `deleteBooking` on that row, which already works
   * and already carries its own ownership check — a series row is an ordinary
   * booking in every other respect.
   *
   * OWNERSHIP IS CHECKED ON THE ROWS, NOT ON THE KEY. A `seriesID` is a uuid the
   * client hands us; it proves nothing. The delete is scoped by `userID` in the
   * same `where` clause as the seriesID, so a caller can only ever remove their
   * own rows even if they guess or copy someone else's key — and an admin gets
   * the same override they already have on `deleteBooking`.
   */
  deleteSeries: protectedProcedure
    .input(
      z.object({
        seriesID: z.string().min(1),
        fromTime: z.number().int().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const callerUserID = ctx.session.user.userID;
      // 08 §1.1: an empty canonical id owns nothing. Without this a ""-keyed
      // session would match every ""-keyed row in the series scope.
      if (!callerUserID) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only cancel your own bookings.",
        });
      }

      const admin = await isAdmin(ctx.db, callerUserID);

      const { count } = await ctx.db.bookings.deleteMany({
        where: {
          seriesID: input.seriesID,
          ...(admin ? {} : { userID: callerUserID }),
          ...(input.fromTime !== undefined
            ? { startTime: { gte: input.fromTime } }
            : {}),
        },
      });

      // NOT_FOUND rather than a silent zero: a "cancel" that reports success
      // while removing nothing is the same class of silent failure as the
      // booking modal's dead Confirm button. It is not an ownership oracle
      // either — the message is identical whether the series does not exist or
      // belongs to somebody else.
      if (count === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No bookings from that series were found.",
        });
      }

      return { cancelled: count };
    }),
});
