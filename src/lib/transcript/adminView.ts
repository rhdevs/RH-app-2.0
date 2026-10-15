/**
 * Small view-model helpers for the /admin/transcripts screens. PURE: the
 * wording lives here so it can be tested and kept consistent (sentence case,
 * no exclamation marks).
 */

import {
  normaliseYearStatus,
  type YearAction,
  type YearStatus,
} from "./lifecycle";

export type PeriodStatus = YearStatus;

/** The stored status, with null or an unknown value read as collecting. */
export function normaliseStatus(
  status: string | null | undefined,
): PeriodStatus {
  return normaliseYearStatus(status);
}

export function statusLabel(status: string | null | undefined): string {
  const s = normaliseStatus(status);
  return s === "published"
    ? "Published"
    : s === "closed"
      ? "Closed"
      : "Collecting";
}

/**
 * Whether the manager screens (awards, JCRC page) may write. Only a published
 * year is locked; a closed year is where the JCRC fixes data.
 */
export function isWritable(status: string | null | undefined): boolean {
  return normaliseStatus(status) !== "published";
}

export const WRITES_LOCKED_NOTE =
  "This academic year is published, so changes are locked. Reopen it to make changes.";

/** The button for each year action. */
export const ACTION_LABEL: Record<YearAction, string> = {
  close: "Close year",
  publish: "Publish",
  reopen: "Reopen for review",
  backToCollecting: "Back to collecting",
};

/**
 * The years to offer in the picker: every existing period plus the current
 * academic year, newest first, each once.
 */
