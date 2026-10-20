import { currentAcademicYear, parseAcademicYear } from "./academicYear";

/**
 * THE YEAR LIFECYCLE, as pure rules. ONE step per year:
 *
 *   collecting --Open transcripts--> published ("Open")
 *
 *  - COLLECTING: the CCA's current heads fill in the current year's records;
 *    residents see nothing. Each CCA's member list is its LIVE list.
 *  - OPEN TRANSCRIPTS (JCRC or admin, around April, before 1 August): locks every
 *    CCA's member list for the year as it is, then opens transcripts to every
 *    resident. After that only per-resident corrections change anything. Only
 *    the CURRENT year can be opened: once 1 August has passed, the August
 *    application period has changed the member lists, so a past year would get
 *    the next year's members.
 *
 * No clock is read here: every function takes `now`, so a test can move through
 * the years.
 */

/** Transcripts start at AY2026/27; there is no earlier year. */
export const FIRST_ACADEMIC_YEAR = "AY2026/27";

/**
 * A year is "collecting" or "published" (shown as "Open"). Any other stored
 * value (an old "closed" row, or none) reads as collecting.
 */
export type YearStatus = "collecting" | "published";

/** Why a CCA's member list was locked: Open transcripts is the only one. */
export type FreezeReason = "open";

export const FREEZE_REASONS: readonly FreezeReason[] = ["open"];

/** The state words shown for a CCA's member list. */
export const FREEZE_STATE_LABEL: Record<FreezeReason | "none", string> = {
  none: "Not saved",
  open: "Saved when transcripts opened",
};

export function normaliseYearStatus(
  status: string | null | undefined,
): YearStatus {
  return status === "published" ? "published" : "collecting";
}

/** "AY2026/27" for start year 2026. */
export function formatAcademicYear(startYear: number): string {
  return `AY${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The year after, "AY2026/27" -> "AY2027/28". */
export function nextAcademicYear(academicYear: string): string {
  const ay = parseAcademicYear(academicYear);
  if (!ay) throw new RangeError(`Not an academic year: ${academicYear}`);
  return formatAcademicYear(ay.startYear + 1);
}

/** Does `a` come after `b`? Compares start years; both must be valid. */
export function isLater(a: string, b: string): boolean {
  const x = parseAcademicYear(a);
  const y = parseAcademicYear(b);
  if (!x || !y) throw new RangeError(`Not an academic year: ${a} or ${b}`);
  return x.startYear > y.startYear;
}

/** Every academic year from the first to `last`, oldest first. */
export function academicYearsUpTo(last: string): string[] {
  const first = parseAcademicYear(FIRST_ACADEMIC_YEAR)!;
  const end = parseAcademicYear(last);
  if (!end) throw new RangeError(`Not an academic year: ${last}`);
  const out: string[] = [];
  for (let y = first.startYear; y <= end.startYear; y += 1) {
    out.push(formatAcademicYear(y));
  }
  return out;
}

/* ---- opening transcripts --------------------------------------------------- */

export type OpenBlocker =
  | "YEAR_BEFORE_START"
  | "ALREADY_PUBLISHED"
  | "YEAR_NOT_STARTED"
  /** A past year: its member lists have changed since August. */
  | "YEAR_ENDED";

/** Is this a real academic year that comes before transcripts began? */
export function isBeforeFirstYear(academicYear: string): boolean {
  const ay = parseAcademicYear(academicYear);
  const first = parseAcademicYear(FIRST_ACADEMIC_YEAR);
  return ay !== null && first !== null && ay.startYear < first.startYear;
}

/**
 * Why Open transcripts must be refused for a year, or null if it may go ahead:
 * the year must not be before transcripts began, must still be collecting, and
 * must be the CURRENT year. A future year has not started; a past year's member
 * lists were changed by the August application period, so opening it would
 * save the next year's members into it.
 */
export function openBlocker(
  academicYear: string,
  status: YearStatus,
  now: Date,
): OpenBlocker | null {
  if (isBeforeFirstYear(academicYear)) return "YEAR_BEFORE_START";
  if (status === "published") return "ALREADY_PUBLISHED";
  const current = currentAcademicYear(now);
  if (isLater(academicYear, current)) return "YEAR_NOT_STARTED";
  if (academicYear !== current) return "YEAR_ENDED";
  return null;
}

/* ---- who may edit a CCA's records for a year ------------------------------ */

export type EditRefusal =
  | "PERIOD_PUBLISHED"
  /** The year has not started: nobody writes records for it yet. */
  | "YEAR_NOT_STARTED"
  /** Heads edit only the current academic year; other years are read-only. */
  | "NOT_THE_TERM_YEAR"
  | "NOT_A_HEAD_OF_THIS_CCA";

/**
 * May this person change a CCA's records for a year?
 *  - Nobody once transcripts for the year are open (published), except the
 *    per-resident corrections, which are a separate path.
 *  - Nobody for a year after the current one: it has not started.
 *  - Managers (admin or jcrc): any CCA, for any year still collecting.
 *  - A current head of this CCA (whoever heads it now, so new heads after a
 *    handover too): only the CURRENT academic year. Other years are read-only.
 *  - Anyone else: no.
 */
export function editRefusal(input: {
  isManager: boolean;
  isHead: boolean;
  status: YearStatus;
  /** This year is the current academic year (by date, Singapore). */
  isCurrentYear: boolean;
  /** This year is after the current academic year. */
  isFutureYear?: boolean;
}): EditRefusal | null {
  if (input.status === "published") return "PERIOD_PUBLISHED";
  if (input.isFutureYear) return "YEAR_NOT_STARTED";
  if (input.isManager) return null;
  if (!input.isHead) return "NOT_A_HEAD_OF_THIS_CCA";
  return input.isCurrentYear ? null : "NOT_THE_TERM_YEAR";
}

/* ---- reminders on the admin page ------------------------------------------ */

/** Midnight in Singapore on a calendar day, as an instant. */
const sgMidnight = (year: number, monthIndex: number, day: number) =>
  Date.UTC(year, monthIndex, day) - 8 * 60 * 60 * 1000;

/**
 * From 1 April of the year (Singapore), while it is still collecting: time to
 * open transcripts, before 1 August.
 */
export function showOpenReminder(
  academicYear: string,
  status: YearStatus,
  now: Date,
): boolean {
  if (status !== "collecting") return false;
  const ay = parseAcademicYear(academicYear);
  if (!ay) return false;
  return now.getTime() >= sgMidnight(ay.startYear + 1, 3, 1);
}

/**
 * The PREVIOUS academic year when it is still collecting once the current one
 * has begun (from 1 August): its transcripts were never opened, and it can no
 * longer be opened from the app (see openBlocker). Null when there is no such
 * year (before the first transcript year) or it is open.
 */
export function previousYearNotOpen(
  now: Date,
  statusOf: (academicYear: string) => YearStatus,
): string | null {
  const current = parseAcademicYear(currentAcademicYear(now));
  const first = parseAcademicYear(FIRST_ACADEMIC_YEAR);
  if (!current || !first) return null;
  const previous = current.startYear - 1;
  if (previous < first.startYear) return null;
  const year = formatAcademicYear(previous);
  return statusOf(year) === "collecting" ? year : null;
}
