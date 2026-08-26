import type { EventStatus } from "~/lib/schemas/event";

/**
 * Client-safe display helpers for the Events feature — pure functions, no server
 * imports, so both the resident pages and the head/admin components can share
 * them. Times are UNIX epoch SECONDS (the stored convention); the hall is in
 * SGT, so the browser's local time is used directly rather than a fixed zone.
 */

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** epoch seconds → the value an <input type="datetime-local"> expects (local). */
export function epochToLocalInput(sec: number | null | undefined): string {
  if (sec == null) return "";
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local wall time) → epoch seconds. */
export function localInputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

const DATE_FMT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
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
  const sameDay =
    new Date(start * 1000).toDateString() ===
    new Date(end * 1000).toDateString();
  const endStr = sameDay
    ? new Date(end * 1000).toLocaleTimeString("en-SG", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      })
    : formatDateTime(end);
  return `${startStr} – ${endStr}`;
}

/** Local YYYY-MM-DD key, for grouping the timeline by day. */
export function dayKey(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A heading like "Thu, 6 Aug" for a timeline day group. */
export function formatDayHeading(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("en-SG", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
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
