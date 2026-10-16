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
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isDraftRow(v: unknown): v is DraftRow {
  if (!isRecord(v)) return false;
  const score = v.basePoints;
  return (
    (score === null || (typeof score === "number" && Number.isFinite(score))) &&
    typeof v.semesterOnly === "boolean" &&
    ROLES.includes(v.outgoingRole as PointsRole) &&
    ROLES.includes(v.incomingRole as PointsRole)
  );
}

/** A saved draft for this CCA, or null when it is missing, corrupt or not ours. */
export function parseDraft(raw: string | null, ccaID: number): Draft | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.version !== DRAFT_VERSION) return null;
  if (data.ccaID !== ccaID || typeof data.savedAt !== "string") return null;
  if (!isRecord(data.rows)) return null;
  const rows = Object.values(data.rows);
  if (!rows.every(isDraftRow)) return null;
  return data as Draft;
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
