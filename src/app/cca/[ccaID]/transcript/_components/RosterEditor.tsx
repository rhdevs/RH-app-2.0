"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { ErrorLine } from "~/app/admin/transcripts/_components/Bits";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import type { Duration } from "~/lib/transcript/duration";
import {
  EXTRA_MAX,
  ROLE_MAX,
  counterText,
  draftOf,
  durationOptions,
  effectiveMembership,
  KEPT_MEMBER_NOTE,
  roleDurationOptions,
  roleDurationValue,
  type DurationOption,
  isDirty,
  rowProblem,
  upsertFields,
  type DurationChoice,
  type RowDraft,
} from "~/lib/transcript/headView";
import {
  EMPTY_BATCH,
  applyEdit,
  beginSave,
  dirtyRows,
  discardAll,
  draftFor,
  filterRows,
  rowBlocker,
  saveAllFailureLine,
  saveFailed,
  saveSucceeded,
  unsavedCount,
  unsavedLine,
  type BatchState,
} from "~/lib/transcript/rosterBatch";
import {
  rosterLayoutFor,
  useContainerWidth,
  type RosterLayout,
} from "~/lib/transcript/useContainerWidth";
import { api } from "~/trpc/react";

export interface RosterRowData {
  userID: string;
  displayName: string | null;
  isHead: boolean;
  /** Left the CCA; kept on the list by a saved role or semester. */
  kept?: boolean;
  defaultDuration: Duration | null;
  duration: string | null;
  defaultRoleLabel: string | null;
  roleLabel: string | null;
  roleDuration: string | null;
  extraContribution: string | null;
}

export interface RosterRowViewProps {
  row: RosterRowData;
  draft: RowDraft;
  onDraft: (patch: Partial<RowDraft>) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  error: string | null;
  readOnly: boolean;
  /** Set when the role period was changed to fit a narrower membership. */
  roleNote?: string | null;
  /** Clear every override in the draft, back to the defaults (Save applies it). */
  onReset?: () => void;
}

/** A small text button under a field, for the clear and reset actions. */
const TEXT_BUTTON =
  "text-xs font-medium text-emerald-800 underline underline-offset-2 hover:text-emerald-900 disabled:opacity-50";

/** Does the draft hold any override at all? */
export const hasOverrides = (draft: RowDraft) =>
  draft.duration !== "" ||
  draft.roleLabel.trim() !== "" ||
  draft.roleDuration !== "" ||
  draft.extra.trim() !== "";

/**
 * Reset to default: only where there IS a default to go back to (a live list,
 * not a frozen one, whose entries hold the settled values) and something to clear.
 */
export const canReset = (row: RosterRowData, draft: RowDraft) =>
  row.defaultDuration !== null && hasOverrides(draft);

export const BLANK_ROW_DRAFT: RowDraft = {
  duration: "",
  roleLabel: "",
  roleDuration: "",
  extra: "",
};

