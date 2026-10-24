"use client";

import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  bulkRestoreStoppedLine,
  errorText,
  fieldError,
} from "~/lib/transcript/adminView";
import {
  AWARD_CITATION_MAX,
  AWARD_NAME_MAX,
  EMPTY_SELECTION,
  REMOVE_AWARDS_CONFIRMATION,
  groupByAward,
  groupLine,
  selectionAfterRestore,
  pruneSelection,
  selectionSplit,
  toggleMany,
  toggleSelected,
  type Selection,
  SELF_RECORDED_TAG,
} from "~/lib/transcript/awards";
import { counterText } from "~/lib/transcript/headView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine } from "../../_components/Bits";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface AwardItem {
  id: string;
  userID: string;
  displayName: string | null;
  title: string;
  citation: string;
  awardTypeID: string | null;
  removed: boolean;
  /** The manager recorded or edited their own award. */
  selfRecorded?: boolean;
  recordedByName: string | null;
  recordedAt: Date | string | null;
  updatedByName: string | null;
  removedByName: string | null;
  removedAt: Date | string | null;
}

export interface AwardEdit {
  id: string;
  title: string;
  citation: string;
}

export interface AwardConfirm {
  kind: "remove" | "restore";
  ids: string[];
}

export interface AwardsListViewProps {
  items: AwardItem[];
  loading: boolean;
  loadError: string | null;
  groupBy: boolean;
  onGroupBy: (value: boolean) => void;
  showRemoved: boolean;
  onShowRemoved: (value: boolean) => void;
  search: string;
  onSearch: (value: string) => void;
  readOnly: boolean;
  selection: Selection;
  onToggle: (id: string) => void;
  onToggleMany: (ids: string[]) => void;
  /** Group keys that are open. */
  expanded: ReadonlySet<string>;
  onExpand: (key: string) => void;
  editing: AwardEdit | null;
  onEdit: (item: AwardItem | null) => void;
  onEditChange: (patch: Partial<AwardEdit>) => void;
  onSaveEdit: () => void;
  savingEdit: boolean;
  editError: string | null;
  titleError: string | null;
  onRemove: (id: string) => void;
  onRestore: (id: string) => void;
  confirm: AwardConfirm | null;
  onConfirm: (confirm: AwardConfirm | null) => void;
  onConfirmed: () => void;
  busy: boolean;
  actionError: string | null;
  /** A line about what a bulk restore skipped. */
  notice: string | null;
}

const when = (d: Date | string | null) => (d ? formatSgDate(d) : "");

