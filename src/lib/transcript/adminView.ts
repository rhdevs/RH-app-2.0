/**
 * Small view-model helpers for the /admin/transcripts screens. PURE: the
 * wording lives here so it can be tested and kept consistent (sentence case,
 * no exclamation marks).
 */

export type PeriodStatus = "collecting" | "published";

/** The stored status, with null or an unknown value read as collecting. */
export function normaliseStatus(
  status: string | null | undefined,
): PeriodStatus {
  return status === "published" ? "published" : "collecting";
}

export function statusLabel(status: string | null | undefined): string {
  return normaliseStatus(status) === "published" ? "Published" : "Collecting";
}

/** Writes are allowed only while an academic year is collecting. */
export function isWritable(status: string | null | undefined): boolean {
  return normaliseStatus(status) === "collecting";
}

export const WRITES_LOCKED_NOTE =
  "This academic year is published, so changes are locked. Reopen it to make changes.";

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

/** "64 members frozen, 2 rows could not be matched". Both counts are always shown. */
export function publishSummary(result: {
  frozen: number;
  skippedUnresolved: number;
}): string {
  return `${plural(result.frozen, "member", "members")} frozen, ${plural(result.skippedUnresolved, "row", "rows")} could not be matched`;
}

export const PUBLISH_CONFIRMATION = (academicYear: string) =>
  `This freezes the member list for ${academicYear} and lets residents download their transcripts. Edits stop until you reopen.`;

export const REOPEN_CONFIRMATION =
  "This reopens editing. Residents cannot open their transcripts until the year is published again, and then they see the corrected data.";

/** The API's error codes, in plain words for an inline message. */
const ERROR_TEXT: Record<string, string> = {
  SEM2_START_REQUIRED: "Set the semester 2 start date before publishing.",
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
