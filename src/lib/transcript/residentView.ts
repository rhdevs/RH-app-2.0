import {
  RESIDENT_EVENT_LABEL,
  type ResidentEventAction,
  type ResidentYearState,
} from "./corrections";
import type { YearStatus } from "./lifecycle";

/**
 * WORDS AND SMALL RULES for the per-resident corrections screen, apart from the
 * components so they are unit-tested. Nothing here decides who may write: the
 * server does. These only decide what to draw and what to say.
 */

/** The facts the screen needs about one resident's year (from the panel query). */
export interface PanelFacts {
  status: YearStatus;
  state: ResidentYearState;
  withheld: boolean;
  unlocked: boolean;
}

export const STATE_LABEL: Record<ResidentYearState, string> = {
  collecting: "Collecting",
  published: "Published",
};

/** The status line: the year's state, then "Withheld" when a hold is on. */
export function statusLine(p: PanelFacts): string {
  const state = STATE_LABEL[p.state];
  return p.withheld ? `${state}, withheld from the resident` : state;
}

/**
 * May the screen offer edits? Open years: yes. A published year: only for an
 * unlocked resident. (The server re-checks every write.)
 */
export function canEditResident(p: PanelFacts): boolean {
  return p.status !== "published" || p.unlocked;
}

export const PUBLISHED_READONLY_NOTE =
  "Published. Unlock this resident to make corrections.";

/** Why the sections are read-only, or null when they are editable. */
export function readOnlyNote(p: PanelFacts): string | null {
  return canEditResident(p) ? null : PUBLISHED_READONLY_NOTE;
}

/** Unlock needs the year to be open. */
export const canUnlock = (p: PanelFacts) =>
  p.status === "published" && !p.unlocked;

export const UNLOCK_DIALOG = {
  title: "Unlock this resident?",
  description:
    "You will be able to correct this resident's records in this published year, and only theirs. Every change is logged with your name. Relock when you are done.",
  reasonLabel: "Reason (required)",
  confirm: "Unlock",
} as const;

export const RELOCK_DIALOG = {
  title: "Relock this resident?",
  description: "Their records become read-only again.",
  reasonLabel: "Note (optional)",
  confirm: "Relock",
} as const;

export const WITHHOLD_DIALOG = {
  title: "Withhold this transcript?",
  description:
    'The resident will see "Your transcript is on hold. Contact the hall office." instead of their transcript, and will not get a Ready notice. You can still preview it.',
  reasonLabel: "Reason (required)",
  confirm: "Withhold",
} as const;

export const RELEASE_DIALOG = {
  title: "Release this transcript?",
  description: "The resident sees their transcript again.",
  reasonLabel: "Note (optional)",
  confirm: "Release",
} as const;

/** The history tab's heading for one event. */
export function eventLabel(action: string): string {
  return RESIDENT_EVENT_LABEL[action as ResidentEventAction] ?? action;
}

/** The detail under the label: the reason, else the summary, else nothing. */
export function eventDetail(event: {
  reason: string | null;
  summary: string | null;
}): string | null {
  const parts = [event.reason, event.summary].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

export const SECTION_TABS = [
  { value: "memberships", label: "CCA memberships" },
  { value: "activities", label: "Activities" },
  { value: "volunteer", label: "Volunteer hours" },
  { value: "awards", label: "Awards" },
  { value: "jcrc", label: "JCRC page" },
  { value: "history", label: "History" },
] as const;
export type SectionTab = (typeof SECTION_TABS)[number]["value"];

export const NO_RESIDENT_NOTE = "Choose a resident to see their year.";

export const MANUAL_TAG = "Manual";
export const MANUAL_SHADOWED_NOTE =
  "This resident is also in the membership data for this CCA, so the membership data is used and this entry is ignored.";
export const ADMIN_ONLY_NOTE =
  'The "Manual" tag is shown here only. It never appears on the transcript.';

/* ---- volunteer cells of one resident ---------------------------------------- */

export interface SavedCell {
  sessionID: string;
  hours: number;
  ticked: boolean;
  hoursOverride: number | null;
}

/** What is typed in a cell: ticked or not, and the override as text. */
export interface CellDraft {
  ticked: boolean;
  override: string;
}

export const draftOfCell = (c: SavedCell): CellDraft => ({
  ticked: c.ticked,
  override: c.ticked && c.hoursOverride !== null ? String(c.hoursOverride) : "",
});

/** "" = no override; otherwise quarter hours from 0.25 to 24. */
export function parseOverride(
  text: string,
): { ok: true; value: number | null } | { ok: false; reason: string } {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n))
    return { ok: false, reason: "Enter hours as a number." };
  if (n < 0.25) return { ok: false, reason: "Hours must be at least 0.25." };
  if (n > 24) return { ok: false, reason: "Hours must be at most 24." };
  if (!Number.isInteger(n * 4)) {
    return { ok: false, reason: "Hours go up in steps of 0.25." };
  }
  return { ok: true, value: n };
}

export interface AttendanceChange {
  sessionID: string;
  userID: string;
  attended: boolean;
  hoursOverride?: number | null;
}

/**
 * The attendance.save changes that turn the saved cells into the drafts, for
 * ONE resident: a tick, an untick, or a changed override. Nothing for a cell
 * left as it was. A bad override is reported instead of guessed at.
 */
export function cellChanges(
  saved: readonly SavedCell[],
  draft: Readonly<Record<string, CellDraft>>,
  userID: string,
): { changes: AttendanceChange[]; error: string | null } {
  const changes: AttendanceChange[] = [];
  for (const cell of saved) {
    const d = draft[cell.sessionID] ?? draftOfCell(cell);
    if (!d.ticked) {
      if (cell.ticked) {
        changes.push({ sessionID: cell.sessionID, userID, attended: false });
      }
      continue;
    }
    const parsed = parseOverride(d.override);
    if (!parsed.ok) return { changes: [], error: parsed.reason };
    if (!cell.ticked || parsed.value !== cell.hoursOverride) {
      changes.push({
        sessionID: cell.sessionID,
        userID,
        attended: true,
        hoursOverride: parsed.value,
      });
    }
  }
  return { changes, error: null };
}

/** Hours for the drafts as typed (a bad override counts as none). */
export function draftTotal(
  saved: readonly SavedCell[],
  draft: Readonly<Record<string, CellDraft>>,
): number {
  let total = 0;
  for (const cell of saved) {
    const d = draft[cell.sessionID] ?? draftOfCell(cell);
    if (!d.ticked) continue;
    const parsed = parseOverride(d.override);
    total += (parsed.ok ? parsed.value : null) ?? cell.hours;
  }
  return Math.round(total * 100) / 100;
}

/** The small tag on a history line the resident made themself. */
export const SELF_MADE_TAG = "Self-made change";
