import { GRID_PAGE_SIZE, personTotals, isValidHours } from "./volunteer";

/**
 * The attendance grid's state and operations. PURE: the grid draws it and makes
 * the calls. A cell is ticked when its key is present; its value is the hours
 * override (null = the session's own hours). Every operation returns a new
 * object and leaves the old one alone.
 */

export type Cells = Readonly<Record<string, number | null>>;

export interface GridSession {
  id: string;
  /** "2026-10-08" */
  date: string;
  hours: number;
}

export const cellKey = (sessionID: string, userID: string) =>
  `${sessionID}|${userID}`;

/** The cells the server returned (ticks on active sessions of active people). */
export function cellsOf(
  rows: ReadonlyArray<{
    sessionID: string;
    userID: string;
    hoursOverride: number | null;
  }>,
): Cells {
  return Object.fromEntries(
    rows.map((r) => [cellKey(r.sessionID, r.userID), r.hoursOverride]),
  );
}

export const isTicked = (cells: Cells, sessionID: string, userID: string) =>
  Object.prototype.hasOwnProperty.call(cells, cellKey(sessionID, userID));

export const overrideOf = (
  cells: Cells,
  sessionID: string,
  userID: string,
): number | null => cells[cellKey(sessionID, userID)] ?? null;

/** Click a cell: ticked becomes unticked (and loses its override), and back. */
export function toggleCell(
  cells: Cells,
  sessionID: string,
  userID: string,
): Cells {
  const key = cellKey(sessionID, userID);
  if (isTicked(cells, sessionID, userID)) {
    const { [key]: _gone, ...rest } = cells;
    return rest;
  }
  return { ...cells, [key]: null };
}

/** Tick every person in one session. Overrides already set are kept. */
export function tickColumn(
  cells: Cells,
  sessionID: string,
  userIDs: readonly string[],
): Cells {
  const next = { ...cells };
  for (const id of userIDs) {
    const key = cellKey(sessionID, id);
    if (!(key in next)) next[key] = null;
  }
  return next;
}

/** Clear every person's tick in one session. */
export function clearColumn(
  cells: Cells,
  sessionID: string,
  userIDs: readonly string[],
): Cells {
  const drop = new Set(userIDs.map((id) => cellKey(sessionID, id)));
  return Object.fromEntries(
    Object.entries(cells).filter(([k]) => !drop.has(k)),
  );
}

/** Tick one person in every session given. */
export function tickRow(
  cells: Cells,
  userID: string,
  sessionIDs: readonly string[],
): Cells {
  const next = { ...cells };
  for (const id of sessionIDs) {
    const key = cellKey(id, userID);
    if (!(key in next)) next[key] = null;
  }
  return next;
}

export function clearRow(
  cells: Cells,
  userID: string,
  sessionIDs: readonly string[],
): Cells {
  const drop = new Set(sessionIDs.map((id) => cellKey(id, userID)));
  return Object.fromEntries(
    Object.entries(cells).filter(([k]) => !drop.has(k)),
  );
}

/**
 * Make `toSessionID`'s ticks the same as `fromSessionID`'s, for the people
 * given. Who was ticked is copied; hours overrides are not.
 */
export function copyPrevious(
  cells: Cells,
  fromSessionID: string,
  toSessionID: string,
  userIDs: readonly string[],
): Cells {
  const next = { ...cells };
  for (const id of userIDs) {
    const to = cellKey(toSessionID, id);
    if (isTicked(cells, fromSessionID, id)) next[to] = null;
    else delete next[to];
  }
  return next;
}

/** Set (or clear, with null) the hours override of a ticked cell. Others are left alone. */
export function setOverride(
  cells: Cells,
  sessionID: string,
  userID: string,
  hours: number | null,
): Cells {
  if (!isTicked(cells, sessionID, userID)) return cells;
  if (hours !== null && !isValidHours(hours)) return cells;
  return { ...cells, [cellKey(sessionID, userID)]: hours };
}

/* ---- saving --------------------------------------------------------------- */

export interface AttendanceChange {
  sessionID: string;
  userID: string;
  attended: boolean;
  hoursOverride?: number | null;
}

/**
 * What to send to turn `saved` into `draft`: a tick, an un-tick, or a changed
 * override (null clears it). Cells that did not change are not mentioned.
 */
export function gridChanges(saved: Cells, draft: Cells): AttendanceChange[] {
  const out: AttendanceChange[] = [];
  const split = (key: string) => {
    const at = key.indexOf("|");
    return { sessionID: key.slice(0, at), userID: key.slice(at + 1) };
  };
  for (const key of Object.keys(draft)) {
    const was = key in saved;
    const now = draft[key] ?? null;
    if (!was) {
      out.push({ ...split(key), attended: true, hoursOverride: now });
    } else if ((saved[key] ?? null) !== now) {
      out.push({ ...split(key), attended: true, hoursOverride: now });
    }
  }
  for (const key of Object.keys(saved)) {
    if (!(key in draft)) out.push({ ...split(key), attended: false });
  }
  return out;
}

export const unsavedCells = (saved: Cells, draft: Cells): number =>
  gridChanges(saved, draft).length;

/* ---- totals ----------------------------------------------------------------- */

