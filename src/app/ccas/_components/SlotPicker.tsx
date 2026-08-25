"use client";

import { useId, useState } from "react";
import { MapPin, Users } from "lucide-react";

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
 *
 * A slot may take more than one person. When it does the label says so BEFORE
 * the applicant commits — turning up to what you thought was a 1:1 and finding
 * three other people in the room is a bad surprise, and it is the reason
 * capacity is shown to residents at all. What they never see is WHO else booked:
 * the server sends counts only.
 *
 * THE RECRUITMENT FREEZE STOPS BOOKING HERE (since 2026-08-25). The slot LIST
 * stays visible and readable while frozen — availableSlots is a read and is not
 * gated, and hiding it would tell a resident "there are no interviews" when what
 * is true is "you cannot claim one yet". Only the commit is refused, and it is
 * refused the same way the Apply button is: a visible reason, an `aria-disabled`
 * control that stays focusable, and a guard that SPEAKS rather than returning in
 * silence. The server re-checks in bookSlot regardless; this only decides what
 * the resident is told.
 */
export default function SlotPicker({
  ccaID,
  applicationID,
  currentSlotID,
  recruitmentOpen,
  onDone,
  onRefresh,
  onCancel,
}: {
  ccaID: number;
  applicationID: number;
  currentSlotID: number | null;
  /**
   * Hall-wide freeze, read from whichever parent mounted this (getCca or
   * myApplications). COSMETIC and allowed to be up to 15s stale — bookSlot is
   * the boundary.
   */
  recruitmentOpen: boolean;
  onDone: () => Promise<void>;
  /**
   * Refresh the parent's data WITHOUT closing the picker. Distinct from
   * `onDone`, which also closes: when the server refuses a booking because the
   * freeze landed mid-session, the right outcome is that this picker stays open
   * and re-renders into its frozen state, not that it vanishes.
   */
  onRefresh: () => Promise<void>;
  onCancel: () => void;
}) {
  const slots = api.ccaApplications.availableSlots.useQuery(
    { ccaID },
    { retry: false },
  );
  // `useId`, not a hard-coded literal: `picking` is per-ROW state in
  // MyApplicationsList and nothing closes one row's picker when another opens,
  // so a resident with two live applications can have two pickers mounted at
  // once. Two identical ids would make both Confirm buttons' aria-describedby
  // resolve to the first picker's notice.
  const noticeId = `booking-frozen-${useId()}`;
  const [selected, setSelected] = useState<number | null>(null);
  /**
   * A refusal produced by the client-side guard below. Single-cause here — the
   * freeze is the only thing this guard tests — so unlike the head's review
   * screen it needs no `cause` tag; the render gate gets to test that one flag
   * directly. If a second guard is ever added, tag it (see `Refusal` in
   * ApplicationsReview.tsx for why an untagged string breaks).
   */
  const [refused, setRefused] = useState<string | null>(null);
  const book = api.ccaApplications.bookSlot.useMutation({
    onSuccess: onDone,
    // Only RECRUITMENT_CLOSED, deliberately NOT RECRUITMENT_UNKNOWN. The latter
    // is thrown from exactly one place — the catch in services/ccaRecruitment.ts
    // — and means the DATABASE COULD NOT BE REACHED, so refetching against it
    // would fail and there is nothing new to learn anyway. RECRUITMENT_CLOSED is
    // the opposite: the database is up, the parent's `recruitmentOpen` is merely
    // stale, and refreshing is what turns this picker into its frozen state
    // instead of leaving a live-looking Confirm button the server will reject.
    //
    // `onRefresh`, not `onDone` — the picker must stay open to explain itself.
    onError: async (e) => {
      if (e.message === "RECRUITMENT_CLOSED") await onRefresh();
    },
  });

  if (slots.isPending) {
    return <div className="h-24 animate-pulse rounded-md bg-gray-100" />;
  }
  // `!slots.data`, NOT `slots.error` — the last file in this feature that had
  // not had the round-3 standardisation, and this round is what made the gap
  // reachable: `onError` now calls `onRefresh()`, which invalidates
  // availableSlots, and that query is `retry: false`. So a freeze refusal can
  // trigger a refetch that trips on a hiccup, and testing the error first would
  // replace this entire picker — the frozen notice, the refusal line, the
  // sentinel copy — with "Couldn't load slots", telling the resident about a
  // load failure instead of why their booking was refused. That would undo the
  // whole point of using onRefresh rather than onDone (keep the picker open so
  // it can explain itself).
  if (!slots.data) {
    return (
      <p className="text-sm text-red-600">
        Couldn&rsquo;t load slots. Close and try again.
      </p>
    );
  }

  const open = slots.data.slots;

  return (
    <div className="space-y-3">
      {/* Calm grey, the resident register: a closed door is a configuration
          state, not a failure and not their fault. Carries the id the Confirm
          button points at, so the explanation is reachable from the control
          rather than only readable beside it. Rendered above the list because a
          reason for a disabled button that appears below it is read after the
          fact. */}
      {!recruitmentOpen && (
        <div
          id={noticeId}
          className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
        >
          <p className="text-sm font-medium text-gray-900">
            Interview booking is closed
          </p>
          <p className="mt-0.5 text-sm text-gray-600">
            The JCRC has paused CCA recruitment, so slots can’t be booked or
            changed right now. Any interview you’ve already booked still goes
            ahead.
          </p>
        </div>
      )}
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
                  <span className="min-w-0">
                    <span className="block font-medium text-gray-800">
                      {formatSlot(s.startTime, s.endTime)}
                    </span>
                    {s.capacity > 1 && (
                      <span className="mt-0.5 block text-xs text-amber-700">
                        <Users className="mr-1 inline h-3 w-3 align-[-2px]" />
                        Group interview · up to {s.capacity} people —{" "}
                        {s.seatsLeft} seat{s.seatsLeft === 1 ? "" : "s"} left
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-gray-500">
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

      {/* ONE refusal line, mutually exclusive, and it ALWAYS SPEAKS.
          `role="alert"` on both arms, because a refused press changes nothing
          else on screen and aria-describedby is announced on FOCUS, never on
          activation — so without this a press is silent.

          The earlier version suppressed the server's RECRUITMENT_CLOSED line
          whenever the grey notice was showing, borrowing a rule from
          CcaApplyPanel where the surviving notice sits directly above the
          Submit button. HERE THE GEOMETRY IS DIFFERENT: this notice is at the
          TOP of the picker, above the whole slot list, and carries no live
          region. So on the stale-flag path — the exact case `onError` exists
          for, where the client believed recruitment was open, the local guard
          never ran and `refused` is null — the press produced no visible change
          beside the button and nothing at all for a screen reader. The local
          guard's amber line still wins when it fired, so the two can never both
          appear and the fact is never stated twice.

          The freeze sentinel is gated on the freeze still holding, so a line
          about a refusal cannot outlive its cause and sit beside a live button
          if the JCRC reopens while this picker is still open.
          RECRUITMENT_UNKNOWN is deliberately NOT gated that way: its cause is
          "we could not check", which nothing on the client can re-derive, so it
          stands until the next attempt. */}
      {refused && !recruitmentOpen ? (
        <p role="alert" className="text-sm text-amber-800">
          {refused}
        </p>
      ) : book.error &&
        !(recruitmentOpen && book.error.message === "RECRUITMENT_CLOSED") ? (
        <p role="alert" className="text-sm text-red-600">
          {book.error.message === "SLOT_FULL"
            ? "That slot just filled up. Pick another."
            : book.error.message === "SLOT_IN_PAST"
              ? "That slot has passed. Pick another."
              : book.error.message === "RECRUITMENT_CLOSED"
                ? "CCA recruitment is closed, so interviews can’t be booked right now."
                : book.error.message === "RECRUITMENT_UNKNOWN"
                  ? "We couldn’t check whether recruitment is open. Try again in a moment."
                  : "That didn't book. Try again."}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        {/* NATIVE `disabled` FOR THE IN-FLIGHT WRITE ONLY; `aria-disabled` for
            the freeze, which can last days and must stay focusable so a
            screen-reader resident can hear WHY. A natively disabled control is
            out of the tab order, so its aria-describedby points at something
            nobody can reach.

            "Nothing selected" is native `disabled` ONLY while recruitment is
            open. It had been unconditional, which quietly defeated the whole
            arrangement: `selected` starts null, so a frozen picker OPENED IN
            the disabled state — Confirm skipped in the tab order, the guard
            below unreachable, `disabled:pointer-events-none` swallowing the
            click, and this very comment describing a design that did not
            apply. While frozen the button must be reachable BEFORE a slot is
            picked, because "you cannot book right now" is the answer whether
            or not they have chosen a time. The guard refuses either way. */}
        <Button
          disabled={
            recruitmentOpen
              ? selected === null || book.isPending
              : book.isPending
          }
          aria-disabled={!recruitmentOpen || undefined}
          aria-describedby={recruitmentOpen ? undefined : noticeId}
          className={
            recruitmentOpen
              ? undefined
              : "cursor-not-allowed opacity-50 hover:bg-primary"
          }
          onClick={() => {
            // THE GUARD SPEAKS. The button is not natively disabled while
            // frozen, so the press lands here; returning in silence would leave
            // the resident pressing Enter into nothing, and aria-describedby is
            // announced on FOCUS, never on activation.
            if (!recruitmentOpen) {
              setRefused(
                "Still closed — this slot can’t be claimed until the JCRC reopens recruitment.",
              );
              return;
            }
            if (selected !== null) {
              setRefused(null);
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
