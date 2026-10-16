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
  /** published: the transcript; draft: the closed-year draft; unavailable: not yet. */
  kind: "published" | "draft" | "unavailable";
  /** "AY2026/27", "AY2026/27 (draft)" or "AY2026/27 (not yet available)". */
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
  kind === "draft"
    ? `${academicYear} (draft)`
    : kind === "unavailable"
      ? `${academicYear} (not yet available)`
      : academicYear;

/**
 * What /transcript should do.
 *
 * The switcher offers every published year (and any closed year, as a draft),
 * sorted, plus the current academic year when it is neither (it reads "not yet
 * available"). It shows whenever the resident has a published year, or the
 * current year is closed; with nothing published and the current year still
 * collecting there is only the calm "not available" page.
 *
 * A requested year is honoured when it is one of the choices (so the current
 * year is shown as it is, never swapped for another). Anything else falls back
 * to the latest published year, else the current year's draft, never an error.
 */
export function selectTranscriptState(input: {
  authenticated: boolean;
  /** Years the resident can open: published ones, and closed ones as drafts. */
  viewable: ReadonlyArray<{ academicYear: string; draft: boolean }>;
  requested: string | null;
  currentAcademicYear: string;
}): TranscriptPageState {
  if (!input.authenticated) return { kind: "unauthenticated" };
  const choices: YearChoice[] = [...input.viewable]
    .sort((a, b) => a.academicYear.localeCompare(b.academicYear))
    .map((y) => {
      const kind = y.draft ? ("draft" as const) : ("published" as const);
      return {
        academicYear: y.academicYear,
        kind,
        label: choiceLabel(y.academicYear, kind),
      };
    });
  const current = choices.find(
    (c) => c.academicYear === input.currentAcademicYear,
  );
  if (!current) {
    choices.push({
      academicYear: input.currentAcademicYear,
      kind: "unavailable",
      label: choiceLabel(input.currentAcademicYear, "unavailable"),
    });
  }
  const published = choices.filter((c) => c.kind === "published");
  const currentIsDraft = current?.kind === "draft";

  if (published.length === 0 && !currentIsDraft) {
    return {
      kind: "none_published",
      currentAcademicYear: input.currentAcademicYear,
    };
  }
  const requested =
    input.requested === null
      ? undefined
      : choices.find((c) => c.academicYear === input.requested);
  const chosen =
    requested ?? published[published.length - 1] ?? current ?? choices[0]!;
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
