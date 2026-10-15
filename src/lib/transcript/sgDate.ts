import { isRealIsoDate } from "./academicYear";

/**
 * Calendar dates in Singapore (UTC+8, no daylight saving).
 *
 * A semester date is typed as a calendar date ("2027-01-11") and means the
 * START of that day in Singapore. It is stored as that instant, which is 16:00
 * UTC the evening BEFORE, and shown back as the same calendar date. Reading the
 * stored instant with UTC methods would show 2027-01-10, which is the bug this
 * module exists to prevent. PURE.
 */

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** "2027-01-11" -> 2027-01-10T16:00:00Z, i.e. midnight Singapore. Null if not a real date. */
export function sgDateToInstant(isoDate: string): Date | null {
  if (!isRealIsoDate(isoDate)) return null;
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) - SGT_OFFSET_MS);
}

/** An instant -> the Singapore calendar date it falls on, "2027-01-11". */
export function instantToSgDate(instant: Date): string {
  return new Date(instant.getTime() + SGT_OFFSET_MS).toISOString().slice(0, 10);
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * An instant as the Singapore calendar date it falls on, "15 Oct 2026". Never
 * the viewer's time zone: 2027-01-10T16:00Z is 11 January here, wherever the
 * browser is.
 */
export function formatSgDate(instant: Date | string): string {
  const [y, m, d] = instantToSgDate(new Date(instant)).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * A calendar date stored as UTC midnight (a one-off activity's date) -> its
 * ISO date. These are NOT shifted: they were stored as the date itself.
 */
export function storedCalendarDate(stored: Date): string {
  return stored.toISOString().slice(0, 10);
}
