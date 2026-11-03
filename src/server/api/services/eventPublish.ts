import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { nextBookingId, withFacilityLock } from "~/server/api/services/booking";

/**
 * Direct publish, and the facility booking that travels with a live event.
 *
 * Heads used to submit an event for JCRC review, and approval published it and
 * booked its room. The event has already been approved by email, so a head now
 * publishes it directly: `publish` checks what approval used to check and books
 * the room at that moment. Review is kept behind `events.review.required` so it
 * can be switched back on without a code change.
 */

/* -------------------------------------------------------------------------- */
/* The review switch                                                           */
/* -------------------------------------------------------------------------- */

const REVIEW_FLAG_KEY = "events.review.required";
const FLAG_TTL_MS = 15_000;

let reviewFlagCache: { at: number; on: boolean } | null = null;

/**
 * Is JCRC review switched on? OFF unless the row says "on": the absence of the
 * row, and an unreadable row, both mean heads publish directly. A failed read is
 * not cached, so the next request retries.
 *
 * Failing to "off" is the safe side here, unlike the events kill switch: review
 * off is the normal mode, and every publish still runs the completeness and
 * facility checks below.
 */
export async function isEventReviewRequired(
  db: PrismaClient,
): Promise<boolean> {
  if (reviewFlagCache && Date.now() - reviewFlagCache.at < FLAG_TTL_MS) {
    return reviewFlagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: REVIEW_FLAG_KEY },
    });
    const on = row?.value === "on";
    reviewFlagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetEventReviewFlagCache(): void {
  reviewFlagCache = null;
}

/* -------------------------------------------------------------------------- */
/* Completeness                                                                */
/* -------------------------------------------------------------------------- */

type PublishableFields = {
  title: string | null;
  description: string | null;
  startTime: number | null;
  endTime: number | null;
  location: string | null;
  facilityID: number | null;
  bannerUrl: string | null;
  publicDescription: string | null;
};

/**
 * The fields an event must have before residents can see it. Shared by
 * `submitForReview` and `publish` so the two can never disagree.
 */
export function missingForPublish(event: PublishableFields): string[] {
  const missing: string[] = [];
  if (!event.title?.trim()) missing.push("title");
  if (!event.description?.trim()) missing.push("description");
  if (event.startTime == null) missing.push("startTime");
  if (!event.location?.trim()) missing.push("location");
  if (!event.bannerUrl) missing.push("banner");
  if (!event.publicDescription?.trim()) missing.push("publicDescription");
  // A facility can only be booked with a definite end time.
  if (event.facilityID != null && event.endTime == null) {
    missing.push("endTime");
  }
  return missing;
}

/* -------------------------------------------------------------------------- */
/* Facility booking                                                            */
/* -------------------------------------------------------------------------- */

export type FacilityClash = {
  eventName: string | null;
  startTime: number;
  endTime: number;
};

export type SlotRequest = {
  facilityID: number;
  startTime: number;
  endTime: number;
  /** The event's own booking, which never clashes with itself. */
  ownBookingID?: number | null;
};

/**
 * Throw CONFLICT `FACILITY_CLASH` naming the booking that holds the slot. The
 * clash rides on the error's `cause`-free message as JSON after the code, so
 * the client can show what is in the way without a second request.
 */
export function throwClash(clash: FacilityClash): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: `FACILITY_CLASH:${JSON.stringify(clash)}`,
  });
}

async function findClash(
  db: PrismaClient,
  slot: SlotRequest,
): Promise<FacilityClash | null> {
  const clash = await db.bookings.findFirst({
    where: {
      facilityID: slot.facilityID,
      AND: [
        { endTime: { gt: slot.startTime } },
        { startTime: { lt: slot.endTime } },
      ],
      ...(slot.ownBookingID != null
        ? { NOT: { bookingID: slot.ownBookingID } }
        : {}),
    },
    select: { eventName: true, startTime: true, endTime: true },
  });
  return clash
    ? {
        eventName: clash.eventName ?? null,
        startTime: clash.startTime,
        endTime: clash.endTime,
      }
    : null;
}

/** Marks a booking as an event's own; personal booking lists leave these out. */
export const EVENT_AUTO_BOOKING_PREFIX = "Auto-booked for event #";

