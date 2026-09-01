"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  Check,
  Ban,
  Lock,
  AlertTriangle,
} from "lucide-react";
import { format } from "date-fns";

import { api } from "~/trpc/react";
import BookingModal, {
  type PickerFacility,
  compareFacilityLocations,
} from "~/app/_components/BookingModal";
import Toast from "~/app/_components/Toast";
import { ADMIN_ROLE, JCRC_ROLE, CCA_HEAD_ROLE } from "~/lib/roleNames";

/** "HH:MM" for a Date, in the browser's local zone — the same wall-clock basis
 *  every other booking control in this app uses. */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

/** Round up to the next half hour. Nobody books at 20:37, and defaulting to a
 *  ragged "now" produces a window whose end lands mid-minute too. */
function nextHalfHour(from: Date): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

function toEpoch(day: Date, time: string): number | null {
  const [h, m] = time.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) {
    return null;
  }
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

const fmtTime = (epoch: number) => format(new Date(epoch * 1000), "h:mm a");

/**
 * THE AVAILABILITY BOARD — "what's free right now?", asked time-first.
 *
 * The booking modal answers "is THIS room free?" once a window is chosen. This
 * answers the question people actually walk up with: I need somewhere for an
 * hour, what can I have. Same endpoint (`getFacilityAvailability`), same
 * debounce and staleness discipline, different question.
 *
 * IT IS A READ-ONLY VIEW WITH ONE DOOR OUT. Picking a free room opens the
 * booking modal prefilled with the window already on screen, so the user never
 * re-types what they just chose. The modal remains the only thing that writes,
 * and the server remains the only thing that decides.
 */
