"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  X,
  Calendar as CalendarIcon,
  Clock,
  MapPin,
  User,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Repeat,
  Check,
  Ban,
  Lock,
} from "lucide-react";
import { format } from "date-fns";
import { api } from "~/trpc/react";
import Toast from "./Toast";
import {
  SERIES_MAX_OCCURRENCES,
  expandWeekly,
  validateSeriesWindows,
  type SeriesWindow,
} from "~/lib/schemas/recurrence";

/**
 * A facility as the picker needs it: the row itself plus the server's own
 * verdict on it. `canBook`, `closed` and `closedNote` come from
 * `bookings.getFacilitiesForBooking`, which computes them with the SAME
 * getBookableFacilityMap the enforcement point uses (I-7 v2 — a client gate must
 * never be stricter than the server, so it must not compute its own rule).
 */
export interface PickerFacility {
  facilityID: number;
  facilityName: string;
  facilityLocation: string;
  canBook: boolean;
  requiredRoles: string[];
  closed: boolean;
  closedNote: string | null;
}

/** 08 §1.2: the one wording for an empty canonical userID, shared with the
 *  calendar so the toast and the panel cannot drift apart. Written in the user's
 *  terms — they have no idea what a "userID" is, only which email they used. */
export const NO_IDENTITY_MESSAGE =
  "This account isn't recognised as an NUS student account, so bookings can't be linked to it. Sign in with your @u.nus.edu email, or contact the JCRC if you think this is a mistake.";

interface BookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  facilities: PickerFacility[];
  userId: string;
  currentDate: Date;
  refetch: () => void;
  /** Whether this session may create a REPEATING booking (jcrc / cca_head /
   *  admin). Advisory only — `createSeries` is role-gated server-side and is the
   *  real check; this just decides whether to render the control. */
  canCreateSeries: boolean;
  /**
   * Raised by the PARENT when a booking succeeds, because this component is
   * about to unmount and cannot show its own confirmation.
   *
   * THE BUG THIS EXISTS FOR: `onSuccess` used to call the local `say()` and then
   * `onClose()`. `onClose` flips `isOpen` false, this component early-returns an
   * empty fragment, and the `<Toast>` it owns is UNMOUNTED in the same commit —
   * so the success message never rendered. Ordering the two calls does not help;
   * a comment here once claimed it did. The confirmation has to be owned by
   * something that stays on screen, which is the parent.
   */
  onBooked?: (message: string) => void;
  /** Optional prefill, used by the availability board so that picking a free
   *  room carries the window the user was already looking at straight into the
   *  form. "HH:MM", matching the <input type="time"> value. */
  initialStartTime?: string;
  initialEndTime?: string;
  initialFacilityID?: number | null;
}

/** Local wall-clock date + "HH:MM" -> UNIX seconds.
 *
 *  Browser-local, exactly like the booking path this replaces. Recurrence uses
 *  the same arithmetic (see src/lib/schemas/recurrence.ts) precisely so there is
 *  no second timezone story in the app. */
function toEpoch(day: Date, hhmm: string): number | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    return null;
  }
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/**
 * Location display order.
 *
 * NOT ALPHABETICAL, AND THE REASON IS IN THE DATA. 31 of the hall's 47
 * facilities are per-block pantries whose location strings all begin "Block N".
 * Sorted alphabetically those seven groups land ABOVE every shared space, so the
 * picker opens on "Block 2 Pantry" and anyone booking the Band Room scrolls past
 * thirty pantries to reach it. That is what the list actually did until browser
 * testing showed it.
 *
 * So: shared spaces first (alphabetically among themselves), then the block
 * pantries in numeric order. Derived from the location string rather than a
 * hardcoded list of room names, so a new shared space sorts correctly on the day
 * it is added and a new block sorts after them without a code change.
 */
export function compareFacilityLocations(a: string, b: string): number {
  const blockNum = (s: string) => {
    const m = /^Block\s+(\d+)/i.exec(s);
    return m ? Number(m[1]) : null;
  };
  const na = blockNum(a);
  const nb = blockNum(b);
  if (na === null && nb !== null) return -1;
  if (na !== null && nb === null) return 1;
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b);
}

const fmtTime = (epoch: number) => format(new Date(epoch * 1000), "h:mm a");
const fmtDay = (epoch: number) => format(new Date(epoch * 1000), "EEE d MMM");

