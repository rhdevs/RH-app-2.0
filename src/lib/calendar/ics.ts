/**
 * A small iCalendar (RFC 5545) writer for the personal calendar feed. No
 * dependency: the feed needs VEVENT with a start, an optional end, text and a
 * stable UID, and nothing else.
 *
 * What it gets right, and why each matters:
 *  - CRLF line ends, and a CRLF after the last line.
 *  - Text values escape backslash, semicolon, comma and newline; a bare CR
 *    never survives, and other control characters are dropped, so a title can
 *    not start a new property.
 *  - Lines fold at 75 OCTETS, not characters, and never inside a multibyte
 *    character. A continuation line starts with one space, which counts
 *    toward its own 75.
 *  - Times are written in UTC (`...Z`); the calendar app shows them in the
 *    viewer's zone. `X-WR-TIMEZONE` names Singapore as the calendar's zone.
 *  - A UID is derived from the thing's id, so the same Event is the same
 *    entry on every fetch.
 */

export const ICS_MAX_OCTETS = 75;
export const ICS_UID_DOMAIN = "calendar.rhapp";

const encoder = new TextEncoder();

/** Escape a TEXT value. Control characters other than newline are dropped. */
export function escapeIcsText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n")
  );
}

/**
 * Fold one content line at 75 octets. Returns the physical lines (no line
 * ends). Splits only between code points, so a character of two to four bytes
 * is never cut.
 */
export function foldIcsLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let used = 0;
  // A continuation starts with one space, which counts toward its own 75.
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (used + size > ICS_MAX_OCTETS) {
      out.push(current);
      current = " ";
      used = 1;
    }
    current += ch;
    used += size;
  }
  out.push(current);
  return out;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Epoch seconds to the UTC form `YYYYMMDDTHHMMSSZ`. */
export function icsUtc(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}T${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** A stable UID: the kind and id of the thing, never a random value. */
export function icsUid(kind: "event" | "proposal", id: string | number) {
  return `${kind}-${String(id).replace(/[^A-Za-z0-9_-]/g, "")}@${ICS_UID_DOMAIN}`;
}

export type IcsEntry = {
  uid: string;
  /** Epoch seconds. */
  start: number;
  /** Epoch seconds; left out unless it is after the start. */
  end?: number | null;
  /** When the thing last changed, epoch seconds. */
  stamp: number;
  summary: string;
  description?: string | null;
  location?: string | null;
  status: "CONFIRMED" | "TENTATIVE";
  categories?: string | null;
};

export type IcsCalendar = {
  name: string;
  entries: IcsEntry[];
};

function entryLines(e: IcsEntry): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsUtc(e.stamp)}`,
    `DTSTART:${icsUtc(e.start)}`,
  ];
  if (e.end != null && e.end > e.start) lines.push(`DTEND:${icsUtc(e.end)}`);
  lines.push(`SUMMARY:${escapeIcsText(e.summary)}`);
  if (e.description) lines.push(`DESCRIPTION:${escapeIcsText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
  lines.push(`STATUS:${e.status}`);
  if (e.categories) lines.push(`CATEGORIES:${escapeIcsText(e.categories)}`);
  lines.push("END:VEVENT");
  return lines;
}

/** The whole calendar as one string, CRLF between lines and after the last. */
export function writeIcs(cal: IcsCalendar): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RHApp//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(cal.name)}`,
    "X-WR-TIMEZONE:Asia/Singapore",
    ...cal.entries.flatMap(entryLines),
    "END:VCALENDAR",
  ];
  return lines.flatMap(foldIcsLine).join("\r\n") + "\r\n";
}
