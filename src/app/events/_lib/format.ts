import type { EventStatus } from "~/lib/schemas/event";

/**
 * Client-safe display helpers for the Events feature — pure functions, no server
 * imports, so both the resident pages and the head/admin components can share
 * them. Times are UNIX epoch SECONDS (the stored convention).
 *
 * ALWAYS SINGAPORE TIME. The hall is in SGT, but a phone abroad or a laptop set
 * to another zone used to show, and worse, SAVE, its own wall time. Every
 * helper here pins Asia/Singapore. SGT is a fixed UTC+8 with no daylight
 * saving, so the input conversions use the offset directly.
 */

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

export const HALL_TIME_ZONE = "Asia/Singapore";
const SGT_OFFSET_SEC = 8 * 60 * 60;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The SGT wall clock for an epoch, read through the UTC getters. */
function sgtWall(sec: number): Date {
  return new Date((sec + SGT_OFFSET_SEC) * 1000);
}

/** epoch seconds → the value an <input type="datetime-local"> expects (SGT). */
export function epochToLocalInput(sec: number | null | undefined): string {
  if (sec == null) return "";
  const d = sgtWall(sec);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** <input type="datetime-local"> value (SGT wall time) → epoch seconds. */
export function localInputToEpoch(value: string): number | null {
  const m = LOCAL_INPUT.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as number[];
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000) - SGT_OFFSET_SEC;
}

const DATE_FMT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: HALL_TIME_ZONE,
};

export function formatDateTime(sec: number | null | undefined): string {
  if (sec == null) return "Date TBC";
  return new Date(sec * 1000).toLocaleString("en-SG", DATE_FMT);
}

/** A start–end range, collapsing the date when both fall on the same day. */
export function formatDateRange(
  start: number | null | undefined,
  end: number | null | undefined,
): string {
  if (start == null) return "Date TBC";
  const startStr = formatDateTime(start);
  if (end == null) return startStr;
  const sameDay = dayKey(start) === dayKey(end);
  const endStr = sameDay
    ? new Date(end * 1000).toLocaleTimeString("en-SG", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: HALL_TIME_ZONE,
      })
    : formatDateTime(end);
  return `${startStr} – ${endStr}`;
}

/** SGT YYYY-MM-DD key, for grouping the timeline by day. */
export function dayKey(sec: number): string {
  const d = sgtWall(sec);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(
    d.getUTCDate(),
  )}`;
}

/** A heading like "Thu, 6 Aug" for a timeline day group. */
export function formatDayHeading(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: HALL_TIME_ZONE,
  });
}

/**
 * Is the event still on? An event stays under Upcoming until it ENDS, so one
 * that has started is still findable (and its door still reachable). With no
 * end time, the start is the cut-off; with no date at all, it is still to come.
 */
export function isStillOn(
  e: { startTime: number | null; endTime: number | null },
  now: number,
): boolean {
  if (e.startTime == null) return true;
  return (e.endTime ?? e.startTime) >= now;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/* -------------------------------------------------------------------------- */
/* Status display                                                              */
/* -------------------------------------------------------------------------- */

// Two deliberate spelling quirks — do not "fix" either:
//   - the KEY is "canceled" (one l), matching the stored DB convention; the
//     LABEL is "Cancelled" (two), matching the rest of the UI's British
//     spelling ("Cancelling…", "This event was cancelled.").
//   - draft's label is "Not submitted", not "Draft" — a head is never parked
//     in draft, and the word "Draft" must not appear on any head-facing surface.
export const STATUS_META: Record<
  EventStatus,
  { label: string; className: string }
> = {
  draft:              { label: "Not submitted",   className: "bg-gray-100 text-gray-700" },
  submitted:          { label: "In review",       className: "bg-amber-100 text-amber-800" },
  changes_requested:  { label: "Changes needed",  className: "bg-orange-100 text-orange-800" },
  published:          { label: "Published",       className: "bg-emerald-100 text-emerald-800" },
  declined:           { label: "Declined",        className: "bg-red-100 text-red-700" },
  canceled:           { label: "Cancelled",       className: "bg-gray-200 text-gray-500" },
};

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Escape one field per RFC 4180: quote when it contains "," | '"' | newline —
 * AND neutralise a leading formula character first.
 *
 * WHY THIS MATTERS NOW AND DID NOT BEFORE. Every cell this CSV has ever carried
 * came from a controlled vocabulary or from a profile field. Custom signup
 * questions put two ATTACKER-AUTHORED strings into it: a QUESTION LABEL, which
 * becomes a COLUMN HEADER, and a FREE-TEXT ANSWER. A head who types
 * `=HYPERLINK("https://evil","Click")` as a question label hands a live formula
 * to every committee member who opens the download in Excel.
 *
 * ORDERING IS THE TRAP. NEUTRALISE, THEN QUOTE. Reversing the two yields
 * `'"=a,b"` — the apostrophe OUTSIDE the quoted field — which is both invalid
 * CSV and still a formula. The test is: csvField('=a,b') === `"'=a,b"`, with the
 * apostrophe INSIDE the quotes.
 *
 * A NEGATIVE NUMBER IS NOT A FORMULA, and `-5` gets an apostrophe under this
 * rule and imports as text. Accepted deliberately: the alternative is a
 * number-shaped exclusion that `-5+cmd` slips straight through. The only
 * numeric cells here are `number` answers, which nothing downstream sums.
 *
 * FIXED HERE AND NOT IN THE CALLER. `EventAttendees.tsx` neutralising its own
 * cells would be a drift pair — two places that must agree and nothing making
 * them. Blast radius of this function: one exported wrapper (serializeCsv) and
 * ONE caller. THE CCA ROSTER EXPORT IS NOT AFFECTED AND NEEDS NO FIX: it is a
 * different serialiser on a different format (RosterPanel -> downloadXlsx ->
 * buildXlsx), and `sheetXml` emits every cell as `t="inlineStr"`, an inline
 * string rather than a formula cell, which Excel never evaluates. Do not
 * "fix" xlsx.ts by prefixing apostrophes into cells that would then display
 * them.
 */
function csvField(value: string): string {
  // A leading =, +, - or @ makes Excel and Sheets treat the cell as a FORMULA.
  // Prefix an apostrophe, which those apps consume as "this is text".
  // MUST run BEFORE the quoting test below.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Serialize a table (header + rows) to an RFC-4180 CSV string with CRLF. */
export function serializeCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((row) => row.map((c) => csvField(c == null ? "" : String(c))).join(","))
    .join("\r\n");
}

/** Trigger a client-side download of `content` as `filename`. */
export function downloadTextFile(
  filename: string,
  content: string,
  mime = "text/csv;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