function ClearButton({
  label,
  name,
  onClick,
}: {
  label: string;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={TEXT_BUTTON}
      aria-label={`${label} for ${name}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A real table header cell: not `block`, so the header row lines up with the columns. */
const TH_CELL = "px-3 py-2 text-left text-xs font-medium text-gray-700";

/** The Save column stays at the right edge while the table scrolls sideways. */
const STICKY_END =
  "sticky right-0 bg-white shadow-[-8px_0_8px_-8px_rgba(0,0,0,0.18)]";

const CARD_LABEL = "mb-1 block text-xs font-medium text-gray-700";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

function DurationSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: DurationChoice;
  options: DurationOption[];
  disabled: boolean;
  onChange: (v: DurationChoice) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as DurationChoice)}
        className={SELECT}
      >
        {options.map((o) => (
          <option key={o.value || "default"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One member's row. Presentational: the container owns the draft and the save. */
export function RosterRowView(p: RosterRowViewProps) {
  const { row, draft } = p;
  const key = row.userID;
  const name = row.displayName ?? row.userID;
  const saved = draftOf(row);
  const dirty = isDirty(draft, saved);
  const problem = rowProblem(draft);
  const hasRole =
    draft.roleLabel.trim() !== "" || row.defaultRoleLabel !== null;

  return (
    <>
      <tr className="align-top">
        <td className="px-3 py-3 text-sm font-medium text-gray-900">
          {name}
          {row.isHead && (
            <span className="ml-2 text-xs font-normal text-gray-500">Head</span>
          )}
          {row.kept && (
            <span className="mt-1 block text-xs font-normal text-gray-500">
              {KEPT_MEMBER_NOTE}
            </span>
          )}
        </td>
        <td className="min-w-[10rem] px-3 py-3">
          <DurationSelect
            id={`duration-${key}`}
            label={`Duration for ${name}`}
            value={draft.duration}
            options={durationOptions()}
            disabled={p.readOnly}
            onChange={(v) => p.onDraft({ duration: v })}
          />
        </td>
        <td className="min-w-[11rem] px-3 py-3">
          <label htmlFor={`role-${key}`} className="sr-only">
            {`Role for ${name}`}
          </label>
          <Input
            id={`role-${key}`}
            value={draft.roleLabel}
            maxLength={ROLE_MAX}
            disabled={p.readOnly}
            placeholder={
              row.defaultRoleLabel
                ? `Default: ${row.defaultRoleLabel}`
                : "Leave blank for member"
            }
            onChange={(e) => p.onDraft({ roleLabel: e.target.value })}
          />
          {!p.readOnly && draft.roleLabel.trim() !== "" && (
            <div className="mt-1">
              <ClearButton
                label="Clear role"
                name={name}
                onClick={() => p.onDraft({ roleLabel: "", roleDuration: "" })}
              />
            </div>
          )}
        </td>
        <td className="min-w-[10rem] px-3 py-3">
          {hasRole && (
            <DurationSelect
              id={`roleDuration-${key}`}
              label={`Role period for ${name}`}
              value={roleDurationValue(
                effectiveMembership(draft.duration),
                draft.roleDuration,
              )}
              options={roleDurationOptions(effectiveMembership(draft.duration))}
              disabled={p.readOnly}
              onChange={(v) => p.onDraft({ roleDuration: v })}
            />
          )}
        </td>
        <td className="min-w-[16rem] px-3 py-3">
          <label htmlFor={`extra-${key}`} className="sr-only">
            {`Additional contribution for ${name}`}
          </label>
          <Textarea
            id={`extra-${key}`}
            rows={2}
            value={draft.extra}
            maxLength={EXTRA_MAX}
            disabled={p.readOnly}
            onChange={(e) => p.onDraft({ extra: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(draft.extra, EXTRA_MAX)}
          </p>
          {!p.readOnly && draft.extra.trim() !== "" && (
            <div className="mt-1">
              <ClearButton
                label="Clear contribution"
                name={name}
                onClick={() => p.onDraft({ extra: "" })}
              />
            </div>
          )}
          <ErrorLine message={problem ?? p.error} />
        </td>
        <td className={`${STICKY_END} px-3 py-3`}>
          {!p.readOnly && (
            <div className="flex flex-col items-start gap-1">
              <Button
                type="button"
                size="sm"
                disabled={!dirty || p.saving || problem !== null}
                onClick={p.onSave}
              >
                {p.saving ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    Saving
                  </>
                ) : (
                  "Save"
                )}
              </Button>
              {p.saved && !dirty && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-emerald-700"
                  role="status"
                >
                  <Check className="h-3 w-3" />
                  Saved
                </span>
              )}
              {p.onReset && canReset(row, draft) && (
                <ClearButton
                  label="Reset to default"
                  name={name}
                  onClick={p.onReset}
                />
              )}
            </div>
          )}
        </td>
      </tr>
      {p.roleNote && (
        <tr>
          <td
            colSpan={6}
            className="px-3 pb-2 text-xs text-gray-600"
            role="status"
          >
            {p.roleNote}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One member as a card, for screens narrower than the md breakpoint. Same
 * props, same fields and same limits as the table row; the ids are prefixed so
 * the two never clash.
 */
export function RosterCardView(p: RosterRowViewProps) {
  const { row, draft } = p;
  const key = `m-${row.userID}`;
  const name = row.displayName ?? row.userID;
  const dirty = isDirty(draft, draftOf(row));
  const problem = rowProblem(draft);
  const hasRole =
    draft.roleLabel.trim() !== "" || row.defaultRoleLabel !== null;

  return (
    <li className="space-y-3 rounded-lg border border-gray-200 p-3">
      <p className="text-sm font-medium text-gray-900">
        {name}
        {row.isHead && (
          <span className="ml-2 text-xs font-normal text-gray-500">Head</span>
        )}
        {row.kept && (
          <span className="mt-1 block text-xs font-normal text-gray-500">
            {KEPT_MEMBER_NOTE}
          </span>
        )}
      </p>
      <div>
        <label htmlFor={`duration-${key}`} className={CARD_LABEL}>
          Duration
        </label>
        <select
          id={`duration-${key}`}
          value={draft.duration}
          disabled={p.readOnly}
          onChange={(e) =>
            p.onDraft({ duration: e.target.value as DurationChoice })
          }
          className={SELECT}
        >
          {durationOptions().map((o) => (
            <option key={o.value || "default"} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={`role-${key}`} className={CARD_LABEL}>
          Role
        </label>
        <Input
          id={`role-${key}`}
          value={draft.roleLabel}
          maxLength={ROLE_MAX}
          disabled={p.readOnly}
          placeholder={
            row.defaultRoleLabel
              ? `Default: ${row.defaultRoleLabel}`
              : "Leave blank for member"
          }
          onChange={(e) => p.onDraft({ roleLabel: e.target.value })}
        />
        {!p.readOnly && draft.roleLabel.trim() !== "" && (
          <div className="mt-1">
            <ClearButton
              label="Clear role"
              name={name}
              onClick={() => p.onDraft({ roleLabel: "", roleDuration: "" })}
            />
          </div>
        )}
      </div>
      {hasRole && (
        <div>
          <label htmlFor={`roleDuration-${key}`} className={CARD_LABEL}>
            Role period
          </label>
          <select
            id={`roleDuration-${key}`}
            value={roleDurationValue(
              effectiveMembership(draft.duration),
              draft.roleDuration,
            )}
            disabled={p.readOnly}
            onChange={(e) =>
              p.onDraft({ roleDuration: e.target.value as DurationChoice })
            }
            className={SELECT}
          >
            {roleDurationOptions(effectiveMembership(draft.duration)).map(
              (o) => (
                <option key={o.value || "default"} value={o.value}>
                  {o.label}
                </option>
              ),
            )}
          </select>
        </div>
      )}
      <div>
        <label htmlFor={`extra-${key}`} className={CARD_LABEL}>
          Additional contribution
        </label>
        <Textarea
          id={`extra-${key}`}
          rows={3}
          value={draft.extra}
          maxLength={EXTRA_MAX}
          disabled={p.readOnly}
          onChange={(e) => p.onDraft({ extra: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500">
          {counterText(draft.extra, EXTRA_MAX)}
        </p>
        {!p.readOnly && draft.extra.trim() !== "" && (
          <div className="mt-1">
            <ClearButton
              label="Clear contribution"
              name={name}
              onClick={() => p.onDraft({ extra: "" })}
            />
          </div>
        )}
      </div>
      {p.roleNote && (
        <p className="text-xs text-gray-600" role="status">
          {p.roleNote}
        </p>
      )}
      <ErrorLine message={problem ?? p.error} />
      {!p.readOnly && (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={!dirty || p.saving || problem !== null}
            onClick={p.onSave}
          >
            {p.saving ? (
              <>
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
          {p.saved && !dirty && (
            <span
              className="inline-flex items-center gap-1 text-xs text-emerald-700"
              role="status"
            >
              <Check className="h-3 w-3" />
              Saved
            </span>
          )}
          {p.onReset && canReset(row, draft) && (
            <ClearButton
              label="Reset to default"
              name={name}
              onClick={p.onReset}
            />
          )}
        </div>
      )}
    </li>
  );
}

export interface RosterTableViewProps {
  rows: React.ReactNode;
  count: number;
  /** The same members as cards, shown instead of the table. */
  cards?: React.ReactNode;
  /**
   * Which one to draw, decided from the container's width. Left out, both are
   * drawn and CSS picks by the window (cards below md).
   */
  layout?: RosterLayout;
}

export function RosterTableView({
  rows,
  count,
  cards,
  layout,
}: RosterTableViewProps) {
  if (count === 0) {
    return (
      <p className="text-sm text-gray-500">
        This CCA has no members to list yet.
      </p>
    );
  }
  return (
    <>
      {cards && layout !== "table" && (
        <ul className={`space-y-3 ${layout ? "" : "md:hidden"}`}>{cards}</ul>
      )}
      <div
        className={
          layout === "cards"
            ? "hidden"
            : cards && !layout
              ? "relative hidden overflow-x-auto md:block"
              : "relative overflow-x-auto"
        }
      >
        <table className="w-full min-w-[56rem] divide-y divide-gray-200 text-left">
          <thead>
            <tr>
              {[
                "Name",
                "Duration",
                "Role",
                "Role period",
                "Additional contribution",
                "",
              ].map((h, i) => (
                <th
                  key={h || `action-${i}`}
                  scope="col"
                  className={`${TH_CELL} ${i === 5 ? STICKY_END : ""}`}
                >
                  {h || <span className="sr-only">Save</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">{rows}</tbody>
        </table>
      </div>
    </>
  );
}

export interface SaveAllBarProps {
  count: number;
  busy: boolean;
  /** Set after a Save all in which some rows failed. */
  failureLine: string | null;
  onSaveAll: () => void;
  onDiscard: () => void;
  /** The save button's words; "Save all" for the roster. */
  saveLabel?: string;
}

/**
 * Sticky at the bottom of the roster while anything is unsaved: how many rows
 * changed, Save all (one row after another) and Discard. Per-row Save remains.
 */
export function SaveAllBar(p: SaveAllBarProps) {
  if (p.count === 0 && !p.failureLine) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className="sticky bottom-0 z-10 -mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-white px-6 py-3 shadow-[0_-2px_6px_rgba(0,0,0,0.06)]"
    >
      <div className="text-sm">
        {p.count > 0 && (
          <p className="font-medium text-gray-900" role="status">
            {unsavedLine(p.count)}
          </p>
        )}
        {p.failureLine && (
          <p className="text-red-700" role="alert">
            {p.failureLine}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={p.busy || p.count === 0}
          onClick={p.onDiscard}
        >
          Discard
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={p.busy || p.count === 0}
          onClick={p.onSaveAll}
        >
          {p.busy ? (
            <>
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              Saving
            </>
          ) : (
            (p.saveLabel ?? "Save all")
          )}
        </Button>
      </div>
    </div>
  );
}

const CONFIRM_DISCARD = "Discard all unsaved changes in the roster?";

/** The server's message for one failed row, field errors first. */
function rowErrorText(error: unknown): string {
  const e = error as {
    message?: string;
    data?: {
      zodError?: { fieldErrors?: Record<string, string[] | undefined> } | null;
    };
  };
  const zod = e.data?.zodError ?? null;
  return (
    fieldError(zod, "roleLabel") ??
    fieldError(zod, "extraContribution") ??
    errorText(e.message)
  );
}

/**
 * The roster: a name filter, the members as a table (md and up) or cards, and
 * the Save all bar. It holds the edits of EVERY row, so Save all, Discard and
 * the unsaved count see them all; the parent hears the count to guard leaving.
 */
export function RosterEditor({
  ccaID,
  academicYear,
  rows,
  readOnly,
  onUnsavedChange,
  empty,
}: {
  ccaID: number;
  academicYear: string;
  rows: RosterRowData[];
  readOnly: boolean;
  onUnsavedChange: (count: number) => void;
  empty?: ReactNode;
}) {
  const utils = api.useUtils();
  const [boxRef, width] = useContainerWidth<HTMLDivElement>();
  const layout = rosterLayoutFor(width);
  const [state, setState] = useState<BatchState>(EMPTY_BATCH);
  const [filter, setFilter] = useState("");
  const [failed, setFailed] = useState(0);
  const [busy, setBusy] = useState(false);
  // Save all reads the latest drafts between its awaits.
  const latest = useRef(state);
  latest.current = state;

  const upsert = api.transcriptManage.roster.upsert.useMutation();
  const count = unsavedCount(state, rows);
  useEffect(() => onUnsavedChange(count), [count, onUnsavedChange]);
  // Leaving the editor (another year) leaves nothing unsaved behind.
  useEffect(() => () => onUnsavedChange(0), [onUnsavedChange]);

  /** Save one row. Resolves to whether it was stored. */
  const saveRow = async (row: RosterRowData): Promise<boolean> => {
    const blocker = rowBlocker(latest.current, row);
    if (blocker) {
      setState((s) => saveFailed(s, row, blocker));
      return false;
    }
    const draft = draftFor(latest.current, row);
    setState((s) => beginSave(s, row));
    try {
      const stored = await upsert.mutateAsync({
        ccaID,
        academicYear,
        userID: row.userID,
        ...upsertFields(draft),
      });
      setState((s) => saveSucceeded(s, row, stored));
      return true;
    } catch (error) {
      setState((s) => saveFailed(s, row, rowErrorText(error)));
      return false;
    }
  };

  const saveOne = async (row: RosterRowData) => {
    setFailed(0);
    await saveRow(row);
    await utils.transcriptManage.roster.list.invalidate();
  };

  const saveAll = async () => {
    setBusy(true);
    setFailed(0);
    let failures = 0;
    for (const row of dirtyRows(latest.current, rows)) {
      if (!(await saveRow(row))) failures += 1;
    }
    setFailed(failures);
    setBusy(false);
    await utils.transcriptManage.roster.list.invalidate();
  };

  if (rows.length === 0) {
    return <RosterTableView count={0} rows={null} />;
  }
  const shown = filterRows(rows, filter);
  const viewProps = (row: RosterRowData): RosterRowViewProps => {
    const ui = state[row.userID];
    return {
      row,
      draft: draftFor(state, row),
      onDraft: (patch) => {
        setFailed(0);
        setState((s) => applyEdit(s, row, patch));
      },
      onSave: () => void saveOne(row),
      saving: ui?.saving ?? false,
      saved: ui?.saved ?? false,
      error: ui?.error ?? null,
      readOnly,
      roleNote: ui?.note ?? null,
      onReset: () => {
        setFailed(0);
        setState((s) => applyEdit(s, row, BLANK_ROW_DRAFT));
      },
    };
  };

  return (
    <div ref={boxRef}>
      <div className="mb-3 max-w-sm">
        <label htmlFor="roster-filter" className="sr-only">
          Filter members by name
        </label>
        <Input
          id="roster-filter"
          type="search"
          autoComplete="off"
          placeholder="Filter members by name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-gray-500">No member matches that name.</p>
      ) : (
        <RosterTableView
          count={shown.length}
          layout={layout}
          rows={shown.map((row) => (
            <RosterRowView
              key={`${academicYear}:${row.userID}`}
              {...viewProps(row)}
            />
          ))}
          cards={shown.map((row) => (
            <RosterCardView
              key={`${academicYear}:${row.userID}`}
              {...viewProps(row)}
            />
          ))}
        />
      )}
      {!readOnly && (
        <SaveAllBar
          count={count}
          busy={busy}
          failureLine={failed > 0 ? saveAllFailureLine(failed) : null}
          onSaveAll={() => void saveAll()}
          onDiscard={() => {
            if (window.confirm(CONFIRM_DISCARD)) {
              setFailed(0);
              setState(discardAll());
            }
          }}
        />
      )}
      {empty}
    </div>
  );
}
