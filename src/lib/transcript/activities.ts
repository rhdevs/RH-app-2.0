/**
 * CCA ACTIVITIES, as pure rules: limits, the participant diff, and the text a
 * transcript row shows. No database, no clock.
 */

export const ACTIVITY_TITLE_MAX = 80;
export const ACTIVITY_DESCRIPTION_MAX = 300;
export const PARTICIPANT_ROLE_MAX = 60;
export const PARTICIPANT_DESCRIPTION_MAX = 300;
/**
 * HIDDEN safety caps, far above real use and never shown on a screen: activities
 * per CCA and year, and participants in one save.
 */
export const MAX_ACTIVITIES = 1000;
export const MAX_PARTICIPANTS = 2000;

export const ACTIVITY_PERIODS = ["full", "sem1", "sem2"] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

export const isActivityPeriod = (v: unknown): v is ActivityPeriod =>
  typeof v === "string" && (ACTIVITY_PERIODS as readonly string[]).includes(v);

/** A stored period, read leniently: anything unknown or missing is the full year. */
export const readPeriod = (v: string | null | undefined): ActivityPeriod =>
  isActivityPeriod(v) ? v : "full";

export const PERIOD_LABEL: Record<ActivityPeriod, string> = {
  full: "Full year",
  sem1: "Semester 1",
  sem2: "Semester 2",
};

/** " (Sem 1)" / " (Sem 2)" after a title; nothing for the full year. */
export function periodSuffix(period: ActivityPeriod): string {
  return period === "sem1" ? " (Sem 1)" : period === "sem2" ? " (Sem 2)" : "";
}

const PERIOD_ORDER: Record<ActivityPeriod, number> = {
  full: 0,
  sem1: 1,
  sem2: 2,
};

/** Order for a transcript: full year, then semester 1, then semester 2, then by title. */
export function compareActivities(
  a: { period: ActivityPeriod; title: string },
  b: { period: ActivityPeriod; title: string },
): number {
  return (
    PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period] ||
    a.title.localeCompare(b.title, "en", { sensitivity: "base" })
  );
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * What a person's row says: their own description, else the activity's general
 * one, else nothing. A role left empty stays empty.
 */
export function participantText(
  activityDescription: string | null | undefined,
  participant: {
    role: string | null | undefined;
    description: string | null | undefined;
  },
): { role: string; description: string } {
  return {
    role: clean(participant.role) ?? "",
    description:
      clean(participant.description) ?? clean(activityDescription) ?? "",
  };
}

/* ---- participants.set ----------------------------------------------------- */

export interface ExistingParticipant {
  id: string;
  userID: string;
  role: string | null;
  description: string | null;
  removed: boolean;
}

export interface DesiredParticipant {
  userID: string;
  role: string;
  description: string;
}

export interface ParticipantDiff {
  /** People not on the activity yet. */
  add: DesiredParticipant[];
  /** People who were removed earlier and are back (a removed row is reused). */
  restore: Array<{ id: string } & DesiredParticipant>;
  /** People already active whose role or description changed. */
  update: Array<{ id: string } & DesiredParticipant>;
  /** Active people no longer in the list: soft-removed, never deleted. */
  remove: Array<{ id: string; userID: string }>;
  /** Active people left exactly as they were. */
  unchanged: number;
}

/**
 * The changes that turn the current participants into the wanted ones. The set
 * is REPLACED: new people are added, people missing from the list are removed
 * softly, and everyone else is updated only if their text changed. A person who
 * was removed before and is listed again gets their old row back, because a
 * person has one row per activity.
 */
export function diffParticipants(
  existing: readonly ExistingParticipant[],
  desired: readonly DesiredParticipant[],
): ParticipantDiff {
  const byUser = new Map(existing.map((e) => [e.userID, e]));
  const wanted = new Set(desired.map((d) => d.userID));
  const diff: ParticipantDiff = {
    add: [],
    restore: [],
    update: [],
    remove: [],
    unchanged: 0,
  };

  for (const d of desired) {
    const row = byUser.get(d.userID);
    if (!row) diff.add.push(d);
    else if (row.removed) diff.restore.push({ id: row.id, ...d });
    else if (
      (clean(row.role) ?? "") !== (clean(d.role) ?? "") ||
      (clean(row.description) ?? "") !== (clean(d.description) ?? "")
    ) {
      diff.update.push({ id: row.id, ...d });
    } else diff.unchanged += 1;
  }
  for (const e of existing) {
    if (!e.removed && !wanted.has(e.userID)) {
      diff.remove.push({ id: e.id, userID: e.userID });
    }
  }
  return diff;
}

/** Does the list name anyone twice? Returns the first repeated key, or null. */
export function firstDuplicate(userIDs: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of userIDs) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/* ---- wording -------------------------------------------------------------- */

/** "1 activity", "3 activities": a plain count, never "of N". */
export const activityCountLine = (active: number) =>
  `${active} ${active === 1 ? "activity" : "activities"}`;

export const REMOVE_ACTIVITY_CONFIRMATION =
  "This takes the activity off every participant's transcript. You can restore it later from Show removed.";
