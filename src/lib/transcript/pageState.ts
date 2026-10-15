import { parseAcademicYear } from "./academicYear";
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

/** The exact wording of each /verify outcome. */
export const VERIFY_NOTES = {
  valid: "This record is valid.",
  superseded:
    "This record has been superseded by a later version. Ask the resident for the current transcript.",
  revoked: "This record has been revoked.",
  not_found: "We could not verify this code. Check it for typing mistakes.",
  rate_limited: "Too many attempts. Try again later.",
  specimen:
    "Specimen record. This is a demonstration with made-up details; it does not confirm anyone\u2019s participation.",
} as const;

export const NOT_AVAILABLE_NOTES = {
  headline: (academicYear: string) =>
    `Your transcript for ${academicYear} isn’t available yet.`,
  detail: "It opens once the hall publishes transcripts.",
} as const;

/**
 * The site's own origin, for text printed on the document ("enter the code at
 * <origin>/verify"). The request host wins, so a preview deploy prints its own
 * address; NEXTAUTH_URL is the fallback. Null when neither is usable, and the
 * document then says "the verification page of this site".
 */
export function resolveSiteOrigin(input: {
  host?: string | null;
  proto?: string | null;
  envUrl?: string | null;
}): string | null {
  const host = input.host?.split(",")[0]?.trim();
  if (host && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(host)) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
    const proto = input.proto?.split(",")[0]?.trim().toLowerCase();
    const scheme =
      proto === "http" || proto === "https" ? proto : local ? "http" : "https";
    return `${scheme}://${host.toLowerCase()}`;
  }
  if (input.envUrl) {
    try {
      const u = new URL(input.envUrl);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch {
      /* fall through */
    }
  }
  return null;
}
