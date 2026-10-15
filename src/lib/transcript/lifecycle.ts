import { currentAcademicYear, parseAcademicYear } from "./academicYear";

/**
 * THE YEAR LIFECYCLE, as pure rules: which academic year a CCA is working on,
 * what each status allows, and who may edit what. No clock is read here: every
 * function takes `now`, so a test can move through the years.
 *
 * An academic year runs 1 Aug to 31 Jul. A CCA's member list is frozen at its
 * own handover (the CCA is then cleared and re-recruited), so each CCA has its
 * own "term year": the oldest year it has not frozen yet.
 */

/** Transcripts start at AY2026/27; there is no earlier year. */
export const FIRST_ACADEMIC_YEAR = "AY2026/27";

export type YearStatus = "collecting" | "closed" | "published";

export type FreezeReason =
  | "handover"
  | "head_removed"
  | "lock"
  | "close_year";

export const FREEZE_REASONS: readonly FreezeReason[] = [
  "handover",
  "head_removed",
  "lock",
  "close_year",
];

/** The state words shown for a CCA's member list. */
export const FREEZE_STATE_LABEL: Record<FreezeReason | "none", string> = {
  none: "Not frozen",
  handover: "Frozen at handover",
  head_removed: "Head removed",
  lock: "Locked by head",
  close_year: "Closed with the year",
};

export function normaliseYearStatus(
  status: string | null | undefined,
): YearStatus {
  return status === "published" || status === "closed" ? status : "collecting";
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

/**
 * The year a CCA is working on: the earliest year, from AY2026/27 up to the
 * year after the current one, that it has not frozen. A handover in March
 * freezes this year, so new members after it count toward next year even
 * before 1 August. If every year in that span is frozen, the span's end.
 */
export function termAcademicYear(
  activelyFrozenYears: ReadonlySet<string>,
  now: Date,
): string {
  const ceiling = nextAcademicYear(currentAcademicYear(now));
  const years = academicYearsUpTo(ceiling);
  return years.find((y) => !activelyFrozenYears.has(y)) ?? ceiling;
}

export type FreezeTarget =
  | { kind: "freeze"; academicYear: string }
  | { kind: "skipped"; reason: "already_frozen_for_current_year" };

/**
 * Which year a handover, head removal or head lock freezes: the CCA's term
 * year, but never a future one. If the term year is already ahead of today's
 * year, the current year is frozen and there is nothing to do.
 */
export function freezeTarget(
  activelyFrozenYears: ReadonlySet<string>,
  now: Date,
): FreezeTarget {
  const term = termAcademicYear(activelyFrozenYears, now);
  if (isLater(term, currentAcademicYear(now))) {
    return { kind: "skipped", reason: "already_frozen_for_current_year" };
  }
  return { kind: "freeze", academicYear: term };
}

/* ---- the year status machine ---------------------------------------------- */

export type YearAction = "close" | "publish" | "reopen" | "backToCollecting";

export type TransitionBlocker =
  | "NOT_COLLECTING"
  | "NOT_CLOSED"
  | "NOT_PUBLISHED"
  | "SEM2_START_REQUIRED"
  | "YEAR_NOT_STARTED";

/** Where each action leads. */
export const NEXT_STATUS: Record<YearAction, YearStatus> = {
  close: "closed",
  publish: "published",
  reopen: "closed",
  backToCollecting: "collecting",
};

/**
 * Why `action` must be refused now, or null if it may go ahead.
 *  - close:            collecting only; the year must have begun; needs sem2Start.
 *  - publish:          closed only.
 *  - reopen:           published only (back to review).
 *  - backToCollecting: closed only.
 * A year with no period row counts as collecting with no semester 2 date.
 */
export function transitionBlocker(
  action: YearAction,
  period: { status: string | null; sem2Start: Date | null } | null,
  academicYear: string,
  now: Date,
): TransitionBlocker | null {
  const status = normaliseYearStatus(period?.status);
  switch (action) {
    case "close":
      if (status !== "collecting") return "NOT_COLLECTING";
      if (isLater(academicYear, currentAcademicYear(now))) {
        return "YEAR_NOT_STARTED";
      }
      if (!period?.sem2Start) return "SEM2_START_REQUIRED";
      return null;
    case "publish":
      return status === "closed" ? null : "NOT_CLOSED";
    case "reopen":
      return status === "published" ? null : "NOT_PUBLISHED";
    case "backToCollecting":
      return status === "closed" ? null : "NOT_CLOSED";
  }
}

/** The actions that make sense for a status, in the order they are offered. */
export function validActions(status: YearStatus): YearAction[] {
  switch (status) {
    case "collecting":
      return ["close"];
    case "closed":
      return ["publish", "backToCollecting"];
    case "published":
      return ["reopen"];
  }
}

/* ---- who may edit a CCA's records for a year ------------------------------ */

export type EditRefusal =
  | "PERIOD_PUBLISHED"
  | "YEAR_CLOSED"
  | "CCA_YEAR_FROZEN"
  | "NOT_A_HEAD_OF_THIS_CCA";

/**
 * May this person change a CCA's records for a year?
 *  - Nobody, once the year is published (except per-resident corrections, which
 *    are a separate path).
 *  - Managers (admin or jcrc): any CCA, collecting or closed.
 *  - The head of this CCA: only while the year is collecting AND the CCA's list
 *    is not frozen, or was frozen by the head's own "lock".
 *  - Anyone else: no.
 */
export function editRefusal(input: {
  isManager: boolean;
  isHead: boolean;
  status: YearStatus;
  /** The reason of the CCA's ACTIVE freeze for this year, or null. */
  freezeReason: FreezeReason | null;
}): EditRefusal | null {
  if (input.status === "published") return "PERIOD_PUBLISHED";
  if (input.isManager) return null;
  if (!input.isHead) return "NOT_A_HEAD_OF_THIS_CCA";
  if (input.status === "closed") return "YEAR_CLOSED";
  if (input.freezeReason !== null && input.freezeReason !== "lock") {
    return "CCA_YEAR_FROZEN";
  }
  return null;
}

/* ---- the June warning ------------------------------------------------------ */

/** From 1 June of the year's own August-to-July span until the year is closed. */
export function showUnfrozenWarning(
  academicYear: string,
  status: YearStatus,
  now: Date,
  unfrozenCount: number,
): boolean {
  if (status !== "collecting" || unfrozenCount === 0) return false;
  const ay = parseAcademicYear(academicYear);
  if (!ay) return false;
  // 1 June of the year the AY ends in, midnight Singapore.
  const june = Date.UTC(ay.startYear + 1, 5, 1) - 8 * 60 * 60 * 1000;
  return now.getTime() >= june;
}
