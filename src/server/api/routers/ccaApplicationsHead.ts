import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { createTRPCRouter, identifiedProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { writeAudit } from "~/server/api/routers/admin";
import { addCcaMember, membershipKeysFor } from "~/server/api/services/ccaMembers";
import {
  assertApplicationsEnabled,
  nextCounter,
  occupancyBySlot,
  slotCapacity,
  SLOT_COUNTER_KEY,
  withCcaLock,
} from "~/server/api/services/ccaApplications";
import {
  assertRecruitmentOpen,
  isRecruitmentOpen,
} from "~/server/api/services/ccaRecruitment";
import {
  findFacilityConflict,
  nextBookingId,
  resolveFacility,
  withFacilityLock,
} from "~/server/api/services/booking";
import {
  addNoteInput,
  cancelSlotInput,
  ccaTargetInput,
  decisionInput,
  editSlotInput,
  headApplicationInput,
  isTerminalStatus,
  listApplicationsInput,
  openSlotsInput,
} from "~/lib/schemas/ccaApplication";
import { canonicalUserID } from "~/lib/identity";

/**
 * CCA-head-facing side of the applications workflow: review the queue, open and
 * cancel interview slots, record interview notes, and accept/reject.
 *
 * THE ONE RULE, identical to cca.ts: every procedure takes `input.ccaID` from
 * the client and MUST call assertHeadsCca before touching CCA-scoped data — the
 * builder only narrows identity. `roles` for that call is ALWAYS a live
 * getUserRoles() read (I-5), never session.user.roles. And every procedure
 * asserts cca.applications.enabled first: the surface is inert until the switch
 * is on.
 *
 * Acceptance ends in the exact `UserCCA.create({ ccaID, userID })` write that
 * ccaAdmin.addMember performs (canonical key, deduped against both key formats),
 * because "make this resident a member" is a single membership row and that is
 * the only writer of one.
 */

/**
 * Everything the head surfaces know about an applicant. Resolved from User +
 * UserMatric; any field can be null for an unresolved/partial account (rendered
 * as "—" in the UI, never dropped).
 */
export type Applicant = {
  displayName: string | null;
  email: string | null;
  matric: string | null;
  telegramHandle: string | null;
  block: number | null;
  bio: string | null;
};

const EMPTY_APPLICANT: Applicant = {
  displayName: null,
  email: null,
  matric: null,
  telegramHandle: null,
  block: null,
  bio: null,
};

/**
 * Resolve canonical applicant ids to their profile details. Same approach as
 * cca.listHeads (no reverse canonical→User query, so guess the email AND match
 * the stored key), plus the matric from UserMatric. Selects profile fields
 * EXPLICITLY — never a bare User read (passwordHash must not leave the server,
 * and a Google-adapter row missing it throws on deserialization, I-2).
 */
async function resolveApplicants(
  db: PrismaClient,
  userIDs: readonly string[],
): Promise<Map<string, Applicant>> {
  const keys = [...new Set(userIDs)];
  const out = new Map<string, Applicant>();
  if (keys.length === 0) return out;

  const guessedEmails = keys.map((k) => `${k.toLowerCase()}@u.nus.edu`);
  const profileSelect = {
    email: true,
    displayName: true,
    userID: true,
    telegramHandle: true,
    block: true,
    bio: true,
  } as const;
  const [byEmail, byStored, matrics] = await Promise.all([
    db.user.findMany({
      where: { email: { in: guessedEmails, mode: "insensitive" } },
      select: profileSelect,
    }),
    db.user.findMany({
      where: { userID: { in: keys } },
      select: profileSelect,
    }),
    db.userMatric.findMany({
      where: { userID: { in: keys } },
      select: { userID: true, matric: true },
    }),
  ]);

  const matricByKey = new Map(matrics.map((m) => [m.userID, m.matric]));
  type Row = (typeof byEmail)[number];
  const set = (key: string, u: Row) => {
    if (!out.has(key)) {
      out.set(key, {
        displayName: u.displayName,
        email: u.email,
        matric: matricByKey.get(key) ?? null,
        telegramHandle: u.telegramHandle,
        block: u.block,
        bio: u.bio,
      });
    }
  };
  for (const u of byEmail) {
    const cid = canonicalUserID(u.email);
    if (cid) set(cid, u);
  }
  for (const u of byStored) {
    if (u.userID) set(u.userID, u);
  }
  // Ensure every requested key is present, even if unresolved (amber in the UI).
  for (const k of keys) {
    if (!out.has(k)) {
      out.set(k, { ...EMPTY_APPLICANT, matric: matricByKey.get(k) ?? null });
    }
  }
  return out;
}

/** Half-open overlap: two intervals collide iff aStart < bEnd AND bStart < aEnd. */
function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Bring the facility bookings back in line with the slots that are still live.
 *
 * ONE booking covers a whole generated window, so several slots share a
 * bookingID. Call this AFTER the slots have been marked canceled, with the
 * bookingIDs those slots carried. Two outcomes per booking:
 *
 *  - NOTHING left on it → delete it. The room must be freed exactly when the
 *    LAST live slot goes away, never on the first cancel.
 *  - SOMETHING left → shrink it to the span the survivors actually need. A head
 *    who opens 2–5pm and then cancels the last six slots was holding the room
 *    until 5pm for interviews that are off; nobody else could book it and
 *    nothing on screen said why.
 *
 * Cancelling a slot in the MIDDLE recomputes to the same span and writes
 * nothing — the hold is one contiguous block and cannot be given back in
 * pieces, so an interview at each end still needs the room in between.
 *
 * Shrinking NEVER needs a fresh clash check: updateSlot refuses to move a slot
 * outside its booking (OUTSIDE_BOOKING), so every live slot is already inside
 * the old window and the new span is a subset of a hold this CCA already owns.
 * Growing would be a different matter, and is not something this can do.
 *
 * BEST-EFFORT, like the event-rejection path: a booking that has already been
 * deleted (by hand, on the bookings page) is not an error, and a failure here
 * must not roll back a cancel the head has already been told happened. The worst
 * case is a stale hold on a room, which a human can delete; the alternative —
 * failing the cancel — leaves applicants booked into an interview that is off.
 *
 * `canceledAt` is filtered in JS, not the query: `{ canceledAt: null }` misses
 * ABSENT fields on Prisma+Mongo, which would make a live slot invisible here and
 * free a room that is still in use. Same trap as listSlots.
 */
async function reconcileSlotBookings(
  db: PrismaClient,
  ccaID: number,
  bookingIDs: readonly number[],
): Promise<{ released: number[]; resized: number[] }> {
  const ids = [...new Set(bookingIDs.filter((b): b is number => b !== null))];
  const released: number[] = [];
  const resized: number[] = [];
  for (const bookingID of ids) {
    try {
      const holders = (
        await db.ccaInterviewSlot.findMany({
          where: { ccaID, bookingID },
          select: {
            slotID: true,
            startTime: true,
            endTime: true,
            canceledAt: true,
          },
        })
      ).filter((s) => s.canceledAt === null);

      if (holders.length === 0) {
        await db.bookings.deleteMany({ where: { bookingID } });
        released.push(bookingID);
        continue;
      }

      // A live slot with no times cannot be covered by a computed span, and
      // shrinking around it could pull the room out from under a real
      // interview. Leave the booking exactly as it is — an oversized hold is
      // recoverable, an undersized one is not.
      if (holders.some((s) => s.startTime === null || s.endTime === null)) {
        continue;
      }
      const start = Math.min(...holders.map((s) => s.startTime!));
      const end = Math.max(...holders.map((s) => s.endTime!));

      const booking = await db.bookings.findUnique({
        where: { bookingID },
        select: { startTime: true, endTime: true },
      });
      // Already gone, or already the right size — nothing to write. The
      // equality check is what makes a middle cancel a no-op.
      if (!booking || (booking.startTime === start && booking.endTime === end)) {
        continue;
      }
      // SHRINK ONLY. A slot sitting outside its own booking should be
      // impossible (OUTSIDE_BOOKING), but a row written before that rule
      // existed would compute a WIDER span — and widening a room hold without
      // re-running the clash check is how you double-book a facility. Leave it
      // and say so, rather than quietly taking time this CCA has not claimed.
      if (start < booking.startTime || end > booking.endTime) {
        console.error(
          JSON.stringify({
            evt: "interview_slot_booking_would_grow",
            ccaID,
            bookingID,
            bookingStart: booking.startTime,
            bookingEnd: booking.endTime,
            slotSpanStart: start,
            slotSpanEnd: end,
          }),
        );
        continue;
      }
      await db.bookings.update({
        where: { bookingID },
        data: { startTime: start, endTime: end },
      });
      resized.push(bookingID);
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "interview_slot_booking_reconcile_failed",
          ccaID,
          bookingID,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return { released, resized };
}

export const ccaApplicationsHeadRouter = createTRPCRouter({
  /** The review queue for one CCA, optionally filtered by status. */
  listApplications: identifiedProcedure
    .input(listApplicationsInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const apps = await ctx.db.ccaApplication.findMany({
        where: {
          ccaID: input.ccaID,
          ...(input.status ? { status: input.status } : {}),
        },
        select: {
          applicationID: true,
          userID: true,
          status: true,
          notes: true,
          interviewSlotID: true,
          createdAt: true,
          decidedAt: true,
          decisionReason: true,
        },
        orderBy: { applicationID: "desc" },
      });

      const [people, slots, recruitmentOpen] = await Promise.all([
        resolveApplicants(ctx.db, apps.map((a) => a.userID)),
        (async () => {
          const slotIDs = apps
            .map((a) => a.interviewSlotID)
            .filter((s): s is number => s !== null);
          // slotID is IN the value, not just the key: the run-sheet groups
          // applicants by the slot they share, and it needs something to group
          // on. `capacity` rides along for the "3 of 4 seats" header.
          type SlotRow = {
            slotID: number;
            startTime: number | null;
            endTime: number | null;
            location: string | null;
            capacity: number | null;
          };
          if (slotIDs.length === 0) return new Map<number, SlotRow>();
          const rows = await ctx.db.ccaInterviewSlot.findMany({
            where: { slotID: { in: slotIDs } },
            select: {
              slotID: true,
              startTime: true,
              endTime: true,
              location: true,
              capacity: true,
            },
          });
          return new Map<number, SlotRow>(rows.map((r) => [r.slotID, r]));
        })(),
        // The hall-wide freeze, for the review screen's Accept button and its
        // banner. COSMETIC and allowed to be up to 15s stale â€” the boundary is
        // the assertRecruitmentOpen inside `decide`'s accepted branch, and a
        // head who clicks Accept in that window gets RECRUITMENT_CLOSED, which
        // is why that error's copy is written as an explanation rather than a
        // scold.
        isRecruitmentOpen(ctx.db),
      ]);

      return {
        applications: apps.map((a) => ({
          applicationID: a.applicationID,
          userID: a.userID,
          status: a.status,
          notes: a.notes,
          createdAt: a.createdAt,
          decidedAt: a.decidedAt,
          decisionReason: a.decisionReason,
          applicant: people.get(a.userID) ?? EMPTY_APPLICANT,
          slot: (() => {
            if (a.interviewSlotID === null) return null;
            const s = slots.get(a.interviewSlotID);
            // Normalised HERE so no client ever sees a raw `capacity: null` and
            // has to know that absent means 1.
            return s ? { ...s, capacity: slotCapacity(s.capacity) } : null;
          })(),
        })),
        recruitmentOpen,
      };
    }),

  /** One application in full — for the head to read DURING the interview. */
  getApplication: identifiedProcedure
    .input(headApplicationInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const app = await ctx.db.ccaApplication.findUnique({
        where: { applicationID: input.applicationID },
        select: {
          applicationID: true,
          ccaID: true,
          userID: true,
          status: true,
          notes: true,
          interviewSlotID: true,
          createdAt: true,
          decidedAt: true,
          decidedBy: true,
          decisionReason: true,
        },
      });
      // ccaID from the row must match the authorised scope — an applicationID
      // from another CCA is NOT_FOUND to a head who does not head that CCA.
      if (!app || app.ccaID !== input.ccaID) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "NO_SUCH_APPLICATION",
        });
      }

      const [people, notes, slot] = await Promise.all([
        resolveApplicants(ctx.db, [app.userID]),
        ctx.db.ccaInterviewNote.findMany({
          where: { applicationID: app.applicationID },
          select: {
            id: true,
            authorUserID: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        app.interviewSlotID !== null
          ? ctx.db.ccaInterviewSlot.findUnique({
              where: { slotID: app.interviewSlotID },
              select: {
                slotID: true,
                startTime: true,
                endTime: true,
                location: true,
              },
            })
          : Promise.resolve(null),
      ]);

      const authors = await resolveApplicants(
        ctx.db,
        notes.map((n) => n.authorUserID).filter((a): a is string => a !== null),
      );

      return {
        // ...app carries the APPLICANT's own `notes` string. The interview
        // notes are a separate array under `interviewNotes` so the two never
        // collide (an earlier version overwrote `notes` and lost the applicant
        // text).
        ...app,
        applicant: people.get(app.userID) ?? EMPTY_APPLICANT,
        slot,
        interviewNotes: notes.map((n) => ({
          id: n.id,
          body: n.body,
          createdAt: n.createdAt,
          authorUserID: n.authorUserID,
          authorName:
            (n.authorUserID && authors.get(n.authorUserID)?.displayName) ||
            n.authorUserID ||
            null,
        })),
      };
    }),

  /**
   * All interview slots for a CCA with their occupants — the head's calendar.
   *
   * Occupancy is DERIVED from the applications that point at each slot, so this
   * reads the applications rather than the slot row. The head (unlike a
   * resident) gets the roster, not just a count: running a group interview means
   * knowing who is in the room.
   */
  listSlots: identifiedProcedure
    .input(ccaTargetInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      // NOTE: do NOT filter `canceledAt: null` in the query. A slot created
      // before this field was written explicitly has canceledAt ABSENT, and
      // Prisma+Mongo's `{ canceledAt: null }` matches a stored null but NOT an
      // absent field — so that filter silently hides every open slot. Prisma
      // deserializes an absent optional scalar as null, so filtering in JS on
      // `s.canceledAt === null` catches both the absent and the null case.
      const [all, claims] = await Promise.all([
        ctx.db.ccaInterviewSlot.findMany({
          where: { ccaID: input.ccaID },
          select: {
            slotID: true,
            startTime: true,
            endTime: true,
            location: true,
            capacity: true,
            facilityID: true,
            bookingID: true,
            canceledAt: true,
          },
          orderBy: { startTime: "asc" },
        }),
        // A HEAD-ONLY read, deliberately NOT occupancyBySlot(): that helper
        // projects interviewSlotID alone because it also runs on resident
        // paths. Here the extra fields are the point, and one query gives both
        // the counts and the roster.
        ctx.db.ccaApplication.findMany({
          where: { ccaID: input.ccaID },
          select: {
            applicationID: true,
            userID: true,
            status: true,
            interviewSlotID: true,
          },
          orderBy: { applicationID: "asc" },
        }),
      ]);
      const slots = all.filter((s) => s.canceledAt === null);

      // Group the claims by slot. `interviewSlotID` is tested in JS for the
      // same absent-vs-null reason as canceledAt above.
      const bySlot = new Map<number, typeof claims>();
      for (const c of claims) {
        if (c.interviewSlotID === null) continue;
        const arr = bySlot.get(c.interviewSlotID) ?? [];
        arr.push(c);
        bySlot.set(c.interviewSlotID, arr);
      }
      // The rooms held for these slots. Sent so the head's edit form can say
      // WHICH window is held ("2:00–5:00 PM") instead of refusing a move with a
      // bare error — and so a hold deleted by hand on the bookings page shows up
      // here as `booking: null` rather than as a silent claim to a room nobody
      // has any more.
      const bookingIDs = [
        ...new Set(
          slots
            .map((s) => s.bookingID)
            .filter((b): b is number => b !== null && b !== undefined),
        ),
      ];
      const [people, bookings] = await Promise.all([
        resolveApplicants(
          ctx.db,
          slots.flatMap((s) => (bySlot.get(s.slotID) ?? []).map((c) => c.userID)),
        ),
        bookingIDs.length > 0
          ? ctx.db.bookings.findMany({
              where: { bookingID: { in: bookingIDs } },
              select: { bookingID: true, startTime: true, endTime: true },
            })
          : Promise.resolve([]),
      ]);
      const bookingByID = new Map(bookings.map((b) => [b.bookingID, b]));

      return {
        slots: slots.map((s) => {
          const occupants = bySlot.get(s.slotID) ?? [];
          return {
            slotID: s.slotID,
            startTime: s.startTime,
            endTime: s.endTime,
            location: s.location,
            facilityID: s.facilityID,
            booking:
              s.bookingID != null
                ? (bookingByID.get(s.bookingID) ?? null)
                : null,
            canceledAt: s.canceledAt,
            capacity: slotCapacity(s.capacity),
            occupancy: occupants.length,
            occupants: occupants.map((c) => ({
              applicationID: c.applicationID,
              userID: c.userID,
              status: c.status,
              applicant: people.get(c.userID) ?? EMPTY_APPLICANT,
            })),
          };
        }),
      };
    }),

  /**
   * Open one or more interview slots. Rejects a slot in the past, a zero/negative
   * duration (the schema already blocks end<=start), or one overlapping an
   * existing open slot OR another slot in the same batch.
   *
   * FACILITY. When `facilityID` is given the room is BOOKED HERE, at open time —
   * this is the answer to "when does it auto-book?", and it is deliberately
   * different from events (which book on JCRC approval, because an event is a
   * proposal until then). A head opening interview slots is already authorised;
   * there is nothing left to approve, and a room that is only held once someone
   * books a slot is a room that can be taken from under the whole schedule.
   *
   * ONE booking spans the whole window (first start → last end), not one per
   * slot: the head needs the room for the session, and fifty rows in the
   * facility calendar for one afternoon helps nobody. A clash REFUSES the entire
   * batch — unlike the events path, which flags and carries on, because there is
   * no approval step here to review the flag, and half-opening a schedule into a
   * room someone else has is worse than opening nothing.
   *
   * The facility ROLE gate (getBookableFacilityMap) is intentionally not applied:
   * heading a CCA that is running interviews IS the authorization, exactly as
   * JCRC approval is on the events path. The physical time-conflict check is
   * kept, because two groups cannot share a room whatever their roles say.
   */
  openSlots: identifiedProcedure
    .input(openSlotsInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);
      const now = Math.floor(Date.now() / 1000);

      if (input.slots.some((s) => s.endTime <= now)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "SLOT_IN_PAST" });
      }

      // Serialize per-CCA so two concurrent "open" requests (a double-click, or
      // two heads at once) cannot both pass the duplicate/overlap check and then
      // both insert the same slots — the check-then-create must be atomic. Same
      // lock the booking and decide paths use.
      return withCcaLock(ctx.db, input.ccaID, async () => {
        // Existing NON-canceled slots. canceledAt is filtered in JS, not the
        // query: `canceledAt: null` misses absent-field slots (Prisma+Mongo), so
        // a DB filter would let the check skip them. See the note in listSlots.
        const existing = (
          await ctx.db.ccaInterviewSlot.findMany({
            where: { ccaID: input.ccaID },
            select: { startTime: true, endTime: true, canceledAt: true },
          })
        ).filter((e) => e.canceledAt === null);

        const sameTime = (
          a: { startTime: number | null; endTime: number | null },
          b: { startTime: number; endTime: number },
        ) => a.startTime === b.startTime && a.endTime === b.endTime;

        // Validate every incoming slot against the existing ones AND against the
        // slots earlier in this same batch. An exact DUPLICATE (identical
        // start+end) is reported distinctly from a partial OVERLAP so the head
        // gets a clear "already opened" message.
        const accepted: { startTime: number; endTime: number }[] = [];
        for (const s of input.slots) {
          if (existing.some((e) => sameTime(e, s)) || accepted.some((e) => sameTime(e, s))) {
            throw new TRPCError({ code: "CONFLICT", message: "DUPLICATE_SLOT" });
          }
          const clash =
            existing.some(
              (e) =>
                e.startTime !== null &&
                e.endTime !== null &&
                overlaps(s.startTime, s.endTime, e.startTime, e.endTime),
            ) ||
            accepted.some((e) =>
              overlaps(s.startTime, s.endTime, e.startTime, e.endTime),
            );
          if (clash) {
            throw new TRPCError({ code: "CONFLICT", message: "SLOT_OVERLAP" });
          }
          accepted.push({ startTime: s.startTime, endTime: s.endTime });
        }

        // Hold the room BEFORE writing any slot, so a clash leaves nothing
        // behind. The window is the whole batch: first start → last end.
        const facility =
          input.facilityID != null
            ? await resolveFacility(ctx.db, input.facilityID)
            : null;
        let bookingID: number | null = null;
        if (facility) {
          const windowStart = Math.min(...input.slots.map((s) => s.startTime));
          const windowEnd = Math.max(...input.slots.map((s) => s.endTime));
          const cca = await ctx.db.cCA.findUnique({
            where: { ccaID: input.ccaID },
            select: { ccaName: true },
          });
          // Nested INSIDE withCcaLock. The two locks are on disjoint keyspaces
          // (`cca:` vs `facility:`) and are always taken in this order, so they
          // cannot deadlock against each other.
          bookingID = await withFacilityLock(
            ctx.db,
            facility.facilityID,
            async () => {
              const clash = await findFacilityConflict(
                ctx.db,
                facility.facilityID,
                windowStart,
                windowEnd,
              );
              if (clash) {
                // Times ride in the message so the head is told WHEN the room is
                // taken and can move the window, instead of "it didn't work".
                throw new TRPCError({
                  code: "CONFLICT",
                  message: `FACILITY_BOOKED:${clash.startTime}:${clash.endTime}`,
                });
              }
              const id = await nextBookingId(ctx.db);
              await ctx.db.bookings.create({
                data: {
                  bookingID: id,
                  ccaID: input.ccaID,
                  facilityID: facility.facilityID,
                  startTime: windowStart,
                  endTime: windowEnd,
                  userID,
                  eventName: `${cca?.ccaName ?? `CCA #${input.ccaID}`} interviews`,
                  description: `Auto-booked for ${input.slots.length} interview slot(s)`,
                },
              });
              return id;
            },
          );
        }

        const batchId = randomUUID();
        const created: number[] = [];
        try {
          for (const s of input.slots) {
            const slotID = await nextCounter(ctx.db, SLOT_COUNTER_KEY);
            await ctx.db.ccaInterviewSlot.create({
              data: {
                slotID,
                ccaID: input.ccaID,
                startTime: s.startTime,
                endTime: s.endTime,
                // A facility wins over any free text on the draft: `location`
                // is the DENORMALIZED name, so every reader (the resident slot
                // list, the run-sheet) renders the room with no join.
                location: facility ? facility.name : (s.location ?? null),
                createdBy: userID,
                createdAt: new Date(),
                // EXPLICIT, never absent — Prisma+Mongo's null filter does not
                // match an absent field, and `capacity` is written as a real
                // number for the same reason: a row whose capacity is absent
                // reads back as null and only survives because slotCapacity()
                // normalises it. New rows should not need that rescue.
                capacity: s.capacity,
                facilityID: facility ? facility.facilityID : null,
                bookingID,
                canceledAt: null,
              },
            });
            created.push(slotID);
          }
        } catch (err) {
          // Never leave a room held for slots that do not exist. The slots
          // written before the failure are canceled too, so the batch is
          // all-or-nothing from the head's point of view.
          if (created.length > 0) {
            await ctx.db.ccaInterviewSlot.updateMany({
              where: { slotID: { in: created } },
              data: { canceledAt: new Date() },
            });
          }
          if (bookingID !== null) {
            await ctx.db.bookings
              .deleteMany({ where: { bookingID } })
              .catch(() => undefined);
          }
          throw err;
        }

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.open",
          batchId,
          // The capacity is in the audit line because "we opened 20 slots" and
          // "we opened 20 slots for 6 people each" are very different decisions
          // to have to reconstruct later. The room and its booking are there for
          // the same reason: a held facility is a physical claim, and it must be
          // attributable to the head who made it.
          reason: `${scope.via}: opened ${created.length} slot(s), ${
            input.slots.reduce((n, s) => n + s.capacity, 0)
          } seat(s)${
            facility
              ? ` in ${facility.name} (booking #${bookingID})`
              : ""
          }`,
        });

        return {
          ccaID: input.ccaID,
          opened: created.length,
          slotIDs: created,
          bookingID,
        };
      });
    }),

  /**
   * Edit a slot's time, location and/or capacity.
   *
   * MOVING an OCCUPIED slot is refused — changing the time out from under
   * applicants who already claimed it would silently move their interview; the
   * head must cancel it (which reverts every occupant) and open a new one.
   * That is unchanged from the single-seat rule, just counted instead of
   * boolean.
   *
   * CAPACITY is different, and is allowed on an occupied slot: raising it
   * re-opens a full slot immediately, which is the whole point of the field.
   * Lowering it below the seats already taken is refused
   * (CAPACITY_BELOW_OCCUPANCY) — an edit never evicts anyone, and picking WHO
   * to evict is not a decision a number in a form should make. So the guard is
   * "unchanged time/location" rather than "unoccupied": a capacity-only save on
   * an occupied slot sends the same start/end back and passes.
   */
  updateSlot: identifiedProcedure
    .input(editSlotInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const slot = await ctx.db.ccaInterviewSlot.findUnique({
          where: { slotID: input.slotID },
          select: {
            slotID: true,
            ccaID: true,
            startTime: true,
            endTime: true,
            location: true,
            capacity: true,
            facilityID: true,
            bookingID: true,
            canceledAt: true,
          },
        });
        if (!slot || slot.ccaID !== input.ccaID || slot.canceledAt !== null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_SLOT" });
        }

        // Counted INSIDE the lock, like every other check-then-write here: a
        // capacity read outside it could be lowered onto an occupant who booked
        // in between.
        const occupancy =
          (await occupancyBySlot(ctx.db, input.ccaID)).get(input.slotID) ?? 0;
        const nextLocation = input.location ?? null;
        // "" and null are the SAME location. The client sends `trim() ||
        // undefined`, so a cleared box arrives as undefined -> null; treating a
        // stored "" as different would make a capacity-only save on an occupied
        // slot look like a move and be refused.
        const moved =
          input.startTime !== slot.startTime ||
          input.endTime !== slot.endTime ||
          (nextLocation ?? "") !== (slot.location ?? "");
        if (occupancy > 0 && moved) {
          throw new TRPCError({ code: "CONFLICT", message: "SLOT_BOOKED" });
        }
        if (input.capacity !== undefined && input.capacity < occupancy) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "CAPACITY_BELOW_OCCUPANCY",
          });
        }

        const now = Math.floor(Date.now() / 1000);
        if (input.endTime <= now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "SLOT_IN_PAST" });
        }

        // A slot in a booked room may be nudged WITHIN the window that was held
        // for it, but never outside it and never renamed.
        //
        // The room is held once for a whole batch, so several slots share this
        // booking: growing it for one of them could clash with another CCA, and
        // shrinking it would hand away time the sibling slots are still using.
        // Changing the ROOM is likewise a cancel-and-reopen, not an edit — the
        // same rule the time already follows on an occupied slot. The alternative
        // (re-booking per edited slot) fragments one afternoon's hold into a
        // dozen rows and has to reason about a slot conflicting with its own
        // batch's booking.
        if (slot.facilityID != null) {
          if ((nextLocation ?? "") !== (slot.location ?? "")) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "FACILITY_LOCATION_LOCKED",
            });
          }
          const held =
            slot.bookingID != null
              ? await ctx.db.bookings.findUnique({
                  where: { bookingID: slot.bookingID },
                  select: { startTime: true, endTime: true },
                })
              : null;
          if (
            held &&
            (input.startTime < held.startTime || input.endTime > held.endTime)
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `OUTSIDE_BOOKING:${held.startTime}:${held.endTime}`,
            });
          }
        }

        // Overlap against every OTHER non-canceled slot for this CCA.
        //
        // canceledAt is filtered in JS, NOT in the query. `{ canceledAt: null }`
        // matches a stored null but NOT an ABSENT field (Prisma+Mongo), and 4 of
        // the 34 production slots have it absent — those were invisible to this
        // check, so an edit that overlapped one of them was accepted while
        // openSlots (which already filters in JS) would have refused the same
        // times. Every sibling site in this file does it this way; this one was
        // the outlier.
        const others = (
          await ctx.db.ccaInterviewSlot.findMany({
            where: { ccaID: input.ccaID, slotID: { not: input.slotID } },
            select: { startTime: true, endTime: true, canceledAt: true },
          })
        ).filter((o) => o.canceledAt === null);
        const clash = others.some(
          (o) =>
            o.startTime !== null &&
            o.endTime !== null &&
            overlaps(input.startTime, input.endTime, o.startTime, o.endTime),
        );
        if (clash) {
          throw new TRPCError({ code: "CONFLICT", message: "SLOT_OVERLAP" });
        }

        await ctx.db.ccaInterviewSlot.update({
          where: { slotID: input.slotID },
          data: {
            startTime: input.startTime,
            endTime: input.endTime,
            location: nextLocation,
            // Omitted capacity means "leave it alone", so the key is left out
            // of `data` entirely — writing `capacity: undefined` and writing
            // nothing are the same to Prisma, but spelling it out makes the
            // "absent input, untouched field" contract visible.
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.edit",
          reason: `${scope.via}: edited slot #${input.slotID}${
            input.capacity !== undefined
              ? ` (capacity ${slotCapacity(slot.capacity)} → ${input.capacity}, ${occupancy} booked)`
              : ""
          }`,
        });

        return { slotID: input.slotID };
      });
    }),

  /**
   * Cancel a slot. EVERY occupant is reverted to `submitted` (so they can
   * rebook) BEFORE the slot is marked canceled — a claimed slot is never yanked
   * out from under a resident silently, and on a group slot that is now four
   * people, not one. One locked section, one audit row carrying a batchId, so
   * the whole revert is attributable as a single act.
   */
  cancelSlot: identifiedProcedure
    .input(cancelSlotInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const slot = await ctx.db.ccaInterviewSlot.findUnique({
          where: { slotID: input.slotID },
          select: {
            slotID: true,
            ccaID: true,
            bookingID: true,
            canceledAt: true,
          },
        });
        if (!slot || slot.ccaID !== input.ccaID || slot.canceledAt !== null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_SLOT" });
        }

        // Every application still pointing HERE and still merely scheduled.
        // `interviewSlotID: slot.slotID` is a value match, not a null filter,
        // so the absent-field trap does not apply. A decided/interviewed
        // occupant keeps its pointer, exactly as before: the interview is
        // history at that point, not a booking to release.
        const batchId = randomUUID();
        const reverted = await ctx.db.ccaApplication.updateMany({
          where: {
            ccaID: input.ccaID,
            interviewSlotID: slot.slotID,
            status: "interview_scheduled",
          },
          data: {
            status: "submitted",
            interviewSlotID: null,
            updatedAt: new Date(),
          },
        });

        await ctx.db.ccaInterviewSlot.update({
          where: { slotID: input.slotID },
          data: { canceledAt: new Date() },
        });

        // AFTER the cancel, so the just-canceled slot no longer counts as a
        // holder. Frees the room if this was the last live slot on it, and
        // otherwise gives back whichever end of the window it was holding.
        const { released, resized } =
          slot.bookingID != null
            ? await reconcileSlotBookings(ctx.db, input.ccaID, [slot.bookingID])
            : { released: [], resized: [] };

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.cancel",
          batchId,
          reason: `${scope.via}: canceled slot #${input.slotID}${
            reverted.count > 0
              ? ` (reverted ${reverted.count} application(s) to submitted)`
              : ""
          }${
            released.length > 0
              ? ` (released facility booking #${released.join(", #")})`
              : ""
          }${
            resized.length > 0
              ? ` (shrank facility booking #${resized.join(", #")} to the remaining slots)`
              : ""
          }`,
        });

        return {
          slotID: input.slotID,
          revertedCount: reverted.count,
          releasedBookings: released.length,
          resizedBookings: resized.length,
        };
      });
    }),

  /**
   * Clear every FREE (occupancy 0, non-canceled) slot for a CCA in one go — the
   * bulk counterpart to cancelSlot, so a head doesn't delete a whole day one
   * card at a time.
   *
   * OCCUPIED slots are DELIBERATELY untouched, and free means occupancy EXACTLY
   * zero — a group slot with one person on it and three seats spare is NOT
   * free. Cancelling it reverts that applicant to reschedule, which must stay a
   * per-slot, confirmed action (cancelSlot), never a side effect of "clear".
   * Idempotent — clearing when there are none is a no-op that returns 0.
   */
  clearFreeSlots: identifiedProcedure
    .input(ccaTargetInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        // Filter in JS, NOT the query: `{ canceledAt: null }` misses
        // absent-field slots on Prisma+Mongo (see listSlots), which would leave
        // old free slots behind. Fetch, then filter in memory.
        const [all, occupancy] = await Promise.all([
          ctx.db.ccaInterviewSlot.findMany({
            where: { ccaID: input.ccaID },
            select: { slotID: true, bookingID: true, canceledAt: true },
          }),
          occupancyBySlot(ctx.db, input.ccaID),
        ]);
        const free = all.filter(
          (s) => s.canceledAt === null && (occupancy.get(s.slotID) ?? 0) === 0,
        );
        const freeIDs = free.map((s) => s.slotID);

        if (freeIDs.length === 0) {
          return {
            ccaID: input.ccaID,
            cleared: 0,
            releasedBookings: 0,
            resizedBookings: 0,
          };
        }

        // Mark them canceled by slotID list (not a null-filter), so absent-field
        // rows are included. Nothing to revert — these hold nobody.
        await ctx.db.ccaInterviewSlot.updateMany({
          where: { slotID: { in: freeIDs } },
          data: { canceledAt: new Date() },
        });

        // Then free every room no live slot is standing on any more. A window
        // that still has ONE booked slot in it keeps its room — clearing the
        // empties around an interview must not cancel the room it runs in — but
        // it does shrink to that interview, which is the whole point of
        // clearing the empties either side of it.
        const { released, resized } = await reconcileSlotBookings(
          ctx.db,
          input.ccaID,
          free
            .map((s) => s.bookingID)
            .filter((b): b is number => b !== null && b !== undefined),
        );

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.clear",
          reason: `${scope.via}: cleared ${freeIDs.length} free slot(s)${
            released.length > 0
              ? `, released ${released.length} facility booking(s)`
              : ""
          }${
            resized.length > 0
              ? `, shrank ${resized.length} facility booking(s)`
              : ""
          }`,
        });

        return {
          ccaID: input.ccaID,
          cleared: freeIDs.length,
          releasedBookings: released.length,
          resizedBookings: resized.length,
        };
      });
    }),

  /** Append an interview note to an application. */
  addNote: identifiedProcedure
    .input(addNoteInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const app = await ctx.db.ccaApplication.findUnique({
        where: { applicationID: input.applicationID },
        select: { ccaID: true },
      });
      if (!app || app.ccaID !== input.ccaID) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "NO_SUCH_APPLICATION",
        });
      }

      const note = await ctx.db.ccaInterviewNote.create({
        data: {
          applicationID: input.applicationID,
          ccaID: input.ccaID,
          authorUserID: userID,
          body: input.body,
          createdAt: new Date(),
        },
        select: { id: true, createdAt: true },
      });

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: input.ccaID,
        action: "ccaInterviewNote.add",
        reason: `application #${input.applicationID} (${input.body.length} chars)`,
      });

      return { id: note.id, createdAt: note.createdAt };
    }),

  /** Mark a scheduled/submitted application as interviewed (optional stage). */
  markInterviewed: identifiedProcedure
    .input(headApplicationInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const updated = await ctx.db.ccaApplication.updateMany({
        where: {
          applicationID: input.applicationID,
          ccaID: input.ccaID,
          status: { in: ["submitted", "interview_scheduled"] },
        },
        data: { status: "interviewed", updatedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "NOT_INTERVIEWABLE",
        });
      }
      return { applicationID: input.applicationID, status: "interviewed" as const };
    }),

  /**
   * THE ACCEPT/REJECT STEP. Under withCcaLock so two heads cannot both decide
   * one application. Accept writes the UserCCA membership row (canonical key,
   * deduped against both formats exactly as ccaAdmin.addMember), then records
   * the decision; reject frees any FUTURE booked slot for other applicants.
   */
  decide: identifiedProcedure
    .input(decisionInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const app = await ctx.db.ccaApplication.findUnique({
          where: { applicationID: input.applicationID },
          select: {
            applicationID: true,
            ccaID: true,
            userID: true,
            status: true,
            interviewSlotID: true,
          },
        });
        if (!app || app.ccaID !== input.ccaID) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "NO_SUCH_APPLICATION",
          });
        }
        if (isTerminalStatus(app.status)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "ALREADY_DECIDED",
          });
        }

        const batchId = randomUUID();
        const now = new Date();

        if (input.decision === "accepted") {
          // THE FREEZE â€” this is the whole of "heads cannot accept new
          // members", and it is HERE, on the accepted branch, rather than at
          // the top of the procedure, for the reason that is the entire point
          // of the feature: REJECTING MUST STAY POSSIBLE WHILE FROZEN. A gate
          // on the whole of `decide` would leave every `submitted` applicant
          // with no way to be told no for as long as the freeze lasted â€” the
          // stranded-applicant failure this codebase already knows by name.
          // Freezing intake is not a gag order. Do not hoist this line.
          //
          // INSIDE withCcaLock, and after acquisition rather than before it.
          // Hoisting the check above the lock would let an accept that had
          // already passed the flag read sit waiting on the per-CCA mutex while
          // the JCRC froze the hall â€” and that wait is not small: withCcaLock
          // retries up to LOCK_MAX_ATTEMPTS (50) times at LOCK_RETRY_MS (100ms)
          // apart, so it can add ~5s on top of a flag read that was already up
          // to 15s stale. Checking after acquisition bounds the window to this
          // callback instead.
          //
          // The resident side (ccaApplications.submitApplication) reaches the
          // same conclusion and checks in the same place; it ALSO checks once
          // before the lock, purely to fail fast so a frozen hall does not
          // generate a stampede of lock acquisitions that are all going to be
          // refused. That early check is an optimisation there, not the gate.
          // Do not read the two files as disagreeing â€” the load-bearing check
          // is post-acquisition on both sides.
          //
          // Note it is also unconditional on the caller's roles: an admin who
          // heads nothing and reaches this through assertHeadsCca's manager
          // branch is refused exactly like a head (plan D7). A freeze is an
          // operational state of the hall, not an authorisation tier, and an
          // admin bypass would mean the person most likely to verify the
          // freeze is the one person who cannot observe it working.
          await assertRecruitmentOpen(ctx.db);

          // Resolve the applicant's key set the same way ccaAdmin.addMember
          // does, so we don't add a canonical row next to an existing legacy
          // one for the same person.
          const target = await ctx.db.user.findFirst({
            where: {
              OR: [
                {
                  email: {
                    equals: `${app.userID.toLowerCase()}@u.nus.edu`,
                    mode: "insensitive",
                  },
                },
                { userID: app.userID },
              ],
            },
            select: { email: true, userID: true },
          });
          const keys = target ? membershipKeysFor(target) : [app.userID];

          const already = await ctx.db.userCCA.findFirst({
            where: { ccaID: app.ccaID, userID: { in: keys } },
            select: { id: true },
          });
          if (!already) {
            // Raw insert via addCcaMember — a Prisma userCCA.create is rejected
            // by the UserCCA validator (ccaID must be int32; Prisma sends long).
            await addCcaMember(ctx.db, app.ccaID, app.userID);
          }

          await ctx.db.ccaApplication.update({
            where: { applicationID: app.applicationID },
            data: {
              status: "accepted",
              decidedBy: userID,
              decidedAt: now,
              decisionReason: input.reason ?? null,
              updatedAt: now,
            },
          });

          await writeAudit(ctx.db, {
            actorUserID: userID,
            actorRoles: roles,
            targetCcaID: app.ccaID,
            targetUserID: app.userID,
            action: "ccaApplication.accept",
            batchId,
            reason: `${scope.via}: application #${app.applicationID}${
              input.reason ? ` — ${input.reason}` : ""
            }`,
          });
          // Paired membership row, so the roster change is attributable — the
          // same action string ccaAdmin.addMember writes.
          await writeAudit(ctx.db, {
            actorUserID: userID,
            actorRoles: roles,
            targetCcaID: app.ccaID,
            targetUserID: app.userID,
            action: "ccaMember.add",
            batchId,
            reason: already
              ? "already a member (accept was idempotent)"
              : "via application acceptance",
          });

          return {
            applicationID: app.applicationID,
            status: "accepted" as const,
            alreadyMember: already !== null,
          };
        }

        // REJECT. Free this applicant's SEAT — and only theirs — when the slot
        // is still in the future, so someone else can take it; a past interview
        // is left pointing at its slot as the historical record.
        //
        // Today's rule expressed on the pointer instead of the slot: the claim
        // now IS the pointer, so "release the slot" and "null interviewSlotID"
        // are the same write. On a group slot the other occupants are untouched
        // by construction — nothing here reads or writes the slot row.
        let freedSlot = false;
        if (app.interviewSlotID !== null) {
          const nowSec = Math.floor(Date.now() / 1000);
          const slot = await ctx.db.ccaInterviewSlot.findUnique({
            where: { slotID: app.interviewSlotID },
            select: { endTime: true },
          });
          const endTime = slot?.endTime ?? null;
          freedSlot = endTime !== null && endTime > nowSec;
        }

        await ctx.db.ccaApplication.update({
          where: { applicationID: app.applicationID },
          data: {
            status: "rejected",
            decidedBy: userID,
            decidedAt: now,
            decisionReason: input.reason ?? null,
            updatedAt: now,
            ...(freedSlot ? { interviewSlotID: null } : {}),
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: app.ccaID,
          targetUserID: app.userID,
          action: "ccaApplication.reject",
          reason: `${scope.via}: application #${app.applicationID}${
            input.reason ? ` — ${input.reason}` : ""
          }${freedSlot ? ` (freed seat on slot #${app.interviewSlotID})` : ""}`,
        });

        return {
          applicationID: app.applicationID,
          status: "rejected" as const,
          alreadyMember: false,
        };
      });
    }),
});
