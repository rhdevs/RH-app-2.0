"use client";

import { api } from "~/trpc/react";
import {
  EVENT_TITLE_MAX,
  EVENT_DESCRIPTION_MAX,
  EVENT_LOCATION_MAX,
} from "~/lib/schemas/event";

/**
 * The event's own details — name, description, times, location, capacity. A
 * controlled block shared by the create form and the editor so the two cannot
 * drift. Times are held as <input type="datetime-local"> strings and capacity as
 * a raw string; the parent converts to epoch seconds / number on save.
 *
 * These are the fields the JCRC reads when it reviews. The banner and the public
 * description live in the manage page's editor beside this block, and are
 * required BEFORE submission — the reviewer sees a finished event, not a
 * proposal. There is no proposal PDF.
 */
export type ProposalValue = {
  title: string;
  description: string;
  startLocal: string;
  endLocal: string;
  /** "" = unset, "other" = free-text, otherwise a facilityID as a string. */
  facilitySelection: string;
  /** Free-text location, used only when facilitySelection === "other". */
  location: string;
  capacity: string;
};

/* EMPTY_PROPOSAL WAS HERE AND IS DELETED (plan 02 §6.1).
 *
 * Its only consumer was EventCreateForm, the create screen that no longer
 * exists: it seeded a blank form that the head filled in before any row was
 * allocated. There is no such moment any more — "New event" creates the row
 * first, so DetailsEditor always seeds ProposalValue from a REAL Event
 * (EventManage.tsx:162-174), field by field, and never from a blank constant.
 *
 * The TYPE stays; only the value goes. Leaving the constant exported would leave
 * a second, drift-prone answer to "what does an empty event look like" beside
 * BLANK_EVENT_CONTENT in routers/event.ts, which is now the one that decides it
 * — and this one is spelled in EMPTY STRINGS while that one is spelled in
 * NULLS, which is exactly the pairing that has already cost this feature two
 * bugs. */

/** Is the current selection a real facility (not unset / not "Other")? */
export function isFacilitySelected(v: ProposalValue): boolean {
  return v.facilitySelection !== "" && v.facilitySelection !== "other";
}

/**
 * Map the location selection to the { facilityID, location } the draft mutations
 * expect. A facility sends its id (the server denormalizes the name into
 * `location`); "Other" sends free text and a null facilityID; unset sends
 * neither (undefined = leave unchanged on a patch).
 */
export function facilityPayload(v: ProposalValue): {
  facilityID: number | null | undefined;
  location: string | undefined;
} {
  if (v.facilitySelection === "") {
    return { facilityID: undefined, location: undefined };
  }
  if (v.facilitySelection === "other") {
    return { facilityID: null, location: v.location.trim() || undefined };
  }
  return { facilityID: Number(v.facilitySelection), location: undefined };
}

export default function EventDetailsFields({
  value,
  onChange,
  disabled = false,
  isHall = false,
}: {
  value: ProposalValue;
  onChange: (patch: Partial<ProposalValue>) => void;
  disabled?: boolean;
  /**
   * A HALL-WIDE event (`ccaID == null`), authored by the JCRC itself.
   *
   * THIS BLOCK IS SHARED BY BOTH SURFACES, so every sentence in it that names
   * the JCRC as a REVIEWER is false on the hall one: a hall event is registered
   * and published by its own author and never enters the review queue. The
   * surfaces that render this block already branch their own copy on the same
   * fact (EventManage's contract sentence and its "Register and publish"
   * footer, EventsListPanel's empty state; the third was EventCreateForm's
   * footer, deleted with that file) — the three strings below were the half of
   * the same screen that did not, so a JCRC
   * member filling in their own event was told twice that the JCRC would review
   * it. Defaults false: a CCA head is the common case and the CCA surfaces pass
   * nothing.
   */
  isHall?: boolean;
}) {
  const field =
    "mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-gray-50";

  const facilitiesQuery = api.bookings.getAllFacilities.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const facilities = facilitiesQuery.data ?? [];
  const facilityChosen = isFacilitySelected(value);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-gray-700">
          Event name
        </label>
        <input
          type="text"
          value={value.title}
          maxLength={EVENT_TITLE_MAX}
          disabled={disabled}
          onChange={(e) => onChange({ title: e.target.value })}
          className={field}
          placeholder="e.g. Hall Night 2026"
        />
      </div>

      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-gray-700">
          Detailed description
        </label>
        <p className="text-xs text-gray-500">
          What the event is, who it&rsquo;s for, and what happens.{" "}
          {isHall
            ? "This is the internal record — residents read the public description instead."
            : "JCRC reads this when they review it."}
        </p>
        <textarea
          value={value.description}
          maxLength={EVENT_DESCRIPTION_MAX}
          rows={6}
          disabled={disabled}
          onChange={(e) => onChange({ description: e.target.value })}
          className={field}
          placeholder={
            isHall
              ? "What this event is, for the record…"
              : "Tell JCRC about your event…"
          }
        />
        <p className="text-right text-xs text-gray-500">
          {value.description.length}/{EVENT_DESCRIPTION_MAX}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">
            Starts
          </label>
          <input
            type="datetime-local"
            value={value.startLocal}
            disabled={disabled}
            onChange={(e) => onChange({ startLocal: e.target.value })}
            className={field}
          />
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">
            Ends <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="datetime-local"
            value={value.endLocal}
            disabled={disabled}
            onChange={(e) => onChange({ endLocal: e.target.value })}
            className={field}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">
            Location
          </label>
          <select
            value={value.facilitySelection}
            disabled={disabled}
            onChange={(e) => onChange({ facilitySelection: e.target.value })}
            className={field}
          >
            <option value="">Select a location…</option>
            {facilities.map((f) => (
              <option key={f.facilityID} value={String(f.facilityID)}>
                {f.facilityName}
              </option>
            ))}
            <option value="other">Other (type it in)</option>
          </select>
          {value.facilitySelection === "other" && (
            <input
              type="text"
              value={value.location}
              maxLength={EVENT_LOCATION_MAX}
              disabled={disabled}
              onChange={(e) => onChange({ location: e.target.value })}
              className={field}
              placeholder="e.g. Raffles Hall Dining Hall"
            />
          )}
          {facilityChosen && (
            <p className="text-xs text-emerald-700">
              {isHall
                ? "This facility is booked automatically when the event is published — so set an end time."
                : "If JCRC approves, this facility is booked automatically for the times above — so set an end time."}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-700">
            Capacity <span className="text-gray-400">(optional)</span>
          </label>
          <input
            type="number"
            min={1}
            value={value.capacity}
            disabled={disabled}
            onChange={(e) => onChange({ capacity: e.target.value })}
            className={field}
            placeholder="Leave blank for unlimited"
          />
          <p className="text-xs text-gray-500">
            Blank means no cap. Signups close automatically when full.
          </p>
        </div>
      </div>
    </div>
  );
}