/** Each person's hours as the grid stands now (unsaved edits included). */
export function liveTotals(
  cells: Cells,
  sessions: readonly GridSession[],
  userIDs: readonly string[],
): Map<string, number> {
  return personTotals({
    sessions,
    people: userIDs,
    attendance: Object.entries(cells).map(([key, hoursOverride]) => {
      const at = key.indexOf("|");
      return {
        sessionID: key.slice(0, at),
        userID: key.slice(at + 1),
        hoursOverride,
      };
    }),
  });
}

/* ---- paging (desktop) ----------------------------------------------------------- */

export interface GridWindow {
  /** Index of the first session drawn. */
  start: number;
  /** One past the last session drawn. */
  end: number;
  hasEarlier: boolean;
  hasLater: boolean;
}

/** The sessions drawn: at most `size`, from `start` (default: the most recent ones). */
export function gridWindow(
  total: number,
  start: number | null,
  size: number = GRID_PAGE_SIZE,
): GridWindow {
  const lastStart = Math.max(0, total - size);
  const from = Math.min(Math.max(start ?? lastStart, 0), lastStart);
  const end = Math.min(total, from + size);
  return { start: from, end, hasEarlier: from > 0, hasLater: end < total };
}

/** The start after "Earlier sessions" / "Later sessions". */
export function pageStart(
  total: number,
  current: GridWindow,
  direction: "earlier" | "later",
  size: number = GRID_PAGE_SIZE,
): number {
  const next =
    direction === "earlier" ? current.start - size : current.start + size;
  return gridWindow(total, next, size).start;
}

/** The session before this one in date order, or null for the first. */
export function previousSession<T extends { id: string }>(
  sessions: readonly T[],
  sessionID: string,
): T | null {
  const i = sessions.findIndex((s) => s.id === sessionID);
  return i > 0 ? sessions[i - 1]! : null;
}

/* ---- phone view -------------------------------------------------------------------- */

/** Move to the previous or next session, never off either end. */
export function stepSession(
  total: number,
  index: number,
  direction: -1 | 1,
): number {
  if (total === 0) return 0;
  return Math.min(Math.max(index + direction, 0), total - 1);
}

/** Which session the phone view shows first: the most recent one. */
export const defaultPhoneIndex = (total: number) => Math.max(0, total - 1);

/* ---- wording ------------------------------------------------------------------------ */

export const windowLine = (w: GridWindow, total: number) =>
  total === 0
    ? "No sessions yet."
    : `Sessions ${w.start + 1} to ${w.end} of ${total}`;

/** Keep only ticks on the sessions and people still active (a removed one cannot be saved). */
export function restrictCells(
  cells: Cells,
  sessionIDs: readonly string[],
  userIDs: readonly string[],
): Cells {
  const live = new Set(
    sessionIDs.flatMap((s) => userIDs.map((u) => cellKey(s, u))),
  );
  return Object.fromEntries(
    Object.entries(cells).filter(([key]) => live.has(key)),
  );
}

/* ---- my edits, apart from what the server has ----------------------------- */

/** One cell I changed: ticked (with its override), or unticked. */
export type GridEdit = { attended: boolean; hoursOverride: number | null };
export type GridEdits = Readonly<Record<string, GridEdit>>;

/**
 * Only the cells where `next` differs from `live`: these are MY edits. Cells
 * somebody else ticked, which are in `live` and untouched by me, never appear.
 */
export function editsFrom(live: Cells, next: Cells): GridEdits {
  return Object.fromEntries(
    gridChanges(live, next).map((c) => [
      cellKey(c.sessionID, c.userID),
      { attended: c.attended, hoursOverride: c.hoursOverride ?? null },
    ]),
  );
}

/** What the grid shows: the server's cells with my edits laid over them. */
export function applyEdits(live: Cells, edits: GridEdits): Cells {
  const out: Record<string, number | null> = { ...live };
  for (const [key, e] of Object.entries(edits)) {
    if (e.attended) out[key] = e.hoursOverride;
    else delete out[key];
  }
  return out;
}

/**
 * Drop my edits for a session or person that is no longer in the grid (removed
 * meanwhile): the server would reject the whole save for them. Null when none
 * are left.
 */
export function restrictEdits(
  edits: GridEdits | null,
  sessionIDs: readonly string[],
  userIDs: readonly string[],
): GridEdits | null {
  if (!edits) return null;
  const live = new Set(
    sessionIDs.flatMap((s) => userIDs.map((u) => cellKey(s, u))),
  );
  const kept = Object.entries(edits).filter(([key]) => live.has(key));
  if (kept.length === Object.keys(edits).length) return edits;
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

/** What a save sends: my edits on cells that still exist, nothing else. */
export function changesToSave(
  saved: Cells,
  edits: GridEdits | null,
  sessionIDs: readonly string[],
  userIDs: readonly string[],
): AttendanceChange[] {
  const kept = restrictEdits(edits, sessionIDs, userIDs);
  return gridChanges(saved, kept ? applyEdits(saved, kept) : saved);
}

/**
 * After a save: drop the edits that were sent and are unchanged since; keep
 * any cell edited (or edited again) while the save was running. Null when
 * nothing is left.
 */
export function reconcileEdits(
  submitted: GridEdits,
  now: GridEdits | null,
): GridEdits | null {
  const left = Object.entries(now ?? {}).filter(([key, e]) => {
    const sent = submitted[key];
    return (
      !sent ||
      sent.attended !== e.attended ||
      sent.hoursOverride !== e.hoursOverride
    );
  });
  return left.length === 0 ? null : Object.fromEntries(left);
}
