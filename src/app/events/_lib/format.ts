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

export const STATUS_META: Record<
  EventStatus,
  { label: string; className: string }
> = {
  draft: { label: "Draft", className: "bg-gray-100 text-gray-700" },
  submitted: { label: "In review", className: "bg-amber-100 text-amber-800" },
  approved: { label: "Approved", className: "bg-sky-100 text-sky-800" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-700" },
  published: { label: "Published", className: "bg-emerald-100 text-emerald-800" },
  canceled: { label: "Canceled", className: "bg-gray-200 text-gray-500" },
};

/* -------------------------------------------------------------------------- */
/* CSV                                                                         */
/* -------------------------------------------------------------------------- */

/** Escape one field per RFC 4180: quote when it contains "," | '"' | newline. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
