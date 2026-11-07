import { sgtDayKey } from "~/lib/time/sgt";

/**
 * Month and day arithmetic for the calendar page, always in Singapore time
 * (a fixed UTC+8, no daylight saving). A day here is a Singapore day, so an
 * event at 07:30 SGT sits on its own day whatever the viewer's zone.
 */

const SGT_OFFSET_SEC = 8 * 60 * 60;
const DAY_SEC = 86_400;

export const CALENDAR_MIN_YEAR = 2000;
export const CALENDAR_MAX_YEAR = 2100;

/** Epoch seconds of 00:00 Singapore time on this date (month is 1 to 12). */
export function sgtMidnight(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000) - SGT_OFFSET_SEC;
}

/** "YYYY-MM-DD" of the Singapore day containing an epoch-seconds time. */
export function dayKeyOfEpoch(epochSec: number): string {
  return sgtDayKey(new Date(epochSec * 1000));
}

/** Today in Singapore, by the one shared helper (A8). */
export function todayKey(now: Date = new Date()): string {
  return sgtDayKey(now);
}

export type MonthGrid = {
  year: number;
  month: number;
  /** Epoch seconds, inclusive start of the first shown Monday. */
  from: number;
  /** Epoch seconds, exclusive end of the last shown Sunday. */
  to: number;
  /** Singapore day keys, a whole number of weeks, Monday first. */
  days: string[];
};

/**
 * The weeks that cover a month, Monday first, so days from the neighbouring
 * months show their entries too.
 */
export function monthGrid(year: number, month: number): MonthGrid {
  const first = sgtMidnight(year, month, 1);
  const firstWeekday = new Date((first + SGT_OFFSET_SEC) * 1000).getUTCDay();
  const lead = (firstWeekday + 6) % 7;
  const nextFirst =
    month === 12
      ? sgtMidnight(year + 1, 1, 1)
      : sgtMidnight(year, month + 1, 1);
  const monthDays = Math.round((nextFirst - first) / DAY_SEC);
  const weeks = Math.ceil((lead + monthDays) / 7);
  const from = first - lead * DAY_SEC;
  const to = from + weeks * 7 * DAY_SEC;
  const days: string[] = [];
  for (let at = from; at < to; at += DAY_SEC) days.push(dayKeyOfEpoch(at));
  return { year, month, from, to, days };
}

/** The month before or after, rolling the year. */
export function shiftMonth(
  year: number,
  month: number,
  by: 1 | -1,
): { year: number; month: number } {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const CLOCK_FORMAT = new Intl.DateTimeFormat("en-SG", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: "Asia/Singapore",
});

/** "7:30 pm" in Singapore time, whatever zone the viewer's device is in. */
export function formatSgtClock(epochSec: number): string {
  return CLOCK_FORMAT.format(new Date(epochSec * 1000));
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-SG", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "November 2026". Formatted from a UTC date so the viewer's zone is moot. */
export function monthTitle(year: number, month: number): string {
  return MONTH_FORMAT.format(new Date(Date.UTC(year, month - 1, 15)));
}

/** The year and month of a "YYYY-MM-DD" day key. */
export function monthOfDayKey(key: string): { year: number; month: number } {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) };
}