const BookingModal: React.FC<BookingModalProps> = ({
  isOpen,
  onClose,
  facilities,
  userId,
  currentDate,
  refetch,
  canCreateSeries,
  onBooked,
  initialStartTime,
  initialEndTime,
  initialFacilityID,
}) => {
  const [startDate, setStartDate] = useState(currentDate);
  const [endDate, setEndDate] = useState(currentDate);
  // facilityID, not facilityName. The old code carried the DISPLAY NAME in state
  // and resolved it back with `facilities.find(e => e.facilityName == selected)`
  // on submit, which silently yields `undefined` -> `Number(undefined)` -> NaN
  // for any name that does not round-trip.
  const [facilityID, setFacilityID] = useState<number | null>(
    initialFacilityID ?? null,
  );
  const [eventName, setEventName] = useState("");
  const [startTime, setStartTime] = useState(initialStartTime ?? "09:00");
  const [endTime, setEndTime] = useState(initialEndTime ?? "10:00");

  const [repeats, setRepeats] = useState(false);
  const [repeatUntil, setRepeatUntil] = useState(currentDate);

  const [toastContent, setToastContent] = useState("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState(false);

  const say = (content: string, type: "success" | "danger") => {
    setToastContent(content);
    setToastType(type);
    setToastOpen(true);
  };

  // 08 §1.2: `userId` is the canonical session userID, EMPTY for an account that
  // is not on @u.nus.edu. Key off the id itself — NOT session.user.eligible,
  // which is `true` for these accounts while the auth kill switch sits at its
  // default "off", so an eligible-keyed check no-ops.
  const hasIdentity = Boolean(userId);

  /* ---- The window under consideration ---------------------------------- */
  const startEpoch = toEpoch(startDate, startTime);
  const endEpoch = toEpoch(repeats ? startDate : endDate, endTime);
  const windowValid =
    startEpoch !== null && endEpoch !== null && endEpoch > startEpoch;

  /* ---- Occurrences, for a repeating booking ---------------------------- */
  const occurrenceWindows: SeriesWindow[] = useMemo(() => {
    if (!repeats || !windowValid) return [];
    const untilEpoch = toEpoch(repeatUntil, endTime);
    if (untilEpoch === null) return [];
    return expandWeekly({ startTime: startEpoch, endTime: endEpoch }, untilEpoch);
  }, [repeats, windowValid, startEpoch, endEpoch, repeatUntil, endTime]);

  /* ---- DEBOUNCE ---------------------------------------------------------
   * The window changes on every keystroke in a <input type="time">. Querying on
   * each one would issue a request per digit and, worse, would race: the answer
   * to an older window can land after a newer one. `settledKey` lags `liveKey`
   * by 350ms of quiet, and the annotation below is only trusted when the two
   * agree — the same shape InterviewSlots.tsx already uses for this exact query.
   */
  const liveKey = windowValid ? `${startEpoch}:${endEpoch}` : "";
  const [settledKey, setSettledKey] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettledKey(liveKey), 350);
    return () => clearTimeout(t);
  }, [liveKey]);

  const settledRange = useMemo(() => {
    if (settledKey === "") return null;
    const [s, e] = settledKey.split(":").map(Number);
    return s !== undefined && e !== undefined
      ? { startTime: s, endTime: e }
      : null;
  }, [settledKey]);

  const availabilityQuery = api.bookings.getFacilityAvailability.useQuery(
    settledRange ?? { startTime: 0, endTime: 0 },
    {
      enabled: settledRange !== null && isOpen && hasIdentity && !repeats,
      staleTime: 30 * 1000,
      placeholderData: (prev) => prev,
    },
  );

  /* Only annotate when the ANSWER MATCHES THE WINDOW ON SCREEN. While the user
   * is still typing, the newest data describes an older window, and a room
   * labelled "free" for a window nobody asked about is worse than one labelled
   * nothing at all. */
  const availabilityFresh =
    liveKey !== "" && liveKey === settledKey && !availabilityQuery.isFetching;

  const availability = useMemo(
    () =>
      new Map(
        (availabilityFresh ? (availabilityQuery.data ?? []) : []).map((a) => [
          a.facilityID,
          a,
        ]),
      ),
    [availabilityFresh, availabilityQuery.data],
  );

  /* ---- Series preview --------------------------------------------------- */
  const seriesShapeError =
    repeats && occurrenceWindows.length > 0
      ? validateSeriesWindows(occurrenceWindows)
      : null;

  const previewQuery = api.bookings.previewSeries.useQuery(
    {
      facilityID: facilityID ?? -1,
      windows: occurrenceWindows,
    },
    {
      enabled:
        repeats &&
        isOpen &&
        hasIdentity &&
        canCreateSeries &&
        facilityID !== null &&
        occurrenceWindows.length > 0 &&
        seriesShapeError === null,
      staleTime: 30 * 1000,
      placeholderData: (prev) => prev,
    },
  );

  /* ---- Grouped, annotated room list ------------------------------------- */
  const grouped = useMemo(() => {
    const byLocation = new Map<string, PickerFacility[]>();
    for (const f of [...facilities].sort((a, b) =>
      a.facilityName.localeCompare(b.facilityName),
    )) {
      const key = f.facilityLocation || "Other";
      const list = byLocation.get(key) ?? [];
      list.push(f);
      byLocation.set(key, list);
    }
    return [...byLocation.entries()].sort((a, b) =>
      compareFacilityLocations(a[0], b[0]),
    );
  }, [facilities]);

  /**
   * Why a room cannot be picked, or null when it can.
   *
   * ORDER IS THE POINT. A room that is closed to everyone is closed whatever the
   * clock says, and a room the caller may not book is not made bookable by being
   * free — so the reasons are evaluated most-permanent first. Reporting "taken
   * 3:00–4:00" for the Dance Studio would send someone off to move their times
   * for a room they were never going to get.
   *
   * FAILS OPEN on the availability axis: an unanswered or failed query leaves
   * `availability` empty and every room simply unannotated, never disabled. A
   * client-only lockout with no server denial behind it is the I-7 violation the
   * repo warns about; the server re-checks on submit regardless.
   */
  const blockedReason = (
    f: PickerFacility,
  ): { kind: "closed" | "role" | "taken"; text: string } | null => {
    if (f.closed) {
      return {
        kind: "closed",
        text: f.closedNote ?? "Not bookable through RHApp",
      };
    }
    if (!f.canBook) {
      return {
        kind: "role",
        text: `Restricted to ${f.requiredRoles.join(" or ")}`,
      };
    }
    /* THE TIME AXIS DOES NOT APPLY TO A REPEATING BOOKING, and leaving it in
     * broke the feature outright.
     *
     * In repeat mode this room list describes a SERIES, not a single window, and
     * conflicts are reported per occurrence by the preview below — which exists
     * precisely so a head can book the twelve free weeks of a fifteen-week term.
     * Disabling the room because occurrence ONE clashes made that unreachable:
     * the room could not be selected, so the preview never rendered, so the
     * twelve free weeks were unbookable. Browser testing caught it; Meeting Room
     * has a booking this morning and could not be picked for a term at all.
     *
     * The closed and role axes above still apply — those are properties of the
     * room and the caller, true for every occurrence.
     */
    if (repeats) return null;

    const a = availability.get(f.facilityID);
    if (a && !a.available && a.conflict) {
      const c = a.conflict;
      return {
        kind: "taken",
        text: `Taken ${fmtTime(c.startTime)}–${fmtTime(c.endTime)}${
          c.eventName ? ` · ${c.eventName}` : ""
        }`,
      };
    }
    return null;
  };

  const selected = facilities.find((f) => f.facilityID === facilityID) ?? null;
  const selectedBlocked = selected ? blockedReason(selected) : null;

  /* ---- Mutations -------------------------------------------------------- */
  const createBooking = api.bookings.createBooking.useMutation({
    onSuccess: () => {
      // Handed to the PARENT, which stays mounted. See `onBooked` for why this
      // cannot be the local toast: onClose unmounts this component, and the
      // Toast it owns, in the same commit.
      onBooked?.(
        `Booked ${selected?.facilityName ?? "the room"} for ${format(
          startDate,
          "EEE d MMM",
        )}, ${startTime}–${endTime}.`,
      );
      refetch();
      onClose();
    },
    onError: (error) => say(error.message || "Booking failed.", "danger"),
  });

  const createSeries = api.bookings.createSeries.useMutation({
    onSuccess: (res) => {
      onBooked?.(
        res.skipped > 0
          ? `Booked ${res.created} sessions. ${res.skipped} were already taken and were skipped.`
          : `Booked all ${res.created} sessions.`,
      );
      refetch();
      onClose();
    },
    onError: (error) => say(error.message || "Booking failed.", "danger"),
  });

  const submitting = createBooking.isPending || createSeries.isPending;

  /* ---- Submit ----------------------------------------------------------- */
  const handleSubmit = () => {
    /* EVERY REFUSAL BELOW SAYS SOMETHING. The version this replaces wrapped the
     * whole mutation in `if (startHour !== undefined && endHour !== undefined)`
     * and returned silently when that was false — a Confirm button that did
     * nothing, with no toast and no log, and no way for the user to tell a dead
     * button from a slow network. */
    if (!hasIdentity) return say(NO_IDENTITY_MESSAGE, "danger");
    if (facilityID === null) return say("Pick a room first.", "danger");
    if (!eventName.trim()) return say("Give the booking a name.", "danger");

    if (startEpoch === null || endEpoch === null) {
      return say("Enter a valid start and end time.", "danger");
    }
    if (endEpoch <= startEpoch) {
      return say("The end time has to be after the start time.", "danger");
    }
    if (selectedBlocked) {
      return say(selectedBlocked.text, "danger");
    }

    if (!repeats) {
      createBooking.mutate({
        ccaID: 0,
        eventName: eventName.trim(),
        description: "",
        startTime: startEpoch,
        endTime: endEpoch,
        facilityID,
        forceBook: false,
      });
      return;
    }

    const shapeError = validateSeriesWindows(occurrenceWindows);
    if (shapeError) return say(shapeError, "danger");

    const clashes = previewQuery.data?.clashCount ?? 0;
    createSeries.mutate({
      facilityID,
      ccaID: 0,
      eventName: eventName.trim(),
      description: "",
      windows: occurrenceWindows,
      // The preview has already shown exactly which weeks clash, so pressing
      // Confirm IS the answer to it. Sending `false` when nothing clashes keeps
      // the server strict for a series the user never saw a warning about.
      skipConflicts: clashes > 0,
    });
  };

  const shiftDate = (
    which: "start" | "end" | "until",
    direction: "prev" | "next",
  ) => {
    const delta = direction === "prev" ? -1 : 1;
    if (which === "start") {
      const d = new Date(startDate);
      d.setDate(d.getDate() + delta);
      setStartDate(d);
      if (d > endDate) setEndDate(d);
      if (d > repeatUntil) setRepeatUntil(d);
      return;
    }
    if (which === "end") {
      const d = new Date(endDate);
      d.setDate(d.getDate() + delta);
      if (d >= startDate) setEndDate(d);
      return;
    }
    const d = new Date(repeatUntil);
    d.setDate(d.getDate() + delta);
    if (d >= startDate) setRepeatUntil(d);
  };

  useEffect(() => {
    setStartDate(currentDate);
    setEndDate(currentDate);
    setRepeatUntil(currentDate);
  }, [currentDate]);

  /* RESET AND RE-PREFILL ON EVERY OPEN.
   *
   * This component stays MOUNTED between openings — the parents render it
   * unconditionally and it early-returns on `!isOpen` — so without this its
   * state survives being closed. Browser testing caught what that does: book
   * Quiet Room as "Toast check", reopen the dialog, and the room and the event
   * name are both still filled in. Pressing Confirm then RESUBMITS the previous
   * booking, which the server correctly refuses with "Conflicting bookings
   * exist" — an error the user did nothing to deserve and cannot explain.
   *
   * The ROOM and the NAME identify a specific booking, so both are cleared. The
   * TIMES are deliberately kept: they are browsing context rather than a
   * commitment, and someone who was looking at 2–3pm probably still is.
   *
   * Guarded on `isOpen` so it never stomps on edits made while the form is open.
   */
  useEffect(() => {
    if (!isOpen) return;
    setEventName("");
    setRepeats(false);
    setFacilityID(initialFacilityID ?? null);
    if (initialStartTime) setStartTime(initialStartTime);
    if (initialEndTime) setEndTime(initialEndTime);
  }, [isOpen, initialStartTime, initialEndTime, initialFacilityID]);

  if (!isOpen) return <></>;

  const preview = previewQuery.data;

  return (
    <>
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
        <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="text-lg font-semibold">Book a Facility</h2>
            <button onClick={onClose} aria-label="Close">
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>

          {!hasIdentity ? (
            /* 08 §1.2: a dedicated, explanatory state, matching the panel in
               profile/page.tsx. The booking form is not rendered at all — the
               server denies the write with NO_IDENTITY in every enforcement
               mode, so offering a form that can only ever fail is the silent
               failure this section exists to remove. */
            <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
              <AlertTriangle className="h-10 w-10 text-amber-500" />
              <h3 className="text-lg font-medium text-gray-900">
                Bookings can&apos;t be made from this account
              </h3>
              <p className="max-w-md text-sm text-gray-600">
                {NO_IDENTITY_MESSAGE}
              </p>
              <button
                onClick={onClose}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-4 overflow-y-auto p-4">
              {/* ── 1. WHEN ────────────────────────────────────────────────
                  Dates and times come BEFORE the room, and that order is the
                  whole feature rather than a layout preference: a room cannot be
                  labelled free or taken until the window is known. The previous
                  layout asked for the facility first, which structurally
                  prevented showing availability at all. */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    <CalendarIcon className="mr-1 inline h-4 w-4" />
                    {repeats ? "First session" : "Start date"}
                  </label>
                  <div className="flex items-center justify-between rounded-lg bg-gray-100 p-2">
                    <button
                      onClick={() => shiftDate("start", "prev")}
                      aria-label="Previous day"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-sm">
                      {format(startDate, "eee, MMM d yyyy")}
                    </span>
                    <button
                      onClick={() => shiftDate("start", "next")}
                      aria-label="Next day"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    <CalendarIcon className="mr-1 inline h-4 w-4" />
                    {repeats ? "Repeat until" : "End date"}
                  </label>
                  <div className="flex items-center justify-between rounded-lg bg-gray-100 p-2">
                    <button
                      onClick={() => shiftDate(repeats ? "until" : "end", "prev")}
                      aria-label="Previous day"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-sm">
                      {format(repeats ? repeatUntil : endDate, "eee, MMM d yyyy")}
                    </span>
                    <button
                      onClick={() => shiftDate(repeats ? "until" : "end", "next")}
                      aria-label="Next day"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                {(["Start Time", "End Time"] as const).map((label, idx) => (
                  <div key={label}>
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      <Clock className="mr-1 inline h-4 w-4" /> {label}
                    </label>
                    <input
                      type="time"
                      value={idx === 0 ? startTime : endTime}
                      onChange={(e) =>
                        idx === 0
                          ? setStartTime(e.target.value)
                          : setEndTime(e.target.value)
                      }
                      className="w-full rounded-lg border border-gray-300 p-3"
                    />
                  </div>
                ))}
              </div>

              {windowValid ? null : (
                <p className="text-sm text-red-600">
                  The end time has to be after the start time.
                </p>
              )}

              {/* ── 2. REPEAT ──────────────────────────────────────────────
                  Rendered only for a session that may actually use it. The
                  control being absent is not the gate — `createSeries` is
                  role-gated server-side (I-7: the client is never the only
                  check, and never stricter than the server). */}
              {canCreateSeries && (
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                  <input
                    type="checkbox"
                    checked={repeats}
                    onChange={(e) => setRepeats(e.target.checked)}
                    className="h-4 w-4 accent-emerald-600"
                  />
                  <Repeat className="h-4 w-4 text-gray-500" />
                  <span className="text-sm text-gray-700">
                    Repeat weekly on{" "}
                    <strong>{format(startDate, "EEEE")}</strong>s until the date
                    above
                  </span>
                </label>
              )}

              {/* ── 3. WHERE ───────────────────────────────────────────────── */}
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <label className="block text-sm font-medium text-gray-700">
                    <MapPin className="mr-1 inline h-4 w-4" /> Facility
                  </label>
                  {!repeats && windowValid && (
                    <span className="text-xs text-gray-500">
                      {availabilityQuery.isFetching || !availabilityFresh
                        ? "Checking availability…"
                        : `Free for ${startTime}–${endTime}`}
                    </span>
                  )}
                </div>

                <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-gray-200 p-2">
                  {grouped.map(([location, rooms]) => (
                    <div key={location}>
                      <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
                        {location}
                      </p>
                      <div className="space-y-1">
                        {rooms.map((f) => {
                          const blocked = blockedReason(f);
                          const isSelected = f.facilityID === facilityID;
                          return (
                            <button
                              key={f.facilityID}
                              type="button"
                              disabled={blocked !== null}
                              onClick={() => setFacilityID(f.facilityID)}
                              className={`flex w-full items-start gap-2 rounded-md border p-2 text-left text-sm transition-colors ${
                                blocked
                                  ? "cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400"
                                  : isSelected
                                    ? "border-emerald-600 bg-emerald-50 text-emerald-900"
                                    : "border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/40"
                              }`}
                            >
                              <span className="mt-0.5 flex-none">
                                {blocked?.kind === "closed" ? (
                                  <Ban className="h-4 w-4" />
                                ) : blocked?.kind === "role" ? (
                                  <Lock className="h-4 w-4" />
                                ) : blocked ? (
                                  <Clock className="h-4 w-4" />
                                ) : (
                                  <Check className="h-4 w-4 text-emerald-600" />
                                )}
                              </span>
                              <span className="min-w-0">
                                <span className="block font-medium">
                                  {f.facilityName}
                                </span>
                                {blocked && (
                                  <span className="block text-xs">
                                    {blocked.text}
                                  </span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── 4. THE SERIES PREVIEW ──────────────────────────────────
                  Nothing is written until this has been seen and confirmed. */}
              {repeats && facilityID !== null && (
                <div className="rounded-lg border border-gray-200 p-3">
                  {seriesShapeError ? (
                    <p className="text-sm text-red-600">{seriesShapeError}</p>
                  ) : occurrenceWindows.length === 0 ? (
                    <p className="text-sm text-gray-500">
                      Pick a &ldquo;repeat until&rdquo; date on or after the
                      first session.
                    </p>
                  ) : previewQuery.isPending ? (
                    <p className="text-sm text-gray-500">
                      Checking {occurrenceWindows.length} sessions…
                    </p>
                  ) : preview ? (
                    <>
                      <p className="mb-2 text-sm">
                        <strong className="text-emerald-700">
                          {preview.freeCount} free
                        </strong>
                        {preview.clashCount > 0 && (
                          <>
                            {" · "}
                            <strong className="text-amber-700">
                              {preview.clashCount} already taken
                            </strong>
                          </>
                        )}
                        {occurrenceWindows.length ===
                          SERIES_MAX_OCCURRENCES && (
                          <span className="text-gray-500">
                            {" "}
                            (capped at {SERIES_MAX_OCCURRENCES})
                          </span>
                        )}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {preview.occurrences.map((o) => (
                          <span
                            key={o.startTime}
                            title={
                              o.conflict
                                ? `${fmtTime(o.conflict.startTime)}–${fmtTime(
                                    o.conflict.endTime,
                                  )} ${o.conflict.eventName ?? ""}`
                                : "Free"
                            }
                            className={`rounded px-1.5 py-0.5 text-xs ${
                              o.available
                                ? "bg-emerald-50 text-emerald-800"
                                : "bg-amber-50 text-amber-800 line-through"
                            }`}
                          >
                            {fmtDay(o.startTime)}
                          </span>
                        ))}
                      </div>
                      {preview.clashCount > 0 && (
                        <p className="mt-2 text-xs text-gray-500">
                          Confirming books the {preview.freeCount} free sessions
                          and skips the rest.
                        </p>
                      )}
                    </>
                  ) : null}
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  <User className="mr-1 inline h-4 w-4" /> Event Name
                </label>
                <input
                  type="text"
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 p-3"
                  placeholder="Your event name"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                {/* The button is disabled only for things the user can see and
                    fix. Every other refusal goes through handleSubmit and says
                    why — a disabled button with no explanation is the failure
                    mode this whole pass exists to remove. */}
                <button
                  onClick={handleSubmit}
                  disabled={submitting}
                  className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-700 disabled:bg-gray-300"
                >
                  {submitting
                    ? "Booking…"
                    : repeats && preview
                      ? `Confirm ${preview.freeCount} sessions`
                      : "Confirm Booking"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default BookingModal;
