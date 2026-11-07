import { TRPCError } from "@trpc/server";
import type { Event, PrismaClient } from "@prisma/client";

import { resolveFacility } from "~/server/api/services/booking";
import { moveEventBooking } from "~/server/api/services/eventPublish";
import type { UpdateEventInput } from "~/lib/schemas/event";

/**
 * EDITING A PUBLISHED EVENT, keeping its signups.
 *
 *  - Capacity may be raised at any time and lowered only to the number of
 *    signups already in (checked under the signup lock by the caller).
 *  - Date, time and location may change; the facility booking moves with them,
 *    and a clash refuses the edit naming what is in the way. The move is only
 *    final once the caller has written the row: it must call `finish` after a
 *    successful write and `undo` after anything else.
 *  - The title and the internal description stay as published. A payload that
 *    CHANGES them is refused with FIELD_LOCKED rather than silently dropped;
 *    one that repeats the stored value is fine, so a client may send the whole
 *    form.
 *
 * Banner, gallery, public description and door timing are handled by the
 * caller, as for a draft.
 */

export type LiveEdit = {
  data: Record<string, unknown>;
  /** What changed, for the audit row: "time", "location", "capacity". */
  changed: string[];
  capacityChanged: boolean;
  /** Call when the row write failed or was refused: rooms go back. */
  undo: () => Promise<void>;
  /** Call once the row is written: frees the room the event left. */
  finish: () => Promise<void>;
};

const bad = (message: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message });
};

function assertNoLockedChange(event: Event, input: UpdateEventInput): void {
  const locked: string[] = [];
  if (input.title !== undefined && input.title !== event.title) {
    locked.push("title");
  }
  if (
    input.description !== undefined &&
    input.description !== event.description
  ) {
    locked.push("description");
  }
  if (locked.length > 0) bad(`FIELD_LOCKED:${locked.join(",")}`);
}

type Place = { facilityID: number | null; location: string | null };

async function nextPlace(
  db: PrismaClient,
  event: Event,
  input: UpdateEventInput,
): Promise<Place> {
  if (input.facilityID === undefined) {
    // A facility's name is denormalised, so free text only applies to "Other".
    if (event.facilityID == null && input.location !== undefined) {
      return { facilityID: null, location: input.location };
    }
    return { facilityID: event.facilityID, location: event.location };
  }
  if (input.facilityID === null) {
    const location = input.location ?? event.location;
    if (!location?.trim()) bad("LOCATION_REQUIRED");
    return { facilityID: null, location };
  }
  const f = await resolveFacility(db, input.facilityID);
  return { facilityID: f.facilityID, location: f.name };
}

export async function planLiveEdit(
  db: PrismaClient,
  event: Event,
  input: UpdateEventInput,
): Promise<LiveEdit> {
  assertNoLockedChange(event, input);
  const data: Record<string, unknown> = {};
  const changed: string[] = [];

  const capacityChanged =
    input.capacity !== undefined && input.capacity !== event.capacity;
  if (capacityChanged) {
    data.capacity = input.capacity;
    changed.push("capacity");
  }

  const startTime = input.startTime ?? event.startTime;
  const endTime = input.endTime === undefined ? event.endTime : input.endTime;
  const timeChanged =
    startTime !== event.startTime || endTime !== event.endTime;
  if (timeChanged) {
    data.startTime = startTime;
    data.endTime = endTime;
    changed.push("time");
  }

  const place = await nextPlace(db, event, input);
  const placeChanged =
    place.facilityID !== event.facilityID || place.location !== event.location;
  if (placeChanged) {
    data.facilityID = place.facilityID;
    data.location = place.location;
    changed.push("location");
  }

  const noop = async (): Promise<void> => undefined;
  let undo = noop;
  let finish = noop;
  if (timeChanged || placeChanged) {
    data.scheduleChangedAt = new Date();
    if (place.facilityID != null) {
      if (startTime == null || endTime == null) bad("END_TIME_REQUIRED");
      const move = await moveEventBooking(
        db,
        { ...event, facilityID: place.facilityID },
        {
          facilityID: place.facilityID,
          startTime: startTime!,
          endTime: endTime!,
        },
      );
      data.bookingID = move.bookingID;
      data.autoBookFailed = false;
      undo = move.undo;
      finish = move.finish;
    } else if (event.bookingID != null) {
      // Moved to "Other": the room is freed once the row no longer needs it.
      const old = event.bookingID;
      data.bookingID = null;
      finish = async () => {
        try {
          await db.bookings.deleteMany({ where: { bookingID: old } });
        } catch (err) {
          console.error(
            JSON.stringify({
              evt: "event_booking_release_failed",
              eventID: event.eventID,
              bookingID: old,
              err: err instanceof Error ? err.name : "unknown",
            }),
          );
        }
      };
    }
  }

  return { data, changed, capacityChanged, undo, finish };
}

/** Lowering capacity below the signups already in is refused. */
export async function assertCapacityFits(
  db: PrismaClient,
  eventID: number,
  capacity: number | null | undefined,
): Promise<void> {
  if (capacity == null) return;
  const signups = await db.eventSignup.count({ where: { eventID } });
  if (signups > capacity) bad(`CAPACITY_BELOW_SIGNUPS:${signups}`);
}
