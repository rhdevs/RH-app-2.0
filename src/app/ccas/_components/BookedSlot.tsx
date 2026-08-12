"use client";

import { AlertTriangle, CalendarClock, MapPin, Users } from "lucide-react";

import { formatSlot } from "../_lib/status";

/**
 * The details of an interview slot a resident has already booked — time, room,
 * and the two things that change what they should do about it: whether anyone
 * else is in the room with them, and whether the CCA has since cancelled it.
 *
 * One component for both surfaces (the CCA detail page and My Applications) so
 * the two cannot drift: a resident who books on one page and checks on the other
 * must see the same sentence. `capacity`/`seatsLeft`/`canceled` are optional
 * because myApplications sends the bare {slotID, startTime, endTime, location}
 * shape; getCca sends the richer one.
 */
export default function BookedSlot({
  slot,
}: {
  slot: {
    startTime: number | null;
    endTime: number | null;
    location: string | null;
    capacity?: number;
    seatsLeft?: number;
    canceled?: boolean;
  };
}) {
  // `capacity` is already through slotCapacity() on the server, so this is a
  // comparison and NOT another place the "absent means 1" default lives —
  // undefined here means "the caller didn't send seat data", not "capacity 1".
  const group = slot.capacity !== undefined && slot.capacity > 1;

  return (
    <div className="space-y-1">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <CalendarClock className="h-4 w-4 text-gray-400" />
          {formatSlot(slot.startTime, slot.endTime)}
        </span>
        {slot.location && (
          <span className="inline-flex items-center gap-1 text-gray-600">
            <MapPin className="h-3.5 w-3.5 text-gray-400" />
            {slot.location}
          </span>
        )}
      </p>

      {/* Same warning SlotPicker gives BEFORE booking, repeated after: turning up
          to what you thought was a 1:1 and finding three other people in the room
          is a bad surprise either way. */}
      {group && (
        <p className="text-xs text-amber-700">
          <Users className="mr-1 inline h-3 w-3 align-[-2px]" />
          Group interview · up to {slot.capacity} people
          {slot.seatsLeft !== undefined && (
            <>
              {" "}
              — {slot.seatsLeft} seat{slot.seatsLeft === 1 ? "" : "s"} left
            </>
          )}
        </p>
      )}

      {slot.canceled && (
        <p className="text-xs font-medium text-red-600">
          <AlertTriangle className="mr-1 inline h-3 w-3 align-[-2px]" />
          The CCA cancelled this slot — pick another time.
        </p>
      )}
    </div>
  );
}
