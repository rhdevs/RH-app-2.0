import { parseAcademicYear } from "./academicYear";
import { formatSgDate, sgDateToInstant } from "./sgDate";
import { yearFromParam } from "./assemble";

/**
 * Page-level decisions for /transcript, kept PURE so they can be
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

/** One entry in the year switcher. */
export interface YearChoice {
  academicYear: string;
  /** published: the transcript; unavailable: not open yet. */
  kind: "published" | "unavailable";
  /** "AY2026/27" or "AY2026/27 (not yet available)". */
  label: string;
}

export type TranscriptPageState =
  | { kind: "unauthenticated" }
  | { kind: "none_published"; currentAcademicYear: string }
  | {
      kind: "show";
      academicYear: string;
      /** What the selected year shows. */
      view: YearChoice["kind"];
      choices: YearChoice[];
      /** Whether to draw the switcher at all. */
      showSwitcher: boolean;
    };

export const choiceLabel = (
  academicYear: string,
  kind: YearChoice["kind"],
): string =>
  kind === "unavailable" ? `${academicYear} (not yet available)` : academicYear;

/**
 * What /transcript should do.
 *
 * The switcher offers every published (open) year, sorted, plus the current
 * academic year when it is not open yet (it reads "not yet available"). It
 * shows whenever the resident has a published year; with nothing published
 * there is only the calm "not available" page.
 *
 * A requested year is honoured when it is one of the choices (so the current
 * year is shown as it is, never swapped for another). Anything else falls back
 * to the latest published year, never an error.
 */
export function selectTranscriptState(input: {
  authenticated: boolean;
  /** The published (open) years. */
  published: readonly string[];
  requested: string | null;
  currentAcademicYear: string;
}): TranscriptPageState {
  if (!input.authenticated) return { kind: "unauthenticated" };
  const choices: YearChoice[] = [...input.published]
    .sort((a, b) => a.localeCompare(b))
    .map((academicYear) => ({
      academicYear,
      kind: "published" as const,
      label: choiceLabel(academicYear, "published"),
    }));
  if (choices.length === 0) {
    return {
      kind: "none_published",
      currentAcademicYear: input.currentAcademicYear,
    };
  }
  if (!choices.some((c) => c.academicYear === input.currentAcademicYear)) {
    choices.push({
      academicYear: input.currentAcademicYear,
      kind: "unavailable",
      label: choiceLabel(input.currentAcademicYear, "unavailable"),
    });
  }
  const published = choices.filter((c) => c.kind === "published");
  const requested =
    input.requested === null
      ? undefined
      : choices.find((c) => c.academicYear === input.requested);
  const chosen = requested ?? published[published.length - 1]!;
  return {
    kind: "show",
    academicYear: chosen.academicYear,
    view: chosen.kind,
    choices,
    showSwitcher: true,
  };
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