/** The awards of one year: search, group by award, inline edit, selection. */
export function AwardsListView(p: AwardsListViewProps) {
  const returnFocus = useReturnFocus();
  const groups = p.groupBy ? groupByAward(p.items) : null;
  const split = selectionSplit(p.selection, p.items);
  const picked = p.selection.size;

  return (
    <AlertDialog
      open={p.confirm !== null}
      onOpenChange={(o) => !o && !p.busy && p.onConfirm(null)}
    >
      <div>
        <div className="mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
          <div className="min-w-[12rem] max-w-sm flex-1">
            <label
              htmlFor="awards-search"
              className="mb-1 block text-xs font-medium text-gray-700"
            >
              Search awards or residents
            </label>
            <Input
              id="awards-search"
              type="search"
              autoComplete="off"
              value={p.search}
              maxLength={60}
              onChange={(e) => p.onSearch(e.target.value)}
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={p.groupBy}
              onChange={(e) => p.onGroupBy(e.target.checked)}
            />
            Group by award
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={p.showRemoved}
              onChange={(e) => p.onShowRemoved(e.target.checked)}
            />
            Show removed
          </label>
        </div>

        {!p.readOnly && picked > 0 && (
          <div
            role="region"
            aria-label="Selected awards"
            className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
          >
            <p className="text-sm font-medium text-gray-900" role="status">
              {picked} selected
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={split.removable.length === 0 || p.busy}
              onClick={() =>
                p.onConfirm({ kind: "remove", ids: split.removable })
              }
            >
              Remove selected
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={split.restorable.length === 0 || p.busy}
              onClick={() =>
                p.onConfirm({ kind: "restore", ids: split.restorable })
              }
            >
              Restore selected
            </Button>
          </div>
        )}

        <ErrorLine message={p.loadError ?? p.actionError} />
        {p.notice && (
          <p className="mb-2 text-sm text-gray-700" role="status">
            {p.notice}
          </p>
        )}

        {p.loading ? (
          <div
            className="h-24 animate-pulse rounded-md bg-gray-100"
            aria-busy="true"
          />
        ) : p.items.length === 0 ? (
          <p className="text-sm text-gray-500">
            {p.search.trim() !== ""
              ? "No awards match that search."
              : "No awards for this year yet."}
          </p>
        ) : groups ? (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {groups.map((g) => {
              const open = p.expanded.has(g.key) || p.search.trim() !== "";
              const ids = g.items.map((i) => i.id);
              const allPicked = ids.every((id) => p.selection.has(id));
              return (
                <li key={g.key}>
                  <div className="flex items-center gap-3 bg-gray-50 px-3 py-2">
                    {!p.readOnly && (
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        aria-label={`Select every ${g.title} award`}
                        checked={allPicked}
                        onChange={() => p.onToggleMany(ids)}
                      />
                    )}
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => p.onExpand(g.key)}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium text-gray-900"
                    >
                      {open ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      <span className="min-w-0 break-words">
                        {groupLine(g.title, g.activeCount)}
                      </span>
                    </button>
                  </div>
                  {open && (
                    <ul className="divide-y divide-gray-100">
                      {g.items.map((item) => (
                        <AwardRow key={item.id} item={item} view={p} grouped />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {p.items.map((item) => (
              <AwardRow key={item.id} item={item} view={p} grouped={false} />
            ))}
          </ul>
        )}
      </div>

      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {p.confirm?.kind === "restore"
              ? "Restore selected awards?"
              : "Remove selected awards?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {p.confirm?.kind === "restore"
              ? "These awards go back on the transcripts. Any that the person already has again are skipped."
              : REMOVE_AWARDS_CONFIRMATION(p.confirm?.ids.length ?? 0)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={p.actionError} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.busy}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={p.busy} onClick={p.onConfirmed}>
            {p.busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Working
              </>
            ) : p.confirm?.kind === "restore" ? (
              "Restore"
            ) : (
              "Remove"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AwardRow({
  item,
  view,
  grouped,
}: {
  item: AwardItem;
  view: AwardsListViewProps;
  grouped: boolean;
}) {
  const editing = view.editing?.id === item.id ? view.editing : null;
  const name = item.displayName ?? item.userID;
  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {!view.readOnly && (
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            aria-label={`Select ${name}, ${item.title}`}
            checked={view.selection.has(item.id)}
            onChange={() => view.onToggle(item.id)}
          />
        )}
        <div className="min-w-0 flex-1 basis-48">
          <p
            className={`text-sm font-medium ${item.removed ? "text-gray-500 line-through" : "text-gray-900"}`}
          >
            {name}
            {!grouped && (
              <span className="ml-2 font-normal text-gray-700">
                {item.title}
              </span>
            )}
          </p>
          {!editing && item.citation && (
            <p className="mt-0.5 text-xs italic text-gray-600">
              {item.citation}
            </p>
          )}
          {item.selfRecorded && (
            <span className="mt-0.5 inline-block rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
              {SELF_RECORDED_TAG}
            </span>
          )}
          <p className="mt-0.5 text-xs text-gray-500">
            {item.removed
              ? `Removed${item.removedByName ? ` by ${item.removedByName}` : ""}${item.removedAt ? ` on ${when(item.removedAt)}` : ""}`
              : `Recorded${item.recordedByName ? ` by ${item.recordedByName}` : ""}${item.recordedAt ? ` on ${when(item.recordedAt)}` : ""}${item.updatedByName ? `, edited by ${item.updatedByName}` : ""}`}
          </p>
        </div>
        {!view.readOnly && !editing && (
          <div className="flex gap-2">
            {item.removed ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={view.busy}
                aria-label={`Restore ${name}, ${item.title}`}
                onClick={() => view.onRestore(item.id)}
              >
                Restore
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Edit ${name}, ${item.title}`}
                  onClick={() => view.onEdit(item)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={view.busy}
                  aria-label={`Remove ${name}, ${item.title}`}
                  onClick={() => view.onRemove(item.id)}
                >
                  Remove
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {editing && (
        <form
          className="mt-3 space-y-3 rounded-md border border-gray-200 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!view.savingEdit && editing.title.trim() !== "") {
              view.onSaveEdit();
            }
          }}
        >
          <div>
            <label
              htmlFor={`edit-title-${item.id}`}
              className="mb-1 block text-xs font-medium text-gray-700"
            >
              Award
            </label>
            <Input
              id={`edit-title-${item.id}`}
              value={editing.title}
              maxLength={AWARD_NAME_MAX}
              onChange={(e) => view.onEditChange({ title: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-500">
              {counterText(editing.title, AWARD_NAME_MAX)}
            </p>
            <ErrorLine message={view.titleError} />
          </div>
          <div>
            <label
              htmlFor={`edit-citation-${item.id}`}
              className="mb-1 block text-xs font-medium text-gray-700"
            >
              Citation (optional)
            </label>
            <Input
              id={`edit-citation-${item.id}`}
              value={editing.citation}
              maxLength={AWARD_CITATION_MAX}
              onChange={(e) => view.onEditChange({ citation: e.target.value })}
            />
            <p className="mt-1 text-xs text-gray-500">
              {counterText(editing.citation, AWARD_CITATION_MAX)}
            </p>
          </div>
          <ErrorLine message={view.editError} />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={view.savingEdit || editing.title.trim() === ""}
            >
              {view.savingEdit ? "Saving" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={view.savingEdit}
              onClick={() => view.onEdit(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

/**
 * Wires the list to the awards procedures. `onDirty` tells the page when an
 * edit is half-typed, so changing the year can ask first.
 */
export default function AwardsList({
  academicYear,
  readOnly,
  onDirty,
}: {
  academicYear: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const utils = api.useUtils();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [groupBy, setGroupBy] = useState(true);
  const [showRemoved, setShowRemoved] = useState(false);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<AwardEdit | null>(null);
  const [original, setOriginal] = useState<AwardEdit | null>(null);
  const [confirm, setConfirm] = useState<AwardConfirm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = api.transcriptManage.awards.list.useQuery(
    {
      academicYear,
      includeRemoved: showRemoved,
      ...(debounced === "" ? {} : { search: debounced }),
    },
    { enabled: academicYear !== "", retry: false },
  );
  const items: AwardItem[] = list.data ?? [];

  // Selected awards that are no longer listed (filter, reload) drop out.
  const visibleKey = items.map((i) => i.id).join(",");
  useEffect(() => {
    setSelection((s) => pruneSelection(s, visibleKey.split(",")));
  }, [visibleKey]);

  const dirty =
    editing !== null &&
    original !== null &&
    (editing.title.trim() !== original.title.trim() ||
      editing.citation.trim() !== original.citation.trim());
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  useEffect(() => () => onDirtyRef.current(false), []);

  const refresh = async () => {
    await Promise.all([
      utils.transcriptManage.awards.list.invalidate(),
      utils.transcriptManage.awardTypes.list.invalidate(),
      utils.transcriptManage.awardBatches.list.invalidate(),
    ]);
  };
  const update = api.transcriptManage.awards.update.useMutation({
    onSuccess: async () => {
      setEditing(null);
      setOriginal(null);
      await refresh();
    },
  });
  const remove = api.transcriptManage.awards.remove.useMutation({
    onSuccess: refresh,
  });
  const restore = api.transcriptManage.awards.restore.useMutation({
    onSuccess: refresh,
  });
  const bulkRemove = api.transcriptManage.awards.bulkRemove.useMutation({
    onSuccess: async () => {
      setConfirm(null);
      setSelection(EMPTY_SELECTION);
      await refresh();
    },
  });
  const bulkRestore = api.transcriptManage.awards.bulkRestore.useMutation({
    onSuccess: async (result, variables) => {
      setConfirm(null);
      setSelection(
        selectionAfterRestore(
          variables.ids,
          result.restoredIDs,
          result.stopped !== null,
        ),
      );
      const line =
        result.skipped.length > 0
          ? `${result.restored} restored. Skipped (already have it): ${result.skipped.join(", ")}.`
          : `${result.restored} restored.`;
      setNotice(
        result.stopped
          ? `${line} ${bulkRestoreStoppedLine(result.restored, result.stopped)}`
          : line,
      );
      await refresh();
    },
  });

  const zod = update.error?.data?.zodError ?? null;
  const titleError = fieldError(zod, "title");
  const error =
    remove.error ?? restore.error ?? bulkRemove.error ?? bulkRestore.error;

  return (
    <AwardsListView
      items={items}
      loading={list.isPending && list.fetchStatus !== "idle"}
      loadError={list.error ? errorText(list.error.message) : null}
      groupBy={groupBy}
      onGroupBy={setGroupBy}
      showRemoved={showRemoved}
      onShowRemoved={setShowRemoved}
      search={search}
      onSearch={setSearch}
      readOnly={readOnly}
      selection={selection}
      onToggle={(id) => setSelection((s) => toggleSelected(s, id))}
      onToggleMany={(ids) => setSelection((s) => toggleMany(s, ids))}
      expanded={expanded}
      onExpand={(key) =>
        setExpanded((cur) => {
          const next = new Set(cur);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        })
      }
      editing={editing}
      onEdit={(item) => {
        update.reset();
        const e = item
          ? { id: item.id, title: item.title, citation: item.citation }
          : null;
        setEditing(e);
        setOriginal(e);
      }}
      onEditChange={(patch) => {
        update.reset();
        setEditing((e) => (e ? { ...e, ...patch } : e));
      }}
      onSaveEdit={() =>
        editing &&
        update.mutate({
          id: editing.id,
          title: editing.title,
          citation: editing.citation.trim() === "" ? null : editing.citation,
        })
      }
      savingEdit={update.isPending}
      editError={
        update.error && !titleError ? errorText(update.error.message) : null
      }
      titleError={titleError}
      onRemove={(id) => {
        setNotice(null);
        remove.mutate({ id });
      }}
      onRestore={(id) => {
        setNotice(null);
        restore.mutate({ id });
      }}
      confirm={confirm}
      onConfirm={(c) => {
        bulkRemove.reset();
        bulkRestore.reset();
        setConfirm(c);
      }}
      onConfirmed={() => {
        if (!confirm) return;
        if (confirm.kind === "remove") bulkRemove.mutate({ ids: confirm.ids });
        else bulkRestore.mutate({ ids: confirm.ids });
      }}
      busy={
        remove.isPending ||
        restore.isPending ||
        bulkRemove.isPending ||
        bulkRestore.isPending
      }
      actionError={error ? errorText(error.message) : null}
      notice={notice}
    />
  );
}
