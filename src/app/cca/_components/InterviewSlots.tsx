"use client";

import { useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  MapPin,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  editSlotInput,
  INTERVIEW_LOCATION_MAX,
  MAX_SLOTS_PER_OPEN,
  slotDraftSchema,
} from "~/lib/schemas/ccaApplication";

type Slot = RouterOutputs["ccaApplicationsHead"]["listSlots"]["slots"][number];

const DURATION_PRESETS = [10, 15, 20, 30, 45, 60];

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

  return (
    <div className="space-y-6">
      <SlotGenerator
        ccaID={ccaID}
        existing={existing}
        onCreated={() => utils.ccaApplicationsHead.listSlots.invalidate({ ccaID })}
      />

      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-900">Schedule</h2>
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
  const [location, setLocation] = useState("");
  const [removed, setRemoved] = useState<Set<number>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);

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
  const candidates = useMemo(() => {
    const startEpoch = toEpoch(date, from);
    const endEpoch = toEpoch(date, to);
    if (startEpoch === null || endEpoch === null || duration <= 0) return [];
    if (endEpoch <= startEpoch) return [];
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
  }, [date, from, to, duration, gap, existing]);

  const creatable = candidates.filter(
    (c) => !c.conflict && !c.past && !removed.has(c.index),
  );
  const overCap = creatable.length > MAX_SLOTS_PER_OPEN;

  const serverError = create.error
    ? create.error.message === "DUPLICATE_SLOT"
      ? "One of these is identical to a slot you've already opened."
      : create.error.message === "SLOT_OVERLAP"
        ? "One of these overlaps a slot that was just taken. Refresh and regenerate."
        : create.error.message === "SLOT_IN_PAST"
          ? "Some of these are in the past."
          : create.error.message === "NOT_A_HEAD_OF_THIS_CCA"
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
    // Validate each against the shared schema before sending.
    const slots = creatable.map((c) => ({
      startTime: c.startTime,
      endTime: c.endTime,
      location: location.trim() || undefined,
    }));
    for (const s of slots) {
      if (!slotDraftSchema.safeParse(s).success) {
        setFormError("One of the generated slots isn't valid.");
        return;
      }
    }
    setFormError(null);
    create.mutate({ ccaID, slots });
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
          <input
            type="text"
            value={location}
            maxLength={INTERVIEW_LOCATION_MAX}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g. JCRC Room (optional)"
            className={inputCls}
          />
        </Field>
      </div>

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
      </div>

      {/* Preview */}
      {candidates.length > 0 && (
        <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium text-gray-700">
              {creatable.length} slot{creatable.length === 1 ? "" : "s"} to
              open{" "}
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
                    {!excluded && <Check className="h-3 w-3" />}
                  </button>
                </li>
              );
            })}
          </ul>
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
 * A day view: pick a day, see that day's slots laid out as cards. Booked slots
 * are solid green and name who took them; free slots are plain white. This reads
 * far more like a schedule than one long flat list.
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
  const booked = daySlots.filter((s) => s.bookedByUserID !== null).length;

  return (
    <div className="space-y-3">
      {/* Day picker */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {days.map(([key, ds]) => {
          const active = key === current[0];
          const b = ds.filter((s) => s.bookedByUserID !== null).length;
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
                {b > 0 ? ` · ${b} booked` : ""}
              </span>
            </button>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-emerald-600" /> Booked
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded border border-gray-300 bg-white" />{" "}
          Free
        </span>
        <span className="ml-auto tabular-nums">
          {daySlots.length - booked} free · {booked} booked
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
  const booked = slot.bookedByUserID !== null;

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

  return (
    <div
      className={`relative rounded-lg border p-3 ${
        booked
          ? "border-emerald-600 bg-emerald-600 text-white"
          : "border-gray-200 bg-white"
      }`}
    >
      <p
        className={`text-sm font-semibold tabular-nums ${
          booked ? "text-white" : "text-gray-800"
        }`}
      >
        {fmtTime(slot.startTime)} – {fmtTime(slot.endTime)}
      </p>
      {slot.location && (
        <p
          className={`mt-0.5 inline-flex items-center gap-1 text-xs ${
            booked ? "text-emerald-50" : "text-gray-500"
          }`}
        >
          <MapPin className="h-3 w-3" />
          {slot.location}
        </p>
      )}
      <p
        className={`mt-1 truncate text-xs ${
          booked ? "text-emerald-50" : "text-gray-400"
        }`}
      >
        {booked
          ? (slot.bookedBy?.displayName ?? slot.bookedBy?.email ?? "Booked")
          : "Free"}
      </p>

      {/* Actions — always visible so they work on touch too. */}
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5">
        {!booked && (
          <button
            onClick={() => setEditing(true)}
            aria-label="Edit slot"
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          onClick={() => {
            if (
              booked &&
              !window.confirm(
                "This slot is booked. Cancelling sends that applicant back to reschedule. Continue?",
              )
            ) {
              return;
            }
            cancel.mutate({ ccaID, slotID: slot.slotID });
          }}
          disabled={cancel.isPending}
          aria-label="Cancel slot"
          className={`rounded p-1 disabled:opacity-50 ${
            booked
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
  const [err, setErr] = useState<string | null>(null);

  const update = api.ccaApplicationsHead.updateSlot.useMutation({
    onSuccess: onDone,
  });

  const save = () => {
    const startTime = toEpoch(date, from);
    const endTime = toEpoch(date, to);
    if (startTime === null || endTime === null) {
      setErr("Pick a date, start and end.");
      return;
    }
    const parsed = editSlotInput.safeParse({
      ccaID,
      slotID: slot.slotID,
      startTime,
      endTime,
      location: location.trim() || undefined,
    });
    if (!parsed.success) {
      setErr(
        parsed.error.issues[0]?.message === "END_BEFORE_START"
          ? "End has to be after start."
          : "That isn't valid.",
      );
      return;
    }
    setErr(null);
    update.mutate(parsed.data);
  };

  const serverErr = update.error
    ? update.error.message === "SLOT_OVERLAP"
      ? "That overlaps another slot."
      : update.error.message === "SLOT_IN_PAST"
        ? "That's in the past."
        : update.error.message === "SLOT_BOOKED"
          ? "This slot was just booked — cancel it instead."
          : "That didn't save."
    : null;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-4">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
        <input type="time" value={from} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
        <input type="time" value={to} onChange={(e) => setTo(e.target.value)} className={inputCls} />
        <input
          type="text"
          value={location}
          maxLength={INTERVIEW_LOCATION_MAX}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Location"
          className={inputCls}
        />
      </div>
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
