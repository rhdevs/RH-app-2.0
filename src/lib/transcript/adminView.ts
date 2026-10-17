/**
 * Small view-model helpers for the /admin/transcripts screens. PURE: the
 * wording lives here so it can be tested and kept consistent (sentence case,
 * no exclamation marks).
 */

import { normaliseYearStatus, type YearStatus } from "./lifecycle";

export type PeriodStatus = YearStatus;

/** The stored status, with null or an unknown value read as collecting. */
export function normaliseStatus(
  status: string | null | undefined,
): PeriodStatus {
  return normaliseYearStatus(status);
}

/** "Collecting", or "Open" once transcripts are open. */
export function statusLabel(status: string | null | undefined): string {
  return normaliseStatus(status) === "published" ? "Open" : "Collecting";
}

/**
 * Whether the manager screens (awards, JCRC page) may write. Only an open
 * (published) year is locked; per-resident corrections handle it from then on.
 */
export function isWritable(status: string | null | undefined): boolean {
  return normaliseStatus(status) !== "published";
}

export const WRITES_LOCKED_NOTE =
  "Transcripts for this academic year are open, so changes are locked. Fix individual residents under Resident corrections.";

/** The one button of the year. */
export const OPEN_LABEL = "Open transcripts";

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

/** "3 members could not be matched", for a lock's unmatched roster rows. */
export const unresolvedNote = (count: number) =>
  `${plural(count, "member", "members")} could not be matched`;

/** A few words for why one CCA's member list could not be saved. */
const LOCK_FAILURE_TEXT: Record<string, string> = {
  PERIOD_PUBLISHED: "year already open",
  FREEZE_RACE: "list changed while saving",
  P2034: "busy, try again",
};
export const lockFailureText = (code: string) =>
  LOCK_FAILURE_TEXT[code] ?? code;

/** The confirmation of Open transcripts, in plain words. */
export const OPEN_CONFIRMATION = (academicYear: string) =>
  `Open transcripts for ${academicYear}? Every CCA's member list will be saved as it is now, all residents will be able to see and download their transcripts, and CCA heads will no longer be able to edit. After this, only JCRC and admin can fix individual residents.`;

/** The line after Open transcripts ran: opened, or what to fix first. */
export function openSummary(
  academicYear: string,
  result: {
    opened: boolean;
    lockedNow: number;
    alreadyLocked: number;
    failures: ReadonlyArray<{ name: string; code: string }>;
    unresolved: number;
  },
): string {
  const unmatched = result.unresolved
    ? ` ${unresolvedNote(result.unresolved)}.`
    : "";
  if (!result.opened) {
    const list = result.failures
      .map((f) => `${f.name} (${lockFailureText(f.code)})`)
      .join(", ");
    return `Transcripts for ${academicYear} are not open yet. ${plural(result.failures.length, "CCA", "CCAs")} could not be saved: ${list}. Press Open transcripts again to finish.${unmatched}`;
  }
  return `Transcripts for ${academicYear} are open. ${plural(result.lockedNow + result.alreadyLocked, "CCA member list", "CCA member lists")} saved.${unmatched}`;
}

/** From 1 April: time to open this year's transcripts. */
export const OPEN_REMINDER = (academicYear: string) =>
  `Transcripts for ${academicYear} are not open yet. Open them at the end of the year, before 1 August.`;

/** From 1 August: the previous year's transcripts were never opened. */
export const PREVIOUS_YEAR_WARNING = (academicYear: string) =>
  `Transcripts for ${academicYear} are still not open. Open them now, before CCAs change their member lists in the August application period.`;

/** The API's error codes, in plain words for an inline message. */
const ERROR_TEXT: Record<string, string> = {
  YEAR_NOT_STARTED:
    "This academic year has not started yet, so its transcripts cannot be opened.",
  NOT_THE_TERM_YEAR:
    "Heads can only change the current academic year. Other years are read-only; ask the JCRC for changes.",
  SEM2_START_OUTSIDE_YEAR:
    "The semester 2 start date must fall inside the academic year.",
  ALREADY_PUBLISHED: "Transcripts for this academic year are already open.",
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
  NOT_A_VOLUNTEERING_CCA: "This CCA is no longer a volunteering CCA.",
  SESSION_NOT_FOUND: "That session no longer exists.",
  SESSION_REMOVED: "That session has been removed. Restore it to edit it.",
  ONEOFF_HAS_ONE_SESSION: "A one-off activity has exactly one session.",
  INVALID_ATTENDANCE:
    "Someone or some session in that save was removed. Reload and try again.",
  DUPLICATE_CHANGE: "The same tick was sent twice. Reload and try again.",
  HOURS_REQUIRED_FOR_ONEOFF: "A one-off activity needs its hours.",
  TOO_MANY_CHANGES: "Too many changes at once. Save in smaller steps.",
  TOO_MANY_AT_ONCE:
    "That is more than one save can take. Do it in smaller steps.",
  TOO_MANY_ROWS:
    "This file has more than 10,000 rows. Split it and upload in parts.",
  UNDECIDED_AWARD_NAMES: "Decide every new award name before importing.",
  AWARD_TYPE_GONE:
    "An award chosen for a new name is no longer in the catalogue.",
  AWARD_NAME_TAKEN:
    "An award with that name already exists. Archived ones count too.",
  AWARD_TYPE_NOT_FOUND: "That award is no longer in the catalogue.",
  AWARD_TYPE_ARCHIVED:
    "That award is archived. Restore it in the catalogue first.",
  AWARD_REMOVED: "That award has been removed. Restore it to edit it.",
  AWARD_DUPLICATE: "That person already has this award for the year.",
  BATCH_NOT_FOUND: "That upload no longer exists.",
  BATCH_ALREADY_UNDONE: "That upload was already undone.",
  NOT_A_CCA_HEAD: "Only CCA heads can search residents.",
  ACTIVITY_NOT_FOUND: "That activity no longer exists.",
  ACTIVITY_REMOVED: "That activity has been removed. Restore it to edit it.",
  DUPLICATE_PARTICIPANT: "The same person is listed twice.",
  JCRC_MEMBER_REQUIRED: "Only JCRC members have a JCRC page.",
  RECORD_NOT_FOUND: "That record no longer exists.",
  DATE_REQUIRED_FOR_ONEOFF: "A one-off activity needs a date.",
  DATE_OUTSIDE_ACADEMIC_YEAR:
    "The date must fall inside the academic year, 1 August to 31 July.",
  DATE_ONLY_FOR_ONEOFF: "Only a one-off activity has a date.",
  HOURS_TOO_SMALL: "Hours must be at least 0.25.",
  HOURS_TOO_LARGE: "Hours must be at most 24.",
  HOURS_MUST_BE_QUARTERS: "Hours go up in steps of 0.25.",
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
  if (code === "UPLOAD_PARTIAL") {
    // "UPLOAD_PARTIAL:<rows written>", from an import that stopped part way.
    return `The upload stopped part way: ${message.split(":")[1] ?? "0"} imported. Undo it from History, fix the file, and upload again.`;
  }
  const known = ERROR_TEXT[message] ?? ERROR_TEXT[code];
  if (known) return known;
  // Zod errors and other readable messages from the API are kept short.
  if (/^[A-Z0-9_]+(:.*)?$/.test(message))
    return "Something went wrong. Try again.";
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