export type EventBookingOwner = {
  eventID: number;
  ccaID: number | null;
  createdBy: string;
  title: string | null;
};

/**
 * Book the event's facility, or refuse naming the clash. Same lock, conflict
 * scan and id allocator as createBooking and `decide`.
 *
 * 0 is the reserved "no CCA" sentinel on Bookings (see `decide`): a hall
 * event's booking is written with ccaID 0, never null.
 */
export async function bookEventFacility(
  db: PrismaClient,
  event: EventBookingOwner,
  slot: SlotRequest,
): Promise<number> {
  return withFacilityLock(db, slot.facilityID, async () => {
    const clash = await findClash(db, slot);
    if (clash) throwClash(clash);
    const bookingID = await nextBookingId(db);
    await db.bookings.create({
      data: {
        bookingID,
        ccaID: event.ccaID ?? 0,
        facilityID: slot.facilityID,
        startTime: slot.startTime,
        endTime: slot.endTime,
        userID: event.createdBy,
        eventName: event.title ?? `Event #${event.eventID}`,
        description: `${EVENT_AUTO_BOOKING_PREFIX}${event.eventID}`,
      },
    });
    return bookingID;
  });
}

/**
 * A booking move that has happened but is not final until the event row is
 * written. `undo` puts the rooms back as they were (the row write failed or
 * was refused); `finish` frees what the event no longer needs (the row write
 * succeeded). Neither throws: a failure is logged, never surfaced.
 */
export type BookingMove = {
  bookingID: number;
  undo: () => Promise<void>;
  finish: () => Promise<void>;
};

const quietly =
  (evt: string, fields: Record<string, unknown>, fn: () => Promise<unknown>) =>
  async (): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(
        JSON.stringify({
          evt,
          ...fields,
          err: err instanceof Error ? err.name : "unknown",
        }),
      );
    }
  };

/**
 * Move a live event's booking to a new slot (same or different facility), or
 * refuse naming the clash. The existing booking is updated in place when the
 * facility is unchanged, so the event never holds two rooms or none.
 *
 * NOTHING IS FREED HERE. A different room is booked alongside the old one,
 * which `finish` releases once the event row points at the new one; until
 * then `undo` can give the new room back and the event still holds the old.
 */
export async function moveEventBooking(
  db: PrismaClient,
  event: EventBookingOwner & { bookingID: number | null; facilityID: number },
  slot: SlotRequest,
): Promise<BookingMove> {
  const current =
    event.bookingID == null
      ? null
      : await db.bookings.findFirst({
          where: { bookingID: event.bookingID },
          select: {
            bookingID: true,
            facilityID: true,
            startTime: true,
            endTime: true,
            eventName: true,
          },
        });
  const noop = async (): Promise<void> => undefined;

  if (current && current.facilityID === slot.facilityID) {
    await withFacilityLock(db, slot.facilityID, async () => {
      const clash = await findClash(db, {
        ...slot,
        ownBookingID: current.bookingID,
      });
      if (clash) throwClash(clash);
      await db.bookings.updateMany({
        where: { bookingID: current.bookingID },
        data: {
          startTime: slot.startTime,
          endTime: slot.endTime,
          eventName: event.title ?? `Event #${event.eventID}`,
        },
      });
    });
    return {
      bookingID: current.bookingID,
      undo: quietly(
        "event_booking_move_undo_failed",
        { eventID: event.eventID, bookingID: current.bookingID },
        () =>
          db.bookings.updateMany({
            where: { bookingID: current.bookingID },
            data: {
              startTime: current.startTime,
              endTime: current.endTime,
              eventName: current.eventName,
            },
          }),
      ),
      finish: noop,
    };
  }

  // A different room (or no booking yet): book the new one alongside.
  const bookingID = await bookEventFacility(db, event, slot);
  return {
    bookingID,
    undo: quietly(
      "event_booking_move_undo_failed",
      { eventID: event.eventID, bookingID },
      () => db.bookings.deleteMany({ where: { bookingID } }),
    ),
    finish: current
      ? quietly(
          "event_booking_release_failed",
          { eventID: event.eventID, bookingID: current.bookingID },
          () =>
            db.bookings.deleteMany({ where: { bookingID: current.bookingID } }),
        )
      : noop,
  };
}
