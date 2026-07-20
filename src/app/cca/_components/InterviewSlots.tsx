"use client";

import { useState } from "react";
import { MapPin, Trash2 } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  INTERVIEW_LOCATION_MAX,
  slotDraftSchema,
} from "~/lib/schemas/ccaApplication";
import { formatSlot } from "~/app/ccas/_lib/status";

/**
 * A CCA head opens interview slots from their availability and sees who booked
 * each. Times are entered as local wall-clock (a date + start/end time) and
 * converted to epoch seconds the same way BookingModal does — the app is
 * single-hall, so there is no timezone to carry.
 */
export default function InterviewSlots({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const list = api.ccaApplicationsHead.listSlots.useQuery(
    { ccaID },
    { retry: false },
  );

  const [date, setDate] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [location, setLocation] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = () => utils.ccaApplicationsHead.listSlots.invalidate({ ccaID });

  const open = api.ccaApplicationsHead.openSlots.useMutation({
    onSuccess: async () => {
      setStart("");
      setEnd("");
      setLocation("");
      setFormError(null);
      await refresh();
    },
  });
  const cancel = api.ccaApplicationsHead.cancelSlot.useMutation({
    onSuccess: refresh,
  });

  /** Local date + "HH:MM" → epoch seconds, mirroring BookingModal. */
  const toEpoch = (d: string, t: string): number | null => {
    if (!d || !t) return null;
    const [h, m] = t.split(":").map(Number);
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime()) || h === undefined || m === undefined) {
      return null;
    }
    dt.setHours(h, m, 0, 0);
    return Math.floor(dt.getTime() / 1000);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const startTime = toEpoch(date, start);
    const endTime = toEpoch(date, end);
    if (startTime === null || endTime === null) {
      setFormError("Pick a date, a start time and an end time.");
      return;
    }
    const parsed = slotDraftSchema.safeParse({
      startTime,
      endTime,
      location: location.trim() || undefined,
    });
    if (!parsed.success) {
      setFormError(
        parsed.error.issues[0]?.message === "END_BEFORE_START"
          ? "The end time has to be after the start time."
          : "That slot isn't valid.",
      );
      return;
    }
    if (endTime <= Math.floor(Date.now() / 1000)) {
      setFormError("That slot is in the past.");
      return;
    }
    setFormError(null);
    open.mutate({ ccaID, slots: [parsed.data] });
  };

  const serverError = open.error
    ? open.error.message === "SLOT_OVERLAP"
      ? "That overlaps a slot you've already opened."
      : open.error.message === "SLOT_IN_PAST"
        ? "That slot is in the past."
        : open.error.message === "NOT_A_HEAD_OF_THIS_CCA"
          ? "You're no longer a head of this CCA."
          : "That didn't open. Try again."
    : null;

  return (
    <div className="space-y-5">
      {/* Open a slot */}
      <form
        onSubmit={submit}
        className="space-y-3 rounded-lg border border-gray-200 bg-white p-5"
      >
        <p className="text-sm font-medium text-gray-900">Open an interview slot</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="font-medium text-gray-700">Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-gray-700">Location</span>
            <input
              type="text"
              value={location}
              maxLength={INTERVIEW_LOCATION_MAX}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. JCRC Room (optional)"
              className="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-gray-700">Start</span>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="font-medium text-gray-700">End</span>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </label>
        </div>
        {(formError ?? serverError) && (
          <p className="text-sm text-red-600">{formError ?? serverError}</p>
        )}
        <Button type="submit" disabled={open.isPending}>
          {open.isPending ? "Opening…" : "Open slot"}
        </Button>
      </form>

      {/* Existing slots */}
      <div>
        <p className="mb-2 text-sm font-medium text-gray-900">Open slots</p>
        {list.isPending ? (
          <div className="h-24 animate-pulse rounded-lg bg-gray-200" />
        ) : list.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
            {list.error.message === "NOT_A_HEAD_OF_THIS_CCA"
              ? "You can only manage slots for CCAs you head."
              : "These couldn't be loaded."}
          </p>
        ) : list.data.slots.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
            No slots open yet. Add one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {list.data.slots.map((s) => (
              <li
                key={s.slotID}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800">
                    {formatSlot(s.startTime, s.endTime)}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
                    {s.location && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {s.location}
                      </span>
                    )}
                    {s.bookedBy ? (
                      <span className="text-emerald-700">
                        Booked by {s.bookedBy.displayName ?? s.bookedBy.email ?? "an applicant"}
                      </span>
                    ) : (
                      <span>Open</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => {
                    if (
                      s.bookedByUserID &&
                      !window.confirm(
                        "This slot is booked. Cancelling it will send that applicant back to schedule again. Continue?",
                      )
                    ) {
                      return;
                    }
                    cancel.mutate({ ccaID, slotID: s.slotID });
                  }}
                  disabled={cancel.isPending}
                  aria-label="Cancel slot"
                  className="shrink-0 rounded-md p-2 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
