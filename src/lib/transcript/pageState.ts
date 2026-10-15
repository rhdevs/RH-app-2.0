import { parseAcademicYear } from "./academicYear";
import { formatSgDate, sgDateToInstant } from "./sgDate";
import { yearFromParam } from "./assemble";

/**
 * Page-level decisions for /transcript and /verify, kept PURE so they can be
 * tested without rendering a page or touching a database.
 */

/**
 * `?ay=2026-27` (or `AY2026/27`) -> "AY2026/27", or null for anything that is
 * not a real academic year. Never throws: a bad value just means "no request".
 */
export function parseAyParam(
  raw: string | string[] | undefined,
): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > 16) return null;
  const ay = yearFromParam(value.trim());
  return parseAcademicYear(ay) ? ay : null;
}

export type TranscriptPageState =
  | { kind: "unauthenticated" }
  | { kind: "none_published"; currentAcademicYear: string }
  | { kind: "show"; academicYear: string; published: string[] };

/**
 * What /transcript should do. A requested year is honoured only if it is
 * published; otherwise the latest published year is shown, never an error.
 */
export function selectTranscriptState(input: {
  authenticated: boolean;
  published: readonly string[];
  requested: string | null;
  currentAcademicYear: string;
}): TranscriptPageState {
  if (!input.authenticated) return { kind: "unauthenticated" };
  const published = [...input.published].sort();
  const latest = published[published.length - 1];
  if (latest === undefined) {
    return {
      kind: "none_published",
      currentAcademicYear: input.currentAcademicYear,
    };
  }
  const academicYear =
    input.requested !== null && published.includes(input.requested)
      ? input.requested
      : latest;
  return { kind: "show", academicYear, published };
}

export const NOT_AVAILABLE_NOTES = {
  headline: (academicYear: string) =>
    `Your transcript for ${academicYear} isn’t available yet.`,
  detail: "It opens once the hall publishes transcripts.",
} as const;

/**
 * The banner asking residents to download in time, or null. Shown only for a
 * published year with a download-by date that is today (Singapore) or later.
 * Both dates are Singapore calendar dates, "2027-12-31", so they compare as
 * text.
 */
export function downloadByBanner(input: {
  academicYear: string;
  downloadBy: string | null;
  todaySg: string;
}): string | null {
  if (!input.downloadBy || input.todaySg > input.downloadBy) return null;
  const day = sgDateToInstant(input.downloadBy);
  if (!day) return null;
  return `Download your ${input.academicYear} transcript before ${formatSgDate(day)}.`;
}
