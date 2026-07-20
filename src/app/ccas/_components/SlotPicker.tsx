"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { formatSlot } from "../_lib/status";

/**
 * The interview slot list + confirm, shared by the CCA detail page and the My
 * Applications view so booking/rebooking behaves identically in both. Hand-rolled
 * buttons rather than a calendar widget — @fullcalendar/interaction isn't
 * installed, and a short list of open slots reads more clearly as a list.
 *
 * `onDone` fires after a successful book and OWNS the cache invalidation for
 * whichever surface mounted this (getCca vs myApplications), so the picker stays
 * agnostic about where it lives.
 */
export default function SlotPicker({
  ccaID,
  applicationID,
  currentSlotID,
  onDone,
  onCancel,
}: {
  ccaID: number;
  applicationID: number;
  currentSlotID: number | null;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const slots = api.ccaApplications.availableSlots.useQuery(
    { ccaID },
    { retry: false },
  );
  const [selected, setSelected] = useState<number | null>(null);
  const book = api.ccaApplications.bookSlot.useMutation({ onSuccess: onDone });

  if (slots.isPending) {
    return <div className="h-24 animate-pulse rounded-md bg-gray-100" />;
  }
  if (slots.error) {
    return (
      <p className="text-sm text-red-600">
        Couldn&rsquo;t load slots. Close and try again.
      </p>
    );
  }

  const open = slots.data.slots;

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-gray-700">Pick a time</p>
      {open.length === 0 ? (
        <p className="text-sm text-gray-500">
          No open slots right now. Check back later.
        </p>
      ) : (
        <ul className="space-y-2">
          {open.map((s) => {
            const isCurrent = s.slotID === currentSlotID;
            const isSel = s.slotID === selected;
            return (
              <li key={s.slotID}>
                <button
                  type="button"
                  onClick={() => setSelected(s.slotID)}
                  aria-pressed={isSel}
                  className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    isSel
                      ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-500"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  }`}
                >
                  <span className="font-medium text-gray-800">
                    {formatSlot(s.startTime, s.endTime)}
                  </span>
                  <span className="flex items-center gap-3 text-gray-500">
                    {s.location && (
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3.5 w-3.5" />
                        {s.location}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="text-xs text-emerald-700">Current</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {book.error && (
        <p className="text-sm text-red-600">
          {book.error.message === "SLOT_TAKEN"
            ? "Someone just took that slot. Pick another."
            : book.error.message === "SLOT_IN_PAST"
              ? "That slot has passed. Pick another."
              : "That didn't book. Try again."}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button
          disabled={selected === null || book.isPending}
          onClick={() => {
            if (selected !== null) {
              book.mutate({ applicationID, slotID: selected });
            }
          }}
        >
          {book.isPending ? "Booking…" : "Confirm slot"}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm font-medium text-gray-500 hover:text-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
