import type { PointsEntry, PointsRole } from "~/lib/points/entries";

/**
 * A leader's unfinished scores, kept ONLY in their own browser's localStorage.
 * Never sent anywhere. It stores the editable fields keyed by rowKey and nothing
 * else — no matric, no name — so the roster (from the server) stays the single
 * source of who is on the list.
 */

export const DRAFT_VERSION = 1;

export type DraftRow = {
  basePoints: number | null;
  semesterOnly: boolean;
  outgoingRole: PointsRole;
  incomingRole: PointsRole;
  ihg: boolean;
};

export type Draft = {
  version: 1;
  ccaID: number;
  savedAt: string;
  rows: Record<string, DraftRow>;
};

/** One roster entry as cca.memberDirectory describes it. */
export type RosterMember = {
  rowKey: string;
  matric: string | null;
  name: string | null;
  resolved: boolean;
  role: "Head" | "Member";
};

const ROLES: readonly PointsRole[] = ["none", "head", "vice_head"];

export function draftKey(ccaID: number, userID: string): string {
  return `rhapp.ccaPoints.draft.v1:${ccaID}:${userID}`;
}

/**
 * The starting values for a member with nothing saved. The app holds no
 * head/vice-head data, so a current Head is prefilled as an outgoing head and
 * everyone else as no role; the leader changes any of these.
 */
