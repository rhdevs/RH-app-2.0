import type { Duration } from "./duration";
import { isDuration, roleFits } from "./duration";

/**
 * View-model helpers for the CCA head's Transcript tab and the JCRC page. PURE:
 * the wording, limits and dirty-row logic live here so they can be tested and
 * kept in step with the server limits in manageInput.ts.
 */

export const ROLE_MAX = 60;
export const EXTRA_MAX = 500;

export const PORTFOLIO_MAX = 80;
export const POSITION_MAX = 80;
export const DESCRIPTION_MAX = 800;
export const CONTRIBUTION_ACTIVITY_MAX = 80;
export const CONTRIBUTION_ROLE_MAX = 60;
export const CONTRIBUTION_DESCRIPTION_MAX = 300;
/** HIDDEN safety cap on JCRC contribution rows in one save; never shown. */
export const CONTRIBUTIONS_MAX_ITEMS = 200;
export const TESTIMONIAL_MAX = 1500;

export const PUBLISHED_NOTE = (academicYear: string) =>
  `Transcripts for ${academicYear} are open. Editing is closed. Ask the JCRC to fix individual residents.`;

export const ROSTER_HELPER =
  "Members who leave the CCA before transcripts open are not listed on them.";

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

/**
 * "Full year" (the default, no stored choice), then the two semesters. There is
 * no "Default (...)" entry: a full year IS the default.
 */
export function durationOptions(): DurationOption[] {
  return [
    { value: "", label: DURATION_LABEL.full },
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

/** A stored "full" and no stored choice are the same thing: a full year. */
const asChoice = (v: string | null): DurationChoice =>
  isDuration(v) && v !== "full" ? v : "";

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

/* ---- JCRC contribution rows ------------------------------------------------ */

/** One row of "Contributions during the year", as the editor holds it. */
export interface ContributionDraft {
  activity: string;
  role: string;
  description: string;
  /** Removed in the editor, still shown with Undo until the page is saved. */
  removed: boolean;
}

export const blankContribution = (): ContributionDraft => ({
  activity: "",
  role: "",
  description: "",
  removed: false,
});

/** The rows that will be saved: not removed, in order. */
export const liveContributions = (rows: readonly ContributionDraft[]) =>
  rows.filter((r) => !r.removed);

/** Move a row up (-1) or down (+1) past the next row that is not removed. */
export function moveContribution(
  rows: readonly ContributionDraft[],
  index: number,
  delta: -1 | 1,
): ContributionDraft[] {
  const next = [...rows];
  let target = index + delta;
  while (target >= 0 && target < next.length && next[target]!.removed) {
    target += delta;
  }
  if (target < 0 || target >= next.length || !next[index]) return next;
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/** Can the live row at `index` (among all rows) move that way? */
export function canMoveContribution(
  rows: readonly ContributionDraft[],
  index: number,
  delta: -1 | 1,
): boolean {
  for (let i = index + delta; i >= 0 && i < rows.length; i += delta) {
    if (!rows[i]!.removed) return true;
  }
  return false;
}

/** Is the list of live rows the same, row for row, ignoring surrounding spaces? */
export function sameContributions(
  a: readonly ContributionDraft[],
  b: readonly ContributionDraft[],
): boolean {
  const x = liveContributions(a);
  const y = liveContributions(b);
  return (
    x.length === y.length &&
    x.every(
      (r, i) =>
        r.activity.trim() === y[i]!.activity.trim() &&
        r.role.trim() === y[i]!.role.trim() &&
        r.description.trim() === y[i]!.description.trim(),
    )
  );
}

/** A reason the rows cannot be saved yet, or null. */
export function contributionsProblem(
  rows: readonly ContributionDraft[],
): string | null {
  return liveContributions(rows).some((r) => r.activity.trim() === "")
    ? "Each contribution needs an activity."
    : null;
}

/** The rows as the API takes them: trimmed, in order, removed rows left out. */
export function contributionsPayload(rows: readonly ContributionDraft[]) {
  return liveContributions(rows).map((r) => ({
    activity: r.activity.trim(),
    role: r.role.trim(),
    description: r.description.trim(),
  }));
}

/* ---- role period inside the membership period ------------------------------ */

/** The membership period in force for a draft: the choice, else a full year. */
export function effectiveMembership(choice: DurationChoice): Duration {
  return choice === "" ? "full" : choice;
}

/**
 * The role period choices for a membership. A full-year member may choose any;
 * a semester member only that semester.
 */
export function roleDurationOptions(membership: Duration): DurationOption[] {
  return membership === "full"
    ? durationOptions()
    : [{ value: membership, label: DURATION_LABEL[membership] }];
}

/** The value a role period select shows: a semester member has only the one choice. */
export function roleDurationValue(
  membership: Duration,
  roleDuration: DurationChoice,
): DurationChoice {
  return membership === "full" ? roleDuration : membership;
}

/**
 * After a change, make the role period fit the membership. A role period that
 * would stick out is changed to match, with the one line to show for it.
 */
export function fitRolePeriod(draft: RowDraft): {
  draft: RowDraft;
  note: string | null;
} {
  const membership = effectiveMembership(draft.duration);
  if (draft.roleDuration === "" || roleFits(membership, draft.roleDuration)) {
    return { draft, note: null };
  }
  return {
    draft: { ...draft, roleDuration: membership },
    note: `Role period changed to ${DURATION_LABEL[membership]} to match membership.`,
  };
}

/* ---- the year lifecycle on the head's tab --------------------------------- */

export const NO_MEMBER_LIST_NOTE = "No member list was recorded for this year.";

/**
 * The one line above the roster that explains its state, or null. Plain words:
 * transcripts open, another year than the current one, or no list.
 */
export function rosterNotice(input: {
  academicYear: string;
  mode: "frozen" | "live" | "none";
  /** Why this person cannot edit, or null if they can. */
  refusal:
    | "PERIOD_PUBLISHED"
    | "NOT_THE_TERM_YEAR"
    | "NOT_A_HEAD_OF_THIS_CCA"
    | null;
}): string | null {
  if (input.refusal === "PERIOD_PUBLISHED") {
    return PUBLISHED_NOTE(input.academicYear);
  }
  if (input.mode === "none") return NO_MEMBER_LIST_NOTE;
  if (input.refusal === "NOT_THE_TERM_YEAR") {
    return "Heads can only change the current academic year. Ask the JCRC for changes to other years.";
  }
  return null;
}