export function yearOptions(
  periods: ReadonlyArray<{ academicYear: string }>,
  currentAcademicYear: string,
): string[] {
  return [
    ...new Set([currentAcademicYear, ...periods.map((p) => p.academicYear)]),
  ].sort((a, b) => b.localeCompare(a));
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** "Closed AY2026/27. 12 CCAs frozen, 77 were frozen already." */
export function closeSummary(
  academicYear: string,
  result: { frozenNow: number; alreadyFrozen: number },
): string {
  return `${academicYear} closed. ${plural(result.frozenNow, "CCA", "CCAs")} frozen now, ${result.alreadyFrozen} already frozen.`;
}

export const CLOSE_CONFIRMATION = (academicYear: string, unfrozen: number) =>
  `This freezes the member list of ${plural(unfrozen, "CCA", "CCAs")} that ${unfrozen === 1 ? "is" : "are"} not frozen yet, and opens ${academicYear} for review. Residents will see a draft.`;

export const PUBLISH_CONFIRMATION = (academicYear: string) =>
  `This lets residents download their ${academicYear} transcripts. Edits stop until you reopen the year for review.`;

export const REOPEN_CONFIRMATION =
  "This takes the published transcripts back to review. Residents see a draft again and you can fix data. Frozen member lists stay frozen.";

export const BACK_TO_COLLECTING_CONFIRMATION =
  "This puts the year back to collecting. Frozen member lists stay frozen.";

export const UNFREEZE_WARNING = (academicYear: string) =>
  `The CCA's current member list will be used for ${academicYear} until it is frozen again.`;

/** The 1 June warning: "3 CCAs are not frozen for AY2026/27 yet. ..." */
export const UNFROZEN_BANNER = (count: number, academicYear: string) =>
  `${count} ${count === 1 ? "CCA is" : "CCAs are"} not frozen for ${academicYear} yet. Close the year before memberships change.`;

/** The API's error codes, in plain words for an inline message. */
const ERROR_TEXT: Record<string, string> = {
  SEM2_START_REQUIRED: "Set the semester 2 start date before closing the year.",
  YEAR_NOT_STARTED:
    "This academic year has not started yet, so it cannot be closed.",
  NOT_COLLECTING: "This academic year is not collecting.",
  NOT_CLOSED: "This academic year is not closed.",
  NOT_FROZEN: "That member list is not frozen.",
  YEAR_CLOSED: "This year is closed. Ask the JCRC for changes.",
  CCA_YEAR_FROZEN: "This member list is frozen. Ask the JCRC for changes.",
  TRANSCRIPT_FREEZE_FAILED:
    "The member list could not be frozen, so the head change was not made. Try again.",
  SEM2_START_OUTSIDE_YEAR:
    "The semester 2 start date must fall inside the academic year.",
  ALREADY_PUBLISHED: "This academic year is already published.",
  NOT_PUBLISHED: "This academic year is not published.",
  PERIOD_NOT_FOUND:
    "Save a semester 2 start date first to set up this academic year.",
  PERIOD_PUBLISHED: WRITES_LOCKED_NOTE,
  PERIOD_CHANGING:
    "Someone else is changing this academic year. Reload and try again.",
  RESIDENT_NOT_FOUND: "No resident was found for that selection.",
  CCA_NOT_FOUND: "That CCA no longer exists.",
  INSUFFICIENT_ROLE: "You do not have access to this.",
  INVALID_ACADEMIC_YEAR: "That is not a valid academic year.",
  RATE_LIMITED: "Too many attempts. Try again later.",
  ROLE_PERIOD_OUTSIDE_MEMBERSHIP:
    "The role period must fit inside the membership period.",
  NOT_A_MEMBER: "That person is no longer a member of this CCA.",
  NOT_A_HEAD_OF_THIS_CCA: "You do not head this CCA.",
  NOT_A_VOLUNTEERING_CCA: "This CCA does not record volunteer hours.",
  NOT_A_VOLUNTEERING_HEAD:
    "Only heads of volunteering CCAs can search residents.",
  JCRC_MEMBER_REQUIRED: "Only JCRC members have a JCRC page.",
  RECORD_NOT_FOUND: "That record no longer exists.",
  DATE_REQUIRED_FOR_ONEOFF: "A one-off activity needs a date.",
  DATE_OUTSIDE_ACADEMIC_YEAR:
    "The date must fall inside the academic year, 1 August to 31 July.",
  DATE_ONLY_FOR_ONEOFF: "Only a one-off activity has a date.",
  HOURS_TOO_SMALL: "Hours must be at least 0.25.",
  HOURS_TOO_LARGE: "Hours must be at most 200.",
  HOURS_MUST_BE_QUARTERS: "Hours go up in steps of 0.25.",
  AT_MOST_10_CONTRIBUTIONS: "Use at most 10 contributions.",
};

/** The server's validation codes (see manageInput.ts), as sentences. */
function validationText(message: string): string | null {
  const most = /^AT_MOST_(\d+)_CHARACTERS$/.exec(message);
  if (most) return `Use at most ${most[1]} characters.`;
  const least = /^AT_LEAST_(\d+)_CHARACTERS$/.exec(message);
  if (least) return `Use at least ${least[1]} characters.`;
  if (message === "REQUIRED") return "This field is required.";
  if (message === "CONTROL_CHARACTERS_NOT_ALLOWED") {
    return "Remove any control characters.";
  }
  if (message === "INVISIBLE_CHARACTERS_NOT_ALLOWED") {
    return "Remove any invisible or direction-changing characters.";
  }
  if (message === "INVALID_DATE") return "Enter a real date.";
  return null;
}

/**
 * The first validation message for one field of a failed request, from the
 * `zodError` the API attaches to its errors, or null.
 */
export function fieldError(
  zodError:
    | { fieldErrors?: Record<string, string[] | undefined> }
    | null
    | undefined,
  field: string,
): string | null {
  const first = zodError?.fieldErrors?.[field]?.[0];
  return first ? errorText(first) : null;
}

/** A readable message for an API error; unknown codes get a generic line, never a stack. */
export function errorText(message: string | null | undefined): string {
  if (!message) return "Something went wrong. Try again.";
  const validation = validationText(message);
  if (validation) return validation;
  const code = message.split(":")[0]!;
  const known = ERROR_TEXT[message] ?? ERROR_TEXT[code];
  if (known) return known;
  // Zod errors and other readable messages from the API are kept short.
  if (/^[A-Z0-9_]+(:.*)?$/.test(message))
    return "Something went wrong. Try again.";
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
