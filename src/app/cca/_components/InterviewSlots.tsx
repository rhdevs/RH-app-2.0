"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  editSlotInput,
  INTERVIEW_LOCATION_MAX,
  MAX_SLOTS_PER_OPEN,
  SLOT_CAPACITY_DEFAULT,
  SLOT_CAPACITY_MAX,
  slotDraftSchema,
} from "~/lib/schemas/ccaApplication";

type Slot = RouterOutputs["ccaApplicationsHead"]["listSlots"]["slots"][number];

const DURATION_PRESETS = [10, 15, 20, 30, 45, 60];
/** 1 is a normal interview; the rest are the group sizes heads actually ask
 *  for. Anything else goes in the custom box. */
const CAPACITY_PRESETS = [1, 2, 3, 4, 6];

/** Seats still open on a slot. Never negative — a capacity lowered by hand
 *  below the occupancy would otherwise render "-1 left". */
function seatsLeft(slot: Slot): number {
  return Math.max(0, slot.capacity - slot.occupancy);
}

/** Occupant names for a card, truncated: four rows of names in a small card is
 *  noise, and the head opens the run-sheet to actually work through them. */
function occupantSummary(slot: Slot): string {
  const names = slot.occupants.map(
    (o) => o.applicant.displayName ?? o.applicant.email ?? o.userID,
  );
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

/* ------------------------------- time helpers ------------------------------ */

/** Local date (YYYY-MM-DD) + "HH:MM" → epoch seconds, built from local parts so
 *  there is no UTC off-by-one. */
function toEpoch(dateStr: string, hhmm: string): number | null {
  if (!dateStr || !hhmm) return null;
  const [Y, M, D] = dateStr.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  if ([Y, M, D, h, m].some((n) => n === undefined || Number.isNaN(n))) {
    return null;
  }
  return Math.floor(new Date(Y!, M! - 1, D!, h!, m!, 0, 0).getTime() / 1000);
}
/**
 * The window [start, end) for one date plus a from/to time, ROLLING THE END
 * PAST MIDNIGHT when it would otherwise not be after the start.
 *
 * "22:00 → 00:00" is how a 24-hour time picker spells "run until the end of the
 * day", and "22:00 → 02:00" spells a late session — but read literally against
 * the same date both land BEFORE the start, so the generator produced zero
 * candidates and the form looked broken with nothing to explain it. Midnight is
 * not an edge case here: it is the value a head reaches for whenever the last
 * interview is the last thing of the day.
 *
 * `nextDay` is returned rather than kept quiet so the preview can SAY the window
 * crosses midnight. A rollover the head did not intend (a mistyped 14:00 → 09:00)
 * is then visible as "ends tomorrow" plus a preview full of slots, instead of
 * being applied silently.
 */
function toWindow(
  dateStr: string,
  fromHHMM: string,
  toHHMM: string,
): { start: number; end: number; nextDay: boolean } | null {
  const start = toEpoch(dateStr, fromHHMM);
  const sameDayEnd = toEpoch(dateStr, toHHMM);
  if (start === null || sameDayEnd === null) return null;
  if (sameDayEnd > start) return { start, end: sameDayEnd, nextDay: false };
  // Start == end is a typo, not a 24-hour day of interviews. Rolling it over
  // would silently propose 96 slots off two identical times.
  if (sameDayEnd === start) return null;
  // +1 DAY in local terms, via the date parts — NOT +86400 seconds, which is an
  // hour out either side of a DST change. Singapore has none, but the app's
  // time inputs are local and this helper should not be the thing that has to
  // be revisited if that ever stops being true.
  const [Y, M, D] = dateStr.split("-").map(Number);
  const [h, m] = toHHMM.split(":").map(Number);
  if ([Y, M, D, h, m].some((n) => n === undefined || Number.isNaN(n))) {
    return null;
  }
  const end = Math.floor(
    new Date(Y!, M! - 1, D! + 1, h!, m!, 0, 0).getTime() / 1000,
  );
  return { start, end, nextDay: true };
}
function toDateInput(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function toTimeInput(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTime(epoch: number | null): string {
  if (epoch === null) return "—";
  return new Date(epoch * 1000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}
function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

/**
 * `value`, but only after it has stopped changing for `ms`.
 *
 * The room-availability lookup is keyed on the window the head is typing, and a
 * `<input type="time">` emits a change per keystroke — without this, "14:30"
 * fires four range scans of the whole Bookings collection, three of them for
 * windows that existed for 80ms. Debounce on a STRING key, never on the range
 * object: a fresh object every render would reset the timer forever.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/* ================================ component ================================= */

export default function InterviewSlots({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const list = api.ccaApplicationsHead.listSlots.useQuery(
    { ccaID },
    { retry: false },
  );

  const existing = useMemo(
    () =>
      (list.data?.slots ?? [])
        .filter((s) => s.startTime !== null && s.endTime !== null)
        .map((s) => ({ startTime: s.startTime!, endTime: s.endTime! })),
    [list.data],
  );

  // Free = NOBODY on it. A group slot with one person and three spare seats is
  // not free and is never bulk-cleared — same rule as the server's
  // clearFreeSlots, so this count and that mutation cannot disagree.
  const freeCount = useMemo(
    () => (list.data?.slots ?? []).filter((s) => s.occupancy === 0).length,
    [list.data],
  );

  const clear = api.ccaApplicationsHead.clearFreeSlots.useMutation({
    onSuccess: () => utils.ccaApplicationsHead.listSlots.invalidate({ ccaID }),
  });

  return (
    <div className="space-y-6">
      <SlotGenerator
        ccaID={ccaID}
        existing={existing}
        onCreated={() => utils.ccaApplicationsHead.listSlots.invalidate({ ccaID })}
      />

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-900">Schedule</h2>
          {freeCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              disabled={clear.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Clear all ${freeCount} empty slot${
                      freeCount === 1 ? "" : "s"
                    }? Slots with anyone booked on them are kept, and any room held only by the cleared slots is given back.`,
                  )
                ) {
                  clear.mutate({ ccaID });
                }
              }}
              className="text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2 className="mr-1.5 h-4 w-4" />
              {clear.isPending ? "Clearing…" : "Clear empty slots"}
            </Button>
          )}
        </div>
        {clear.error && (
          <p className="mb-2 text-sm text-red-600">
            {clear.error.message === "NOT_A_HEAD_OF_THIS_CCA"
              ? "You can only clear slots for CCAs you head."
              : "Those couldn’t be cleared. Try again."}
          </p>
        )}
        {list.isPending ? (
          <div className="h-32 animate-pulse rounded-lg bg-gray-200" />
        ) : list.error ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
            {list.error.message === "NOT_A_HEAD_OF_THIS_CCA"
              ? "You can only manage slots for CCAs you head."
              : "These couldn't be loaded."}
          </p>
        ) : (
          <ScheduleView ccaID={ccaID} slots={list.data.slots} />
        )}
      </section>
    </div>
  );
}

/* ------------------------------- generator --------------------------------- */

function SlotGenerator({
  ccaID,
  existing,
  onCreated,
}: {
  ccaID: number;
  existing: { startTime: number; endTime: number }[];
  onCreated: () => Promise<unknown>;
}) {
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [duration, setDuration] = useState(15);
  const [gap, setGap] = useState(0);
  // One capacity for the whole generated batch. Per-slot changes are an edit on
  // the card afterwards — a per-chip capacity picker in the preview would be a
  // lot of UI for a case that barely happens.
  const [capacity, setCapacity] = useState(SLOT_CAPACITY_DEFAULT);
  /** "" = no location, "other" = free text, otherwise a facilityID as a string —
   *  the same encoding the event proposal form uses, so the two location
   *  pickers behave identically. */
  const [facilitySelection, setFacilitySelection] = useState("");
  const [location, setLocation] = useState("");
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);

  // Public query (it feeds the signed-out calendar too), so a head with no
  // facility-booking role still sees the list — booking a room for interviews is
  // authorised by heading the CCA, and the server is the enforcement point.
  const facilitiesQuery = api.bookings.getAllFacilities.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const facilities = facilitiesQuery.data ?? [];
  const facilityID =
    facilitySelection !== "" && facilitySelection !== "other"
      ? Number(facilitySelection)
      : null;
  const facilityName =
    facilities.find((f) => f.facilityID === facilityID)?.facilityName ?? null;

  const create = api.ccaApplicationsHead.openSlots.useMutation({
    onSuccess: async () => {
      setRemoved(new Set());
      setFrom("");
      setTo("");
      setFormError(null);
      await onCreated();
    },
  });

  // Build the candidate slots from the range + duration, then annotate each with
  // whether it collides with an already-open slot (client-side, so the head sees
  // conflicts before submitting rather than getting a whole-batch rejection).
  const window = useMemo(() => toWindow(date, from, to), [date, from, to]);

  const candidates = useMemo(() => {
    if (window === null || duration <= 0) return [];
    const startEpoch = window.start;
    const endEpoch = window.end;
    const durSec = duration * 60;
    const gapSec = Math.max(0, gap) * 60;
    const now = Math.floor(Date.now() / 1000);

    const out: {
      index: number;
      startTime: number;
      endTime: number;
      conflict: boolean;
      past: boolean;
    }[] = [];
    let cursor = startEpoch;
    let index = 0;
    // Hard stop well above MAX_SLOTS_PER_OPEN so a silly range can't spin.
    while (cursor + durSec <= endEpoch && index < 500) {
      const s = cursor;
      const e = cursor + durSec;
      out.push({
        index,
        startTime: s,
        endTime: e,
        conflict: existing.some((x) => overlaps(s, e, x.startTime, x.endTime)),
        past: e <= now,
      });
      cursor = e + gapSec;
      index += 1;
    }
    return out;
  }, [window, duration, gap, existing]);

  const creatable = candidates.filter(
    (c) => !c.conflict && !c.past && !removed.has(c.index),
  );
  const overCap = creatable.length > MAX_SLOTS_PER_OPEN;

  /* ----------------------- which rooms are free then ---------------------- */

  // The window that would actually be BOOKED — the first creatable slot's start
  // to the last one's end, not the typed window, because excluded/past/clashing
  // chips are never opened and the room is not held for them. Falls back to the
  // typed window so the picker starts annotating as soon as the times are in,
  // before a duration has produced any chips.
  //
  // A plain derivation, NOT a useMemo: `creatable` is a fresh array every
  // render, so a memo keyed on it would recompute anyway — and the STRING is
  // what the rest of this depends on, which is stable whenever the times are.
  const rangeKey =
    creatable.length > 0
      ? `${Math.min(...creatable.map((c) => c.startTime))}:${Math.max(
          ...creatable.map((c) => c.endTime),
        )}`
      : window
        ? `${window.start}:${window.end}`
        : "";
  const settledKey = useDebounced(rangeKey, 400);
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
      enabled: settledRange !== null,
      staleTime: 30 * 1000,
      // react-query v5 spelling. Keeps the last answer on screen while the next
      // one loads, so the option labels don't flicker back to bare names.
      placeholderData: (prev) => prev,
    },
  );

  // Only annotate when the ANSWER MATCHES THE WINDOW ON SCREEN. While the head
  // is still typing, the newest data describes an older window, and a room
  // labelled "free" for a window nobody asked about is worse than one labelled
  // nothing at all.
  const availabilityFresh =
    rangeKey !== "" && rangeKey === settledKey && !availabilityQuery.isFetching;
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
  const freeCount = [...availability.values()].filter((a) => a.available).length;
  const selectedAvailability =
    facilityID !== null ? (availability.get(facilityID) ?? null) : null;
  const selectedBusy =
    selectedAvailability !== null && !selectedAvailability.available
      ? selectedAvailability.conflict
      : null;

  /** "Dance Studio" → "Dance Studio — booked 3:00–4:00 PM". */
  const optionLabel = (f: { facilityID: number; facilityName: string }) => {
    const a = availability.get(f.facilityID);
    if (!a || a.available || !a.conflict) return f.facilityName;
    return `${f.facilityName} — booked ${fmtTime(
      a.conflict.startTime,
    )}–${fmtTime(a.conflict.endTime)}`;
  };

  const msg = create.error?.message ?? "";
  // The room clash carries the taken window (FACILITY_BOOKED:start:end) so the
  // head is told WHEN it is taken and can move, rather than just "no".
  const clash = /^FACILITY_BOOKED:(\d+):(\d+)$/.exec(msg);
  const serverError = create.error
    ? clash
      ? `${facilityName ?? "That room"} is already booked ${fmtTime(
          Number(clash[1]),
        )}–${fmtTime(Number(clash[2]))}. Pick another time or room — nothing was opened.`
      : msg === "NO_SUCH_FACILITY"
        ? "That room no longer exists. Pick another."
        : msg === "DUPLICATE_SLOT"
          ? "One of these is identical to a slot you've already opened."
          : msg === "SLOT_OVERLAP"
            ? "One of these overlaps a slot that was just taken. Refresh and regenerate."
            : msg === "SLOT_IN_PAST"
              ? "Some of these are in the past."
              : msg === "NOT_A_HEAD_OF_THIS_CCA"
                ? "You're no longer a head of this CCA."
                : "Those didn't open. Try again."
    : null;

  const submit = () => {
    if (creatable.length === 0) return;
    if (overCap) {
      setFormError(
        `That's ${creatable.length} slots — open at most ${MAX_SLOTS_PER_OPEN} at a time. Narrow the range or lengthen each interview.`,
      );
      return;
    }
    if (capacity < 1 || capacity > SLOT_CAPACITY_MAX) {
      setFormError(
        `People per slot has to be between 1 and ${SLOT_CAPACITY_MAX}.`,
      );
      return;
    }
    if (facilitySelection === "other" && location.trim() === "") {
      setFormError("Type the location, or pick a room from the list.");
      return;
    }
    // Advisory check — the server re-checks under the facility lock and is the
    // only thing that can actually refuse (I-7). This just saves a round trip
    // for the case the head can already see on screen.
    if (selectedBusy) {
      setFormError(
        `${facilityName} is booked ${fmtTime(
          selectedBusy.startTime,
        )}–${fmtTime(selectedBusy.endTime)}. Pick another room or move the window.`,
      );
      return;
    }
    // Validate each against the shared schema before sending. `capacity` is
    // sent explicitly rather than left to the schema default, so what the head
    // sees in the preview is literally what is transmitted.
    //
    // `location` is only sent for a free-text choice: when a facility is picked
    // the SERVER denormalizes its name into every slot, so the browser never
    // gets to decide what the room is called.
    const slots = creatable.map((c) => ({
      startTime: c.startTime,
      endTime: c.endTime,
      location: facilityID === null ? location.trim() || undefined : undefined,
      capacity,
    }));
    for (const s of slots) {
      if (!slotDraftSchema.safeParse(s).success) {
        setFormError("One of the generated slots isn't valid.");
        return;
      }
    }
    setFormError(null);
    create.mutate({
      ccaID,
      slots,
      ...(facilityID !== null ? { facilityID } : {}),
    });
  };

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900">
        Generate interview slots
      </h2>
      <p className="mt-0.5 text-sm text-gray-500">
        Pick a window and how long each interview runs — we&rsquo;ll lay out the
        slots for you.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Date">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="From">
          <input
            type="time"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="To">
          <input
            type="time"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Location">
          <select
            value={facilitySelection}
            onChange={(e) => setFacilitySelection(e.target.value)}
            className={inputCls}
          >
            <option value="">No location</option>
            {facilities.map((f) => {
              const a = availability.get(f.facilityID);
              return (
                <option
                  key={f.facilityID}
                  value={String(f.facilityID)}
                  // Taken rooms stay VISIBLE and disabled rather than being
                  // filtered out: a room that silently disappears when the head
                  // changes the time reads as a bug, where "booked 3:00–4:00 PM"
                  // reads as something to work around.
                  disabled={a !== undefined && !a.available}
                >
                  {optionLabel(f)}
                </option>
              );
            })}
            <option value="other">Other (type it in)</option>
          </select>
          {facilitySelection === "other" && (
            <input
              type="text"
              value={location}
              maxLength={INTERVIEW_LOCATION_MAX}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. the void deck outside Block C"
              className={`${inputCls} mt-1.5`}
            />
          )}
        </Field>
      </div>

      {/* What the list is showing right now: whose availability, for when, and
          whether it is still being worked out. */}
      {facilitySelection !== "other" && (
        <p className="mt-2 text-xs text-gray-500">
          {rangeKey === ""
            ? "Pick a date and time to see which rooms are free then."
            : !availabilityFresh
              ? "Checking which rooms are free…"
              : `${freeCount} of ${availability.size} room${
                  availability.size === 1 ? "" : "s"
                } free ${fmtTime(settledRange!.startTime)}–${fmtTime(
                  settledRange!.endTime,
                )}. Booked ones are greyed out.`}
        </p>
      )}

      {/* The room was free when it was picked and is not any more — the head
          changed the times afterwards. Said here rather than left to the server
          to refuse on submit. */}
      {selectedBusy && (
        <p className="mt-2 text-xs font-medium text-red-600">
          {facilityName} is booked {fmtTime(selectedBusy.startTime)}–
          {fmtTime(selectedBusy.endTime)}
          {selectedBusy.eventName ? ` (${selectedBusy.eventName})` : ""} — pick
          another room or move the window.
        </p>
      )}

      {/* Say what picking a room DOES, before it is done: it takes the room out
          of the hall booking calendar for the whole window. */}
      {facilityID !== null && selectedBusy === null && (
        <p className="mt-2 text-xs text-emerald-700">
          {facilityName} is booked for you the moment you open these slots —
          one booking covering the whole window, under your name. Cancelling
          every slot in it gives the room back.
        </p>
      )}
      {facilitySelection === "other" && (
        <p className="mt-2 text-xs text-gray-500">
          Free text is a label only — no room is held. Pick a room from the list
          if you need the hall booking.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div>
          <p className="mb-1 text-sm font-medium text-gray-700">
            Minutes per interview
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {DURATION_PRESETS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDuration(d)}
                className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                  duration === d
                    ? "bg-emerald-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {d}
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={480}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) || 0)}
              aria-label="Custom minutes per interview"
              className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            Gap between (min)
          </label>
          <input
            type="number"
            min={0}
            max={120}
            value={gap}
            onChange={(e) => setGap(Number(e.target.value) || 0)}
            className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-gray-700">
            People per slot
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {CAPACITY_PRESETS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCapacity(n)}
                className={`rounded-md px-2.5 py-1 text-sm font-medium transition-colors ${
                  capacity === n
                    ? "bg-emerald-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              min={1}
              max={SLOT_CAPACITY_MAX}
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value) || 0)}
              aria-label="Custom people per slot"
              className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
        </div>
      </div>

      {capacity > 1 && (
        <p className="mt-2 text-xs text-amber-700">
          Group interviews — every slot takes {capacity} applicants at once, and
          they&rsquo;ll see it labelled that way before they book.
        </p>
      )}

      {/* An empty preview now EXPLAINS itself. A window that fits nothing used
          to render as no preview at all and a dead "Open slots" button, which is
          how the midnight bug read to the heads who hit it: not "your times are
          impossible" but "the page is broken". */}
      {date !== "" && from !== "" && to !== "" && candidates.length === 0 && (
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {window === null
            ? "Start and end are the same time — set an end after the start."
            : duration <= 0
              ? "Set how many minutes each interview runs."
              : `${fmtTime(window.start)}–${fmtTime(
                  window.end,
                )} isn't long enough for one ${duration}-minute interview. Widen the window or shorten each interview.`}
        </p>
      )}

      {/* Preview */}
      {candidates.length > 0 && (
        <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700">
              {creatable.length} slot{creatable.length === 1 ? "" : "s"} to
              open{" "}
              {capacity > 1 && (
                <span className="font-normal text-gray-500">
                  · {creatable.length * capacity} seats
                </span>
              )}{" "}
              <span className="font-normal text-gray-400">
                ({fmtTime(candidates[0]!.startTime)}–
                {fmtTime(candidates[candidates.length - 1]!.endTime)})
              </span>
            </p>
            {overCap && (
              <span className="text-xs font-medium text-amber-700">
                Over the {MAX_SLOTS_PER_OPEN}-slot limit
              </span>
            )}
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {candidates.map((c) => {
              const excluded = c.conflict || c.past || removed.has(c.index);
              return (
                <li key={c.index}>
                  <button
                    type="button"
                    disabled={c.conflict || c.past}
                    onClick={() =>
                      setRemoved((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.index)) next.delete(c.index);
                        else next.add(c.index);
                        return next;
                      })
                    }
                    title={
                      c.conflict
                        ? "Overlaps a slot you've already opened"
                        : c.past
                          ? "In the past"
                          : removed.has(c.index)
                            ? "Click to include"
                            : "Click to exclude"
                    }
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                      c.conflict || c.past
                        ? "cursor-not-allowed bg-gray-100 text-gray-400 line-through"
                        : excluded
                          ? "bg-white text-gray-400 ring-1 ring-inset ring-gray-200 line-through"
                          : "bg-emerald-600 text-white hover:bg-emerald-700"
                    }`}
                  >
                    {fmtTime(c.startTime)}
                    {capacity > 1 && <span>×{capacity}</span>}
                    {!excluded && <Check className="h-3 w-3" />}
                  </button>
                </li>
              );
            })}
          </ul>
          {window?.nextDay && (
            <p className="mt-2 text-xs text-amber-700">
              This window runs past midnight — it ends at {fmtTime(window.end)}{" "}
              on {fmtDayTab(window.end)}.
            </p>
          )}
          {facilityID !== null && creatable.length > 0 && (
            <p className="mt-2 text-xs text-emerald-700">
              {facilityName} will be booked{" "}
              {fmtTime(Math.min(...creatable.map((c) => c.startTime)))}–
              {fmtTime(Math.max(...creatable.map((c) => c.endTime)))}.
            </p>
          )}
          {candidates.some((c) => c.conflict) && (
            <p className="mt-2 text-xs text-gray-500">
              Struck-through times overlap slots you&rsquo;ve already opened and
              are skipped.
            </p>
          )}
        </div>
      )}

      {(formError ?? serverError) && (
        <p className="mt-3 text-sm text-red-600">{formError ?? serverError}</p>
      )}

      <div className="mt-4">
        <Button
          onClick={submit}
          disabled={creatable.length === 0 || overCap || create.isPending}
          className="inline-flex items-center gap-1.5"
        >
          <Plus className="h-4 w-4" />
          {create.isPending
            ? "Opening…"
            : creatable.length > 0
              ? `Open ${creatable.length} slot${creatable.length === 1 ? "" : "s"}`
              : "Open slots"}
        </Button>
      </div>
    </section>
  );
}

/* ----------------------------- schedule view ------------------------------- */

/** Compact day-tab label, e.g. "Mon 21 Jul". */
function fmtDayTab(epoch: number): string {
  return new Date(epoch * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * A day view: pick a day, see that day's slots laid out as cards. Fill state is
 * THREE-WAY since group slots: white empty, amber part-full, solid green full.
 * A half-empty group session has to be visible at a glance — it is the one that
 * still needs bookings, and a two-state card would show it as "booked" and hide
 * exactly that.
 *
 * Counts here are SEATS, not slots: with capacity > 1 the number of slots on a
 * day stops being the number of people who can be seen that day.
 */
function ScheduleView({ ccaID, slots }: { ccaID: number; slots: Slot[] }) {
  const days = useMemo(() => {
    const byDay = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = s.startTime !== null ? toDateInput(s.startTime) : "—";
      const arr = byDay.get(key) ?? [];
      arr.push(s);
      byDay.set(key, arr);
    }
    for (const arr of byDay.values()) {
      arr.sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [slots]);

  const [selected, setSelected] = useState<string | null>(null);

  if (slots.length === 0) {
    return (
      <p className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
        No slots yet. Generate some above.
      </p>
    );
  }

  const todayKey = toDateInput(Math.floor(Date.now() / 1000));
  const defaultDay =
    days.find(([k]) => k >= todayKey)?.[0] ?? days[0]?.[0] ?? null;
  const current = days.find(([k]) => k === (selected ?? defaultDay)) ?? days[0]!;
  const daySlots = current[1];
  const seats = daySlots.reduce((n, s) => n + s.capacity, 0);
  const booked = daySlots.reduce((n, s) => n + s.occupancy, 0);

  return (
    <div className="space-y-3">
      {/* Day picker */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {days.map(([key, ds]) => {
          const active = key === current[0];
          const dSeats = ds.reduce((n, s) => n + s.capacity, 0);
          const b = ds.reduce((n, s) => n + s.occupancy, 0);
          return (
            <button
              key={key}
              onClick={() => setSelected(key)}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors ${
                active
                  ? "border-emerald-600 bg-emerald-50 text-emerald-800"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
              }`}
            >
              <span className="block font-semibold">
                {ds[0]?.startTime != null
                  ? fmtDayTab(ds[0].startTime)
                  : "Undated"}
              </span>
              <span className={active ? "text-emerald-600" : "text-gray-400"}>
                {ds.length} slot{ds.length === 1 ? "" : "s"}
                {dSeats !== ds.length ? ` · ${dSeats} seats` : ""}
                {b > 0 ? ` · ${b} booked` : ""}
              </span>
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-gray-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-emerald-600" /> Full
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border border-amber-300 bg-amber-100" />{" "}
          Partly booked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border border-gray-300 bg-white" />{" "}
          Empty
        </span>
        <span className="ml-auto tabular-nums">
          {seats - booked} seat{seats - booked === 1 ? "" : "s"} free ·{" "}
          {booked} booked
        </span>
      </div>

      {/* Slots for the selected day */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {daySlots.map((s) => (
          <SlotCard key={s.slotID} ccaID={ccaID} slot={s} />
        ))}
      </div>
    </div>
  );
}

function SlotCard({ ccaID, slot }: { ccaID: number; slot: Slot }) {
  const utils = api.useUtils();
  const [editing, setEditing] = useState(false);
  const occupied = slot.occupancy > 0;
  const full = seatsLeft(slot) === 0;
  const group = slot.capacity > 1;

  const refresh = () => utils.ccaApplicationsHead.listSlots.invalidate({ ccaID });
  const cancel = api.ccaApplicationsHead.cancelSlot.useMutation({
    onSuccess: refresh,
  });

  if (editing) {
    return (
      <div className="rounded-lg border border-emerald-300 bg-white p-3 sm:col-span-2 lg:col-span-3">
        <SlotEditForm
          ccaID={ccaID}
          slot={slot}
          onDone={async () => {
            setEditing(false);
            await refresh();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  // Three-way fill. `full` (not `occupied`) drives the solid treatment so a
  // group slot only reads as "done" once there is nothing left to sell.
  const tone = full
    ? "border-emerald-600 bg-emerald-600 text-white"
    : occupied
      ? "border-amber-300 bg-amber-50"
      : "border-gray-200 bg-white";
  const muted = full
    ? "text-emerald-50"
    : occupied
      ? "text-amber-800"
      : "text-gray-500";

  return (
    <div className={`relative rounded-lg border p-3 ${tone}`}>
      <p
        className={`text-sm font-semibold tabular-nums ${
          full ? "text-white" : "text-gray-800"
        }`}
      >
        {fmtTime(slot.startTime)} – {fmtTime(slot.endTime)}
      </p>
      {slot.location && (
        <p className={`mt-0.5 inline-flex items-center gap-1 text-xs ${muted}`}>
          <MapPin className="h-3 w-3" />
          {slot.location}
          {/* A held room reads differently from a typed-in label: one of them
              means nobody else can have the room. */}
          {slot.facilityID != null && (
            <span
              title={
                slot.booking
                  ? `Room booked ${fmtTime(slot.booking.startTime)}–${fmtTime(
                      slot.booking.endTime,
                    )}`
                  : "Room booking was removed — the room is no longer held"
              }
              className={slot.booking ? "" : "text-red-600"}
            >
              {slot.booking ? "· booked" : "· not held"}
            </span>
          )}
        </p>
      )}
      <p className={`mt-1 text-xs font-medium tabular-nums ${muted}`}>
        {group ? (
          <>
            <Users className="mr-1 inline h-3 w-3 align-[-2px]" />
            {slot.occupancy}/{slot.capacity} booked
          </>
        ) : occupied ? (
          "Booked"
        ) : (
          "Free"
        )}
      </p>
      {occupied && (
        <p className={`mt-0.5 truncate text-xs ${muted}`}>
          {occupantSummary(slot)}
        </p>
      )}

      {/* Actions — always visible so they work on touch too. */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
        {/* Edit stays available on an occupied slot: the capacity is editable
            there (raising it re-opens the slot), and the server refuses any
            time/location change while anyone is booked. */}
        <button
          onClick={() => setEditing(true)}
          aria-label="Edit slot"
          className={`rounded p-1 ${
            full
              ? "text-emerald-100 hover:bg-emerald-700 hover:text-white"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          }`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => {
            if (
              occupied &&
              !window.confirm(
                `This slot has ${slot.occupancy} applicant${
                  slot.occupancy === 1 ? "" : "s"
                } booked. Cancelling sends ${
                  slot.occupancy === 1 ? "them" : "all of them"
                } back to reschedule. Continue?`,
              )
            ) {
              return;
            }
            cancel.mutate({ ccaID, slotID: slot.slotID });
          }}
          disabled={cancel.isPending}
          aria-label="Cancel slot"
          className={`rounded p-1 disabled:opacity-50 ${
            full
              ? "text-emerald-100 hover:bg-emerald-700 hover:text-white"
              : "text-gray-400 hover:bg-red-50 hover:text-red-600"
          }`}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function SlotEditForm({
  ccaID,
  slot,
  onDone,
  onCancel,
}: {
  ccaID: number;
  slot: Slot;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(
    slot.startTime !== null ? toDateInput(slot.startTime) : "",
  );
  const [from, setFrom] = useState(
    slot.startTime !== null ? toTimeInput(slot.startTime) : "",
  );
  const [to, setTo] = useState(
    slot.endTime !== null ? toTimeInput(slot.endTime) : "",
  );
  const [location, setLocation] = useState(slot.location ?? "");
  const [capacity, setCapacity] = useState(slot.capacity);
  const [err, setErr] = useState<string | null>(null);
  const locked = slot.occupancy > 0;

  const update = api.ccaApplicationsHead.updateSlot.useMutation({
    onSuccess: onDone,
  });

  const save = () => {
    // Same midnight rollover as the generator: an interview that ends at 00:00
    // ends at midnight TONIGHT, not this morning.
    const win = toWindow(date, from, to);
    if (win === null) {
      setErr("Pick a date, start and end.");
      return;
    }
    const { start: startTime, end: endTime } = win;
    // Refuse locally what the server refuses, so the head is told BEFORE the
    // round trip that they would be evicting someone.
    if (capacity < slot.occupancy) {
      setErr(
        `${slot.occupancy} applicant${
          slot.occupancy === 1 ? " has" : "s have"
        } already booked this slot — capacity can't go below ${slot.occupancy}.`,
      );
      return;
    }
    const parsed = editSlotInput.safeParse({
      ccaID,
      slotID: slot.slotID,
      startTime,
      endTime,
      location: location.trim() || undefined,
      capacity,
    });
    if (!parsed.success) {
      setErr(
        parsed.error.issues[0]?.message === "END_BEFORE_START"
          ? "End has to be after start."
          : `That isn't valid — people per slot must be 1–${SLOT_CAPACITY_MAX}.`,
      );
      return;
    }
    setErr(null);
    update.mutate(parsed.data);
  };

  const upMsg = update.error?.message ?? "";
  const outside = /^OUTSIDE_BOOKING:(\d+):(\d+)$/.exec(upMsg);
  const serverErr = update.error
    ? outside
      ? `${slot.location ?? "That room"} is only held ${fmtTime(
          Number(outside[1]),
        )}–${fmtTime(
          Number(outside[2]),
        )}. Keep this slot inside that, or cancel it and open a new window.`
      : upMsg === "FACILITY_LOCATION_LOCKED"
        ? "This slot's location is the room booked for it — cancel it and open a new one to move rooms."
        : upMsg === "SLOT_OVERLAP"
          ? "That overlaps another slot."
          : upMsg === "SLOT_IN_PAST"
            ? "That's in the past."
            : upMsg === "SLOT_BOOKED"
              ? "Someone's booked on this slot — you can change how many people it takes, but not when or where. Cancel it instead."
              : upMsg === "CAPACITY_BELOW_OCCUPANCY"
                ? "Someone booked while you were editing — capacity can't go below the number already on this slot."
                : "That didn't save."
    : null;

  return (
    <div className="space-y-2">
      {/* Time and location are DISABLED once anyone is booked — the server
          refuses to move an occupied slot, so offering the field would only
          produce a rejection. Capacity stays live: raising it is the whole
          reason to open this form on an occupied slot. */}
      <div className="grid gap-2 sm:grid-cols-5">
        <input type="date" value={date} disabled={locked} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        <input type="time" value={from} disabled={locked} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        <input type="time" value={to} disabled={locked} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        {/* A booked room is not editable text: `location` IS the facility's
            name, and the server refuses to change it (FACILITY_LOCATION_LOCKED)
            because moving rooms means releasing one booking and taking another.
            Shown, disabled, rather than hidden — the head still needs to see
            where the interview is. */}
        <input
          type="text"
          value={location}
          disabled={locked || slot.facilityID != null}
          maxLength={INTERVIEW_LOCATION_MAX}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location"
          title={
            slot.facilityID != null
              ? "Booked room — cancel the slot to move rooms"
              : undefined
          }
          className={inputCls}
        />
        <label className="text-sm">
          <span className="sr-only">People per slot</span>
          <input
            type="number"
            min={Math.max(1, slot.occupancy)}
            max={SLOT_CAPACITY_MAX}
            value={capacity}
            onChange={(e) => setCapacity(Number(e.target.value) || 0)}
            aria-label="People per slot"
            title="People per slot"
            className={inputCls}
          />
        </label>
      </div>
      <p className="text-xs text-gray-500">
        People per slot: {capacity}
        {slot.occupancy > 0
          ? ` · ${slot.occupancy} already booked (time and location are locked while anyone is booked)`
          : ""}
      </p>
      {slot.facilityID != null && slot.booking && (
        <p className="text-xs text-emerald-700">
          {slot.location} is held {fmtTime(slot.booking.startTime)}–
          {fmtTime(slot.booking.endTime)} — this slot can move anywhere inside
          that.
        </p>
      )}
      {(err ?? serverErr) && <p className="text-sm text-red-600">{err ?? serverErr}</p>}
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={update.isPending} className="inline-flex items-center gap-1.5">
          <Check className="h-4 w-4" />
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <button
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-gray-500 hover:text-gray-800"
        >
          <X className="h-4 w-4" /> Cancel
        </button>
      </div>
    </div>
  );
}

/* -------------------------------- bits ------------------------------------- */

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}