export default function AvailabilityBoard() {
  const { data: session } = useSession();
  // 08 §1.2: the canonical session userID, "" for a non-@u.nus.edu account.
  // Every identity check keys off this, NOT session.user.eligible.
  const userID = session?.user?.userID ?? "";
  const hasIdentity = Boolean(userID);

  const [day, setDay] = useState<Date>(() => new Date());
  const [startTime, setStartTime] = useState<string>(() =>
    hhmm(nextHalfHour(new Date())),
  );
  const [endTime, setEndTime] = useState<string>(() => {
    const d = nextHalfHour(new Date());
    d.setHours(d.getHours() + 1);
    return hhmm(d);
  });

  const [modalOpen, setModalOpen] = useState(false);
  const [pickedFacility, setPickedFacility] = useState<number | null>(null);

  // Owned HERE rather than in the modal: the modal unmounts the moment a
  // booking succeeds, taking any toast it owns with it. See BookingModal.onBooked.
  const [toastContent, setToastContent] = useState("");
  const [toastOpen, setToastOpen] = useState(false);

  const startEpoch = toEpoch(day, startTime);
  const endEpoch = toEpoch(day, endTime);
  const windowValid =
    startEpoch !== null && endEpoch !== null && endEpoch > startEpoch;

  /* ---- DEBOUNCE + STALENESS GUARD --------------------------------------
   * Identical discipline to BookingModal and InterviewSlots: the window changes
   * on every keystroke in a time input, so the query lags by 350ms of quiet, and
   * the answer is only trusted when it describes the window currently on screen.
   * A board that labels rooms "free" for a window nobody asked about is worse
   * than one that says nothing. */
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
      enabled: settledRange !== null && hasIdentity,
      staleTime: 30 * 1000,
      placeholderData: (prev) => prev,
    },
  );

  // Permissions and closures. Separate query because it does not depend on the
  // window — it is fetched once and reused as the user scrubs through times.
  const bookableQuery = api.bookings.getFacilitiesForBooking.useQuery(undefined, {
    enabled: hasIdentity,
  });

  const fresh =
    liveKey !== "" && liveKey === settledKey && !availabilityQuery.isFetching;

  const canCreateSeries = useMemo(() => {
    const roles = session?.user?.roles ?? [];
    return (
      roles.includes(ADMIN_ROLE) ||
      roles.includes(JCRC_ROLE) ||
      roles.includes(CCA_HEAD_ROLE)
    );
  }, [session]);

  /** The picker payload the modal needs, in the modal's own shape. */
  const pickerFacilities: PickerFacility[] = useMemo(
    () =>
      (bookableQuery.data ?? []).map((f) => ({
        facilityID: f.facilityID,
        facilityName: f.facilityName,
        facilityLocation: f.facilityLocation,
        canBook: f.canBook,
        requiredRoles: f.requiredRoles,
        closed: f.closed,
        closedNote: f.closedNote,
      })),
    [bookableQuery.data],
  );

  /**
   * Rooms, grouped by location, each carrying its status for the chosen window.
   *
   * THREE AXES, RESOLVED MOST-PERMANENT FIRST, exactly as the booking picker
   * does: closed to everyone, then restricted to roles the caller lacks, then
   * taken for this window. Reporting "taken 8–10:30" for a room nobody can book
   * here would send someone off to move their times for nothing.
   *
   * FAILS OPEN on the availability axis: before the query answers, or if it
   * fails, rooms are shown UNKNOWN rather than free or taken. A board that
   * guesses is worse than one that admits it does not know yet.
   */
  const groups = useMemo(() => {
    const perms = new Map(
      (bookableQuery.data ?? []).map((f) => [f.facilityID, f]),
    );
    const avail = new Map(
      (fresh ? (availabilityQuery.data ?? []) : []).map((a) => [
        a.facilityID,
        a,
      ]),
    );

    const rows = (availabilityQuery.data ?? []).map((f) => {
      const p = perms.get(f.facilityID);
      const a = avail.get(f.facilityID);

      let status: "free" | "taken" | "closed" | "restricted" | "unknown";
      let detail: string | null = null;

      if (p?.closed) {
        status = "closed";
        detail = p.closedNote ?? "Not bookable through RHApp";
      } else if (p && !p.canBook) {
        status = "restricted";
        detail = `Needs ${p.requiredRoles.join(" or ")}`;
      } else if (!a) {
        status = "unknown";
      } else if (a.available) {
        status = "free";
      } else {
        status = "taken";
        detail = a.conflict
          ? `${fmtTime(a.conflict.startTime)}–${fmtTime(a.conflict.endTime)}${
              a.conflict.eventName ? ` · ${a.conflict.eventName}` : ""
            }`
          : "Already booked";
      }

      return {
        facilityID: f.facilityID,
        name: f.facilityName,
        location: f.facilityLocation || "Other",
        status,
        detail,
      };
    });

    const byLocation = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byLocation.get(r.location) ?? [];
      list.push(r);
      byLocation.set(r.location, list);
    }
    return [...byLocation.entries()]
      .sort((a, b) => compareFacilityLocations(a[0], b[0]))
      .map(([location, list]) => ({
        location,
        // Free rooms first — this view exists to answer "what CAN I have",
        // so the answer belongs at the top of each group rather than in
        // alphabetical order among rooms that are not on offer.
        rooms: list.slice().sort((a, b) => {
          const rank = (s: string) =>
            s === "free" ? 0 : s === "unknown" ? 1 : s === "taken" ? 2 : 3;
          const d = rank(a.status) - rank(b.status);
          return d !== 0 ? d : a.name.localeCompare(b.name);
        }),
        freeCount: list.filter((r) => r.status === "free").length,
      }));
  }, [availabilityQuery.data, bookableQuery.data, fresh]);

  const totalFree = groups.reduce((n, g) => n + g.freeCount, 0);
  const totalRooms = groups.reduce((n, g) => n + g.rooms.length, 0);

  const shiftDay = (delta: number) => {
    const d = new Date(day);
    d.setDate(d.getDate() + delta);
    setDay(d);
  };

  /** Jump the window to the next hour starting now. */
  const useNow = () => {
    const s = nextHalfHour(new Date());
    const e = new Date(s);
    e.setHours(e.getHours() + 1);
    setDay(new Date());
    setStartTime(hhmm(s));
    setEndTime(hhmm(e));
  };

  if (!hasIdentity) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16">
        <div className="flex flex-col items-center gap-4 rounded-lg border border-amber-200 bg-amber-50 p-8 text-center">
          <AlertTriangle className="h-9 w-9 text-amber-500" />
          <h2 className="text-lg font-medium text-gray-900">
            Sign in to see room availability
          </h2>
          <p className="max-w-md text-sm text-gray-600">
            Availability is only shown to signed-in hall accounts. Sign in with
            your @u.nus.edu email to see which rooms are free.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Toast
        content={toastContent}
        type="success"
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <BookingModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        facilities={pickerFacilities}
        userId={userID}
        currentDate={day}
        refetch={() => void availabilityQuery.refetch()}
        canCreateSeries={canCreateSeries}
        initialStartTime={startTime}
        initialEndTime={endTime}
        initialFacilityID={pickedFacility}
        onBooked={(message) => {
          setToastContent(message);
          setToastOpen(true);
        }}
      />

      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {/* ── The window ─────────────────────────────────────────────── */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                <CalendarIcon className="mr-1 inline h-4 w-4" /> Day
              </label>
              <div className="flex items-center justify-between rounded-lg bg-gray-100 p-2">
                <button onClick={() => shiftDay(-1)} aria-label="Previous day">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm">{format(day, "eee, MMM d")}</span>
                <button onClick={() => shiftDay(1)} aria-label="Next day">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                <Clock className="mr-1 inline h-4 w-4" /> From
              </label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full rounded-lg border border-gray-300 p-2"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                <Clock className="mr-1 inline h-4 w-4" /> To
              </label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-lg border border-gray-300 p-2"
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={useNow}
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
            >
              Next hour
            </button>
            {!windowValid && (
              <span className="text-sm text-red-600">
                The end time has to be after the start time.
              </span>
            )}
            {windowValid && (
              <span className="text-sm text-gray-500">
                {!fresh
                  ? "Checking…"
                  : `${totalFree} of ${totalRooms} rooms free`}
              </span>
            )}
          </div>
        </div>

        {/* ── The board ──────────────────────────────────────────────── */}
        <div className="mt-6 space-y-6">
          {groups.map((g) => (
            <div key={g.location}>
              <div className="mb-2 flex items-baseline gap-2 border-b border-gray-200 pb-1">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-700">
                  {g.location}
                </h2>
                <span className="text-xs text-gray-400">
                  {g.freeCount} free
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {g.rooms.map((r) => {
                  const isFree = r.status === "free";
                  return (
                    <button
                      key={r.facilityID}
                      type="button"
                      disabled={!isFree}
                      onClick={() => {
                        setPickedFacility(r.facilityID);
                        setModalOpen(true);
                      }}
                      className={`flex items-start gap-2 rounded-lg border p-3 text-left transition-colors ${
                        isFree
                          ? "border-emerald-200 bg-emerald-50/60 hover:border-emerald-500 hover:bg-emerald-50"
                          : "cursor-not-allowed border-gray-100 bg-gray-50 text-gray-400"
                      }`}
                    >
                      <span className="mt-0.5 flex-none">
                        {r.status === "free" ? (
                          <Check className="h-4 w-4 text-emerald-600" />
                        ) : r.status === "closed" ? (
                          <Ban className="h-4 w-4" />
                        ) : r.status === "restricted" ? (
                          <Lock className="h-4 w-4" />
                        ) : (
                          <Clock className="h-4 w-4" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block text-sm font-medium ${
                            isFree ? "text-emerald-900" : ""
                          }`}
                        >
                          {r.name}
                        </span>
                        <span className="block text-xs">
                          {r.status === "free"
                            ? "Free — tap to book"
                            : r.status === "unknown"
                              ? "Checking…"
                              : r.detail}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {groups.length === 0 && windowValid && (
            <p className="py-12 text-center text-gray-500">
              {availabilityQuery.isPending
                ? "Checking availability…"
                : "No facilities to show."}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
