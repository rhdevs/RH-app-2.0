/**
 * Plain-English copy for the /admin/aux-points screen. The server answers with
 * sentinels (services/auxPoints/writes.ts and the router's capability check); they
 * reach the client verbatim because `sanitizeErrors` only rewrites
 * INTERNAL_SERVER_ERROR.
 */

const SENTINELS: Record<string, string> = {
  AUX_YEAR_READ_ONLY:
    "That belongs to an earlier points year, which can no longer be changed.",
  AUX_EVENT_CLOSED: "A cancelled or declined event can’t count as AUX.",
  NOT_AN_AUX_EVENT: "That event isn’t an AUX event any more. Reload the page.",
  EVENT_NOT_FOUND: "That event no longer exists.",
  AUX_RECORD_NOT_FOUND: "That record-only event no longer exists.",
  AUX_AWARD_NOT_FOUND: "That award no longer exists.",
  ATTENDEE_NOT_FOUND: "That person was already taken off the list.",
  RESIDENT_NOT_FOUND: "No account matches that matric, email or NUSNET id.",
  AUX_BAD_AMOUNT: "An award must be a whole number from 1 to 20.",
  AUX_BAD_DATE: "That date isn’t a real date.",
  AUX_TOO_MANY_LINES: "Paste at most 500 lines at a time.",
  AUX_AWARD_DUPLICATE:
    "They already have an award with this reason and date, so it wasn’t added again.",
};

export function auxErrorCopy(error: unknown): string {
  const e = error as { message?: string; data?: { code?: string } };
  const message = e?.message ?? "";
  if (e?.data?.code === "UNAUTHORIZED") {
    return "You’re signed out. Sign in again to change this.";
  }
  if (
    message.startsWith("CAPABILITY_REQUIRED") ||
    message === "INSUFFICIENT_ROLE"
  ) {
    return "You don’t have permission to change AUX any more. Reload the page.";
  }
  const known = SENTINELS[message];
  if (known) return known;
  if (e?.data?.code === "BAD_REQUEST") {
    return "Check the details: something isn’t filled in correctly.";
  }
  return "That didn’t save. Try again.";
}

export const UNRESOLVED_COPY = {
  NOT_FOUND: "no account found",
  AMBIGUOUS: "matric is on more than one account",
  REPEATED: "already listed above",
} as const;

export type UnresolvedReason = keyof typeof UNRESOLVED_COPY;

/** "Added 3. 1 was already there." for a paste result. */
export function addSummary(added: number, already: number): string {
  const parts = [`Added ${added}.`];
  if (already > 0) {
    parts.push(`${already} ${already === 1 ? "was" : "were"} already there.`);
  }
  return parts.join(" ");
}

/** The text of a CSV or text file a JCRC member picked, for the paste box. */
export const PASTE_FILE_TYPES = ".csv,.txt,text/csv,text/plain";
export const PASTE_FILE_MAX_BYTES = 50_000;

export function pasteFileError(file: { size: number }): string | null {
  return file.size > PASTE_FILE_MAX_BYTES
    ? "That file is too big. Use a CSV of at most 500 lines."
    : null;
}

/** Today's date in Singapore as "YYYY-MM-DD", for a date input's default. */
export function sgtToday(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
