import { isRealIsoDate } from "./academicYear";
import { parseAcademicYear } from "./academicYear";

/**
 * VOLUNTEER ACTIVITIES, as pure rules: limits, session defaults, and the hours
 * a person is credited with. No database, no clock (callers pass today's date).
 */

export const VOLUNTEER_TITLE_MAX = 80;
export const VOLUNTEER_DESCRIPTION_MAX = 300;
export const VOLUNTEER_HOURS_MIN = 0.25;
export const VOLUNTEER_HOURS_MAX = 24;
/**
 * HIDDEN safety caps, far above real use and never shown on a screen: volunteer
 * activities per CCA and year, sessions per activity, and people in one save.
 */
export const MAX_VOLUNTEER_ACTIVITIES = 1000;
export const MAX_VOLUNTEER_SESSIONS = 1000;
export const MAX_VOLUNTEER_PEOPLE = 2000;
/** Sessions the attendance grid draws at once. */
export const GRID_PAGE_SIZE = 8;
/** What the first session lasts when the activity has no default. */
export const FALLBACK_SESSION_HOURS = 1;

export const VOLUNTEER_KINDS = ["regular", "oneoff"] as const;
export type VolunteerKind = (typeof VOLUNTEER_KINDS)[number];

export const KIND_LABEL: Record<VolunteerKind, string> = {
  regular: "Regular",
  oneoff: "One-off",
};

export const readKind = (v: string | null | undefined): VolunteerKind =>
  v === "oneoff" ? "oneoff" : "regular";

/** 0.25 to 24 in quarter hours (a quarter is exact in binary). */
export function isValidHours(hours: number): boolean {
  return (
    Number.isFinite(hours) &&
    hours >= VOLUNTEER_HOURS_MIN &&
    hours <= VOLUNTEER_HOURS_MAX &&
    Number.isInteger(hours * 4)
  );
}

/** "1.5", "42", "0.25": no trailing zeros, no floating-point noise. */
export function formatVolunteerHours(hours: number): string {
  return String(Math.round(hours * 100) / 100);
}

/** What one tick is worth: the cell's own hours, else the session's. */
export const creditedHours = (
  sessionHours: number,
  hoursOverride: number | null | undefined,
): number => hoursOverride ?? sessionHours;

/* ---- dates ----------------------------------------------------------------- */

/** "2026-09-12" plus 7 days -> "2026-09-19". Calendar arithmetic, no time zone. */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First and last calendar date of an academic year, or null if it is not one. */
export function ayDateRange(
  academicYear: string,
): { first: string; last: string } | null {
  const ay = parseAcademicYear(academicYear);
  return ay
    ? { first: `${ay.startYear}-08-01`, last: `${ay.startYear + 1}-07-31` }
    : null;
}

/** Pull a date back into the academic year (earlier -> 1 Aug, later -> 31 Jul). */
export function clampIntoAy(iso: string, academicYear: string): string {
  const range = ayDateRange(academicYear);
  if (!range || !isRealIsoDate(iso)) return iso;
  if (iso < range.first) return range.first;
  if (iso > range.last) return range.last;
  return iso;
}

export interface SessionDefaults {
  date: string;
  hours: number;
}

/**
 * The date and hours a new session starts with. After the first it is a week
 * after the LATEST active session, with its hours; the first uses the
 * activity's default hours and today's date. Always inside the academic year.
 */
export function nextSessionDefaults(input: {
  sessions: ReadonlyArray<{ date: string; hours: number }>;
  defaultHours: number | null | undefined;
  today: string;
  academicYear: string;
}): SessionDefaults {
  const last = [...input.sessions].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  )[0];
  if (!last) {
    return {
      date: clampIntoAy(input.today, input.academicYear),
      hours: input.defaultHours ?? FALLBACK_SESSION_HOURS,
    };
  }
  return {
    date: clampIntoAy(addDaysIso(last.date, 7), input.academicYear),
    hours: last.hours,
  };
}

/* ---- hours ----------------------------------------------------------------- */

export interface TotalsInput {
  /** The activity's ACTIVE sessions. */
  sessions: ReadonlyArray<{ id: string; hours: number }>;
  /** The activity's ACTIVE people. */
  people: readonly string[];
  /** Every tick on the activity (ticks on removed sessions or people are ignored). */
  attendance: ReadonlyArray<{
    sessionID: string;
    userID: string;
    hoursOverride?: number | null;
  }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Hours per active person: the sum over active sessions where they are ticked of
 * (override, else the session's hours). Anyone with no tick has 0.
 */
export function personTotals(input: TotalsInput): Map<string, number> {
  const hoursOf = new Map(input.sessions.map((s) => [s.id, s.hours]));
  const totals = new Map(input.people.map((p) => [p, 0]));
  for (const row of input.attendance) {
    const sessionHours = hoursOf.get(row.sessionID);
    if (sessionHours === undefined || !totals.has(row.userID)) continue;
    totals.set(
      row.userID,
      (totals.get(row.userID) ?? 0) +
        creditedHours(sessionHours, row.hoursOverride),
    );
  }
  return new Map([...totals].map(([k, v]) => [k, round2(v)]));
}

/** Everyone's hours added up. */
export const grandTotal = (totals: ReadonlyMap<string, number>): number =>
  round2([...totals.values()].reduce((a, b) => a + b, 0));

/** Regular first, then by title, for a list or a transcript. */
export function compareVolunteerActivities(
  a: { kind: string; title: string },
  b: { kind: string; title: string },
): number {
  const rank = (k: string) => (readKind(k) === "regular" ? 0 : 1);
  return (
    rank(a.kind) - rank(b.kind) ||
    a.title.localeCompare(b.title, "en", { sensitivity: "base" })
  );
}

/* ---- wording ----------------------------------------------------------------- */

/** "1 volunteer activity", "3 volunteer activities": a plain count. */
export const volunteerCountLine = (active: number) =>
  `${active} volunteer ${active === 1 ? "activity" : "activities"}`;

export const NOT_VOLUNTEERING_NOTE =
  "This CCA is no longer a volunteering CCA.";

export const REMOVE_VOLUNTEER_ACTIVITY_CONFIRMATION =
  "This takes the activity and its hours off every transcript. You can restore it later from Show removed.";
