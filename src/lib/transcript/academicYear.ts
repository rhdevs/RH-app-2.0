/**
 * Academic years, as strings of the form "AY2026/27".
 *
 * An academic year runs 1 August to 31 July (AY2026/27 starts 2026-08-01), and
 * the hall is in Singapore, so "now" is read in UTC+8. PURE: nothing here
 * touches a clock except through the `date` argument.
 */

export interface ParsedAcademicYear {
  /** 2026 for "AY2026/27". */
  startYear: number;
  /** First instant of the year: 1 August, 00:00 Singapore time. */
  start: Date;
  /** First instant AFTER the year: 1 August of the next year, 00:00 Singapore. */
  endExclusive: Date;
}

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const AY_PATTERN = /^AY(\d{4})\/(\d{2})$/;

/** Midnight, 1 August of `year`, Singapore time, as a UTC instant. */
function augustFirst(year: number): Date {
  return new Date(Date.UTC(year, 7, 1) - SGT_OFFSET_MS);
}

/** "AY2026/27" -> its bounds. Null for anything else, including "AY2026/28". */
export function parseAcademicYear(value: string): ParsedAcademicYear | null {
  const m = AY_PATTERN.exec(value);
  if (!m) return null;
  const startYear = Number(m[1]);
  if (Number(m[2]) !== (startYear + 1) % 100) return null;
  return {
    startYear,
    start: augustFirst(startYear),
    endExclusive: augustFirst(startYear + 1),
  };
}

export function isValidAcademicYear(value: string): boolean {
  return parseAcademicYear(value) !== null;
}

/** The academic year `date` falls in, e.g. 2026-08-01 -> "AY2026/27". */
export function currentAcademicYear(date: Date): string {
  const sg = new Date(date.getTime() + SGT_OFFSET_MS);
  const startYear =
    sg.getUTCMonth() >= 7 ? sg.getUTCFullYear() : sg.getUTCFullYear() - 1;
  return `AY${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
}