export function prefillEntry(member: RosterMember): PointsEntry {
  return {
    rowKey: member.rowKey,
    matric: member.matric,
    name: member.name,
    resolved: member.resolved,
    basePoints: null,
    semesterOnly: false,
    outgoingRole: member.role === "Head" ? "head" : "none",
    incomingRole: "none",
    ihg: false,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored row; one saved before the IHG tick existed has no `ihg`. */
type StoredDraftRow = Omit<DraftRow, "ihg"> & { ihg?: boolean };

function isDraftRow(v: unknown): v is StoredDraftRow {
  if (!isRecord(v)) return false;
  const score = v.basePoints;
  return (
    (score === null || (typeof score === "number" && Number.isFinite(score))) &&
    typeof v.semesterOnly === "boolean" &&
    ROLES.includes(v.outgoingRole as PointsRole) &&
    ROLES.includes(v.incomingRole as PointsRole) &&
    // A row saved before the IHG tick existed has no ihg: read it as false.
    (v.ihg === undefined || typeof v.ihg === "boolean")
  );
}

/**
 * What reading the stored draft found. "unreadable" is kept apart from "none" so
 * the page never overwrites something it could not understand.
 */
export type ParsedDraft =
  | { status: "ok"; draft: Draft }
  | { status: "none" }
  | { status: "unreadable" };

const UNREADABLE: ParsedDraft = { status: "unreadable" };

/** Nothing stored → none; a draft for this CCA → ok; anything else → unreadable. */
export function parseDraft(raw: string | null, ccaID: number): ParsedDraft {
  if (raw === null) return { status: "none" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  if (!isRecord(data) || data.version !== DRAFT_VERSION) return UNREADABLE;
  if (data.ccaID !== ccaID || typeof data.savedAt !== "string")
    return UNREADABLE;
  if (Number.isNaN(Date.parse(data.savedAt))) return UNREADABLE;
  if (!isRecord(data.rows)) return UNREADABLE;
  // Rebuild every row from the five editable fields only, so a stored row can
  // never carry a matric, name or key that competes with the roster's.
  const rows: Record<string, DraftRow> = {};
  for (const [key, value] of Object.entries(data.rows)) {
    if (!isDraftRow(value)) return UNREADABLE;
    rows[key] = {
      basePoints: value.basePoints,
      semesterOnly: value.semesterOnly,
      outgoingRole: value.outgoingRole,
      incomingRole: value.incomingRole,
      ihg: value.ihg === true,
    };
  }
  return {
    status: "ok",
    draft: { version: DRAFT_VERSION, ccaID, savedAt: data.savedAt, rows },
  };
}

export function buildDraft(
  ccaID: number,
  entries: readonly PointsEntry[],
  savedAt: Date,
): Draft {
  const rows: Record<string, DraftRow> = {};
  for (const e of entries) {
    rows[e.rowKey] = {
      basePoints:
        e.basePoints !== null && Number.isFinite(e.basePoints)
          ? e.basePoints
          : null,
      semesterOnly: e.semesterOnly,
      outgoingRole: e.outgoingRole,
      incomingRole: e.incomingRole,
      ihg: e.ihg,
    };
  }
  return {
    version: DRAFT_VERSION,
    ccaID,
    savedAt: savedAt.toISOString(),
    rows,
  };
}

/**
 * Today's roster with any saved values laid back on top. Members still on the
 * roster keep their draft values; new members start from the prefill; saved rows
 * for people no longer on the roster are dropped and counted.
 */
export function mergeDraftWithRoster(
  roster: readonly RosterMember[],
  draft: Draft | null,
): { entries: PointsEntry[]; droppedCount: number } {
  const keys = new Set(roster.map((m) => m.rowKey));
  const entries = roster.map((member) => {
    const saved = draft?.rows[member.rowKey];
    return saved ? { ...prefillEntry(member), ...saved } : prefillEntry(member);
  });
  const droppedCount = draft
    ? Object.keys(draft.rows).filter((k) => !keys.has(k)).length
    : 0;
  return { entries, droppedCount };
}

/**
 * Read and judge the stored draft. A getItem that throws means a draft may be there
 * but cannot be read, so it is "unreadable" (autosave pauses), never "none".
 */
export function readDraftItem(
  storage: Pick<Storage, "getItem">,
  key: string,
  ccaID: number,
): ParsedDraft {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "unreadable" };
  }
  return parseDraft(raw, ccaID);
}

/**
 * A changed roster laid over what is on screen NOW (not over the stored draft, which
 * lags by the autosave delay). Members still present keep their current values;
 * new members start from the prefill; anyone gone is dropped and counted. Identity
 * (matric, name, resolved) always comes from the fresh roster.
 */
export function mergeRosterOverEntries(
  roster: readonly RosterMember[],
  current: readonly PointsEntry[],
): { entries: PointsEntry[]; droppedCount: number } {
  const byKey = new Map(current.map((e) => [e.rowKey, e]));
  const keys = new Set(roster.map((m) => m.rowKey));
  const entries = roster.map((member) => {
    const now = byKey.get(member.rowKey);
    if (!now) return prefillEntry(member);
    return {
      ...prefillEntry(member),
      basePoints: now.basePoints,
      semesterOnly: now.semesterOnly,
      outgoingRole: now.outgoingRole,
      incomingRole: now.incomingRole,
      ihg: now.ihg,
    };
  });
  const droppedCount = current.filter((e) => !keys.has(e.rowKey)).length;
  return { entries, droppedCount };
}

/**
 * Whether the draft may be written now: only after an edit, only with a storage
 * key, and never while the stored draft is unreadable (writing would destroy it).
 */
export function canAutosave(state: {
  storageKey: string | null;
  touched: boolean;
  unreadable: boolean;
}): boolean {
  return state.storageKey !== null && state.touched && !state.unreadable;
}

/** Remove a stored draft. False when the browser refused, so the caller can say so. */
export function removeDraftItem(
  storage: Pick<Storage, "removeItem">,
  key: string,
): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** A draft saved before "Start new points year" last ran belongs to the old year. */
export function isDraftFromBeforeYear(
  savedAt: string,
  yearStartedAt: string | null,
): boolean {
  if (yearStartedAt === null) return false;
  return Date.parse(savedAt) < Date.parse(yearStartedAt);
}

/**
 * Like readDraftItem, but a draft from before the current points year is removed
 * and reported as none, so last year's scores and ticks never refill the page.
 */
export function readCurrentDraftItem(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  ccaID: number,
  yearStartedAt: string | null,
): ParsedDraft {
  const parsed = readDraftItem(storage, key, ccaID);
  if (
    parsed.status === "ok" &&
    isDraftFromBeforeYear(parsed.draft.savedAt, yearStartedAt)
  ) {
    removeDraftItem(storage, key);
    return { status: "none" };
  }
  return parsed;
}
