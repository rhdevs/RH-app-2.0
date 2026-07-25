"use client";

import { api } from "~/trpc/react";
import {
  EVENT_TITLE_MAX,
  EVENT_DESCRIPTION_MAX,
  EVENT_LOCATION_MAX,
} from "~/lib/schemas/event";

/**
 * The proposal fields a head fills in at application time. A controlled block
 * shared by the create form and the draft editor so they can't drift. Times are
 * held as <input type="datetime-local"> strings and capacity as a raw string;
 * the parent converts to epoch seconds / number on save.
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

export const EMPTY_PROPOSAL: ProposalValue = {
  title: "",
  description: "",
  startLocal: "",
  endLocal: "",
  facilitySelection: "",
  location: "",
  capacity: "",
};

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

export default function EventProposalFields({
  value,
  onChange,
  disabled = false,
}: {
  value: ProposalValue;
  onChange: (patch: Partial<ProposalValue>) => void;
  disabled?: boolean;
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
          What the event is, who it&rsquo;s for, and what happens. JCRC reads this
          alongside your proposal.
        </p>
        <textarea
          value={value.description}
          maxLength={EVENT_DESCRIPTION_MAX}
          rows={6}
          disabled={disabled}
          onChange={(e) => onChange({ description: e.target.value })}
          className={field}
          placeholder="Tell JCRC about your event…"
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
              A booking for this facility is created automatically once JCRC
              approves — remember to set an end time.
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
