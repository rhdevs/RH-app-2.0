import type { Duration } from "./duration";
import { isDuration } from "./duration";

/**
 * View-model helpers for the CCA head's Transcript tab and the JCRC page. PURE:
 * the wording, limits and dirty-row logic live here so they can be tested and
 * kept in step with the server limits in manageInput.ts.
 */

export const ROLE_MAX = 60;
export const EXTRA_MAX = 500;
export const ACTIVITY_MAX = 120;
export const HOURS_MIN = 0.25;
export const HOURS_MAX = 200;

export const PORTFOLIO_MAX = 80;
export const POSITION_MAX = 80;
export const DESCRIPTION_MAX = 800;
export const CONTRIBUTION_MAX = 200;
export const CONTRIBUTIONS_MAX_ITEMS = 10;
export const TESTIMONIAL_MAX = 1500;

export const PUBLISHED_NOTE = (academicYear: string) =>
  `Transcripts for ${academicYear} are published. Editing is closed. Ask the JCRC to reopen it.`;

export const DEFAULTS_NOTE =
  "Default durations assume the full year until the JCRC sets the semester 2 start date.";

export const ROSTER_HELPER =
  "Members who leave the CCA before the year closes are not listed on the transcript.";

export const NO_DESCRIPTION_NOTE =
  "This CCA has no description yet. Add one so it appears in your members’ transcripts.";

export const SIGNATURE_PLACEHOLDER_NOTE =
  "The Master and President signatures on your JCRC page are placeholders for now.";

export const NOT_JCRC_NOTE = "Only JCRC members have a JCRC page.";

export const DURATION_LABEL: Record<Duration, string> = {
  full: "Full year",
  sem1: "Semester 1 only",
  sem2: "Semester 2 only",
};

export type DurationChoice = "" | Duration;

export interface DurationOption {
  value: DurationChoice;
  label: string;
}

/** "Default (Semester 2 only)" first, then the three explicit choices. */
export function durationOptions(
  computedDefault: Duration | null | undefined,
): DurationOption[] {
  const shown = computedDefault ? DURATION_LABEL[computedDefault] : "Full year";
  return [
    { value: "", label: `Default (${shown})` },
    { value: "full", label: DURATION_LABEL.full },
    { value: "sem1", label: DURATION_LABEL.sem1 },
    { value: "sem2", label: DURATION_LABEL.sem2 },
  ];
}

/** Characters left in a field, never below zero for display. */
export function remainingCharacters(text: string, max: number): number {
  return Math.max(0, max - text.length);
}

export const counterText = (text: string, max: number) =>
  `${remainingCharacters(text, max)} characters left`;

/* ---- roster rows --------------------------------------------------------- */

export interface RowDraft {
  duration: DurationChoice;
  roleLabel: string;
  roleDuration: DurationChoice;
  extra: string;
}

interface RowSource {
  duration: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
}

const asChoice = (v: string | null): DurationChoice => (isDuration(v) ? v : "");

/** The editable state of a row, from its stored overrides. */
export function draftOf(row: RowSource): RowDraft {
  return {
    duration: asChoice(row.duration),
    roleLabel: row.roleLabel ?? "",
    roleDuration: asChoice(row.roleDuration),
    extra: row.extraContribution ?? "",
  };
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();

/** Has the row changed from what is saved? Blank and absent count as the same. */
export function isDirty(draft: RowDraft, saved: RowDraft): boolean {
  return (
    draft.duration !== saved.duration ||
    norm(draft.roleLabel) !== norm(saved.roleLabel) ||
    draft.roleDuration !== saved.roleDuration ||
    norm(draft.extra) !== norm(saved.extra)
  );
}

/** Does the row's text respect the server limits? */
export function rowProblem(draft: RowDraft): string | null {
  if (norm(draft.roleLabel).length > ROLE_MAX) {
    return `Use at most ${ROLE_MAX} characters for the role.`;
  }
  if (norm(draft.extra).length > EXTRA_MAX) {
    return `Use at most ${EXTRA_MAX} characters for the contribution.`;
  }
  return null;
}

/** The roster.upsert fields for a draft: blank or "default" clears (null). */
export function upsertFields(draft: RowDraft) {
  const role = norm(draft.roleLabel);
  const extra = norm(draft.extra);
  return {
    duration: draft.duration === "" ? null : draft.duration,
    roleLabel: role === "" ? null : role,
    roleDuration: draft.roleDuration === "" ? null : draft.roleDuration,
    extraContribution: extra === "" ? null : extra,
  };
}

/* ---- volunteer hours ----------------------------------------------------- */

/** The hours a form field holds, or null when it is not a valid quarter hour. */
export function parseHours(text: string): number | null {
  const value = Number(text.trim());
  if (text.trim() === "" || !Number.isFinite(value)) return null;
  if (value < HOURS_MIN || value > HOURS_MAX) return null;
  return Number.isInteger(value * 4) ? value : null;
}

export function hoursProblem(text: string): string | null {
  if (text.trim() === "") return null;
  const value = Number(text.trim());
  if (!Number.isFinite(value)) return "Enter a number of hours.";
  if (value < HOURS_MIN) return `Hours must be at least ${HOURS_MIN}.`;
  if (value > HOURS_MAX) return `Hours must be at most ${HOURS_MAX}.`;
  if (!Number.isInteger(value * 4)) return "Hours go up in steps of 0.25.";
  return null;
}

export interface HoursTotal {
  userID: string;
  name: string;
  hours: number;
}

/** Total hours per resident, most hours first. */
export function hoursByResident(
  records: ReadonlyArray<{
    userID: string;
    displayName: string | null;
    hours: number;
  }>,
): HoursTotal[] {
  const totals = new Map<string, HoursTotal>();
  for (const r of records) {
    const existing = totals.get(r.userID);
    if (existing) existing.hours += r.hours;
    else
      totals.set(r.userID, {
        userID: r.userID,
        name: r.displayName ?? r.userID,
        hours: r.hours,
      });
  }
  return [...totals.values()].sort(
    (a, b) => b.hours - a.hours || a.name.localeCompare(b.name, "en"),
  );
}

export const formatHours = (hours: number) =>
  `${hours} ${hours === 1 ? "hour" : "hours"}`;

/** The first academic year transcripts exist for. */
export const FIRST_TRANSCRIPT_YEAR = 2026;

/** The years a head can pick, newest first, from AY2026/27 to the current one. */
export function headYearOptions(currentStartYear: number): string[] {
  const out: string[] = [];
  const last = Math.max(currentStartYear, FIRST_TRANSCRIPT_YEAR);
  for (let y = last; y >= FIRST_TRANSCRIPT_YEAR; y -= 1) {
    out.push(`AY${y}/${String((y + 1) % 100).padStart(2, "0")}`);
  }
  return out;
}

/* ---- after a save ---------------------------------------------------------- */

/**
 * What a form shows once a save succeeds. The saved values (as the server
 * stored them: trimmed, cleared fields as blanks) replace what was typed, so
 * the form reads as saved and no longer dirty. But if the person kept typing
 * while the request was in flight, their newer text wins and stays dirty:
 * `current` differing from `submitted` means exactly that. PURE.
 */
export function reconcileAfterSave<T>(
  current: T,
  submitted: T,
  fromServer: T,
  equal: (a: T, b: T) => boolean,
): T {
  return equal(current, submitted) ? fromServer : current;
}

/**
 * A text field of an add-form after a successful add: cleared, unless more was
 * typed since the request was sent.
 */
export function clearIfUnchanged(current: string, submitted: string): string {
  return current === submitted ? "" : current;
}
