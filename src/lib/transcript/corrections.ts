import type { EditRefusal, YearStatus } from "./lifecycle";

/**
 * PER-RESIDENT CORRECTIONS, as pure rules. In a PUBLISHED year every write is
 * refused, except that a manager (admin or jcrc) may change the records of a
 * resident whose data they have UNLOCKED, and ONLY that resident's. Heads never
 * get this power. The decision is a function of facts the service reads.
 */

/** Refusal for a published year when some affected resident is still locked. */
export const ONLY_UNLOCKED_RESIDENTS = "ONLY_UNLOCKED_RESIDENTS";

export type WriteRefusal = EditRefusal | typeof ONLY_UNLOCKED_RESIDENTS;

export type WriteDecision =
  | {
      allow: true;
      /** True when the write is allowed only because every resident is unlocked. */
      correction: boolean;
    }
  | { allow: false; refusal: WriteRefusal };

/**
 * May this write go ahead?
 *  - If the ordinary edit guard allows it: yes (not a correction).
 *  - Otherwise, only in a published year, for a manager, with at least one
 *    affected resident and EVERY affected resident unlocked: yes (a correction).
 *  - A manager in a published year touching a locked resident: refused with
 *    ONLY_UNLOCKED_RESIDENTS. Anyone else, or a write that names no resident:
 *    the ordinary refusal.
 */
export function decideWrite(input: {
  /** What `editRefusal` says for this actor, CCA and year (null = allowed). */
  ordinary: EditRefusal | null;
  isManager: boolean;
  status: YearStatus;
  /** The residents the write changes (canonical keys), computed on the server. */
  affected: readonly string[];
  /** Residents with an ACTIVE unlock for this year. */
  unlocked: ReadonlySet<string>;
}): WriteDecision {
  if (input.ordinary === null) return { allow: true, correction: false };
  if (input.status !== "published" || !input.isManager) {
    return { allow: false, refusal: input.ordinary };
  }
  const affected = [...new Set(input.affected)];
  if (affected.length === 0) {
    return { allow: false, refusal: input.ordinary };
  }
  if (!affected.every((id) => input.unlocked.has(id))) {
    return { allow: false, refusal: ONLY_UNLOCKED_RESIDENTS };
  }
  return { allow: true, correction: true };
}

/** What a resident's year can be in, for the status line. */
export type ResidentYearState = "draft" | "published" | "collecting";

export function residentStateOf(status: YearStatus): ResidentYearState {
  if (status === "published") return "published";
  return status === "closed" ? "draft" : "collecting";
}

/** The kinds of line in a resident's history. */
export const RESIDENT_EVENT_ACTIONS = [
  "unlock",
  "relock",
  "withhold",
  "release",
  "manual_add",
  "manual_edit",
  "manual_remove",
  "manual_restore",
  "correction",
] as const;
export type ResidentEventAction = (typeof RESIDENT_EVENT_ACTIONS)[number];

export const RESIDENT_EVENT_LABEL: Record<ResidentEventAction, string> = {
  unlock: "Unlocked",
  relock: "Relocked",
  withhold: "Withheld",
  release: "Released",
  manual_add: "Manual entry added",
  manual_edit: "Manual entry edited",
  manual_remove: "Manual entry removed",
  manual_restore: "Manual entry restored",
  correction: "Correction",
};

export const SUMMARY_MAX = 200;

/** One short line for the history: "Roster: Soccer (MALE) role set to Captain". */
export function correctionSummary(
  area: string,
  subject: string,
  change: string,
): string {
  const text = `${area}: ${subject} ${change}`.replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_MAX
    ? `${text.slice(0, SUMMARY_MAX - 1)}…`
    : text;
}

/** "role set to Captain", "role cleared", "duration set to Sem 2": one phrase per field. */
export function fieldChange(field: string, value: string | null): string {
  return value === null || value === ""
    ? `${field} cleared`
    : `${field} set to ${value}`;
}

/** Several field phrases joined for one summary: "role set to X, contribution cleared". */
export function joinChanges(parts: readonly string[]): string {
  return parts.length === 0 ? "saved" : parts.join(", ");
}

/* ---- what a batch write changes, per resident ------------------------------ */

/** The shape of a participant diff (see `diffParticipants`), only what is read. */
export interface ParticipantChanges {
  add: ReadonlyArray<{ userID: string; role: string }>;
  restore: ReadonlyArray<{ userID: string }>;
  update: ReadonlyArray<{ userID: string }>;
  remove: ReadonlyArray<{ userID: string }>;
}

/** One history line per resident an activity's participant change touches. */
export function participantSummaries(
  area: string,
  title: string,
  diff: ParticipantChanges,
): Array<{ userID: string; summary: string }> {
  const line = (userID: string, change: string) => ({
    userID,
    summary: correctionSummary(area, title, change),
  });
  return [
    ...diff.add.map((d) =>
      line(d.userID, d.role ? `added as ${d.role}` : "added"),
    ),
    ...diff.restore.map((d) => line(d.userID, "participation restored")),
    ...diff.update.map((d) => line(d.userID, "role or description changed")),
    ...diff.remove.map((d) => line(d.userID, "participation removed")),
  ];
}
