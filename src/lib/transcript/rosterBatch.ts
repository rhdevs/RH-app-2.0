import {
  draftOf,
  fitRolePeriod,
  isDirty,
  reconcileAfterSave,
  rowProblem,
  type RowDraft,
} from "./headView";
import type { Duration } from "./duration";

/**
 * The roster editor's state for ALL rows at once, so "Save all", "Discard" and
 * the unsaved-changes count can see every edit. PURE: the editor draws it and
 * makes the calls. A row with no entry is untouched and shows what is saved.
 */

export interface SavedRow {
  userID: string;
  displayName: string | null;
  duration: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
  defaultDuration: Duration | null;
}

export interface RowUi {
  draft: RowDraft;
  /** What was sent, to tell whether more was typed while it was saving. */
  submitted: RowDraft | null;
  saving: boolean;
  saved: boolean;
  error: string | null;
  /** "Role period changed to ..." after a narrower membership. */
  note: string | null;
}

export type BatchState = Readonly<Record<string, RowUi>>;

export const EMPTY_BATCH: BatchState = {};

/** What a row shows now: the edit in progress, else what is saved. */
export const draftFor = (state: BatchState, row: SavedRow): RowDraft =>
  state[row.userID]?.draft ?? draftOf(row);

const entry = (state: BatchState, row: SavedRow): RowUi =>
  state[row.userID] ?? {
    draft: draftOf(row),
    submitted: null,
    saving: false,
    saved: false,
    error: null,
    note: null,
  };

const put = (state: BatchState, row: SavedRow, next: RowUi): BatchState => ({
  ...state,
  [row.userID]: next,
});

/** Edit one row. A narrower membership pulls a role period back inside it. */
export function applyEdit(
  state: BatchState,
  row: SavedRow,
  patch: Partial<RowDraft>,
): BatchState {
  const current = entry(state, row);
  const next = { ...current.draft, ...patch };
  const fitted =
    patch.duration !== undefined
      ? fitRolePeriod(next, row.defaultDuration)
      : { draft: next, note: null };
  return put(state, row, {
    ...current,
    draft: fitted.draft,
    note: fitted.note,
    saved: false,
    error: null,
  });
}

export const isRowDirty = (state: BatchState, row: SavedRow): boolean =>
  isDirty(draftFor(state, row), draftOf(row));

/** The rows with an unsaved change, in the order given. */
export const dirtyRows = <T extends SavedRow>(
  state: BatchState,
  rows: readonly T[],
): T[] => rows.filter((r) => isRowDirty(state, r));

export const unsavedCount = (
  state: BatchState,
  rows: readonly SavedRow[],
): number => dirtyRows(state, rows).length;

export function beginSave(state: BatchState, row: SavedRow): BatchState {
  const current = entry(state, row);
  return put(state, row, {
    ...current,
    submitted: current.draft,
    saving: true,
    error: null,
  });
}

/** The server stored the row: show what it stored, unless more was typed since. */
export function saveSucceeded(
  state: BatchState,
  row: SavedRow,
  stored: Omit<SavedRow, "userID" | "displayName" | "defaultDuration">,
): BatchState {
  const current = entry(state, row);
  const submitted = current.submitted ?? current.draft;
  return put(state, row, {
    ...current,
    draft: reconcileAfterSave(
      current.draft,
      submitted,
      draftOf(stored),
      (a, b) => !isDirty(a, b),
    ),
    submitted: null,
    saving: false,
    saved: true,
    error: null,
    note: null,
  });
}

export function saveFailed(
  state: BatchState,
  row: SavedRow,
  message: string,
): BatchState {
  return put(state, row, {
    ...entry(state, row),
    submitted: null,
    saving: false,
    saved: false,
    error: message,
  });
}

/** Throw away every unsaved edit. */
export const discardAll = (): BatchState => EMPTY_BATCH;

/** Can this row be sent? The text limits are checked before the server is. */
export const rowBlocker = (state: BatchState, row: SavedRow): string | null =>
  rowProblem(draftFor(state, row));

/* ---- the name filter ------------------------------------------------------ */

/** Rows whose name contains the filter, any case; everyone when it is blank. */
export function filterRows<
  T extends { userID: string; displayName: string | null },
>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) =>
    (r.displayName ?? r.userID).toLowerCase().includes(q),
  );
}

/* ---- wording -------------------------------------------------------------- */

export const unsavedLine = (count: number) =>
  `${count} unsaved ${count === 1 ? "change" : "changes"}`;

export const saveAllFailureLine = (failed: number) =>
  `${failed} ${failed === 1 ? "row" : "rows"} could not be saved. See the message on each.`;
