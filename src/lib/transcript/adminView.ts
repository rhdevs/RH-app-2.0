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

export function reopenSummary(result: { superseded: number }): string {
  return `${plural(result.superseded, "transcript", "transcripts")} marked as superseded`;
}

export const PUBLISH_CONFIRMATION = (academicYear: string) =>
  `This freezes the member list for ${academicYear} and lets residents download their transcripts. Edits stop until you reopen.`;

export const REOPEN_CONFIRMATION =
  "This reopens editing. Transcripts already downloaded will be marked as superseded and residents will need to download again.";

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
};

/** A readable message for an API error; unknown codes get a generic line, never a stack. */
export function errorText(message: string | null | undefined): string {
  if (!message) return "Something went wrong. Try again.";
  const code = message.split(":")[0]!;
  const known = ERROR_TEXT[message] ?? ERROR_TEXT[code];
  if (known) return known;
  // Zod errors and other readable messages from the API are kept short.
  if (/^[A-Z0-9_]+(:.*)?$/.test(message))
    return "Something went wrong. Try again.";
  return message.length > 160 ? `${message.slice(0, 157)}...` : message;
}
