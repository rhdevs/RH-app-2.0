"use client";

import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import { AWARD_CITATION_MAX, AWARD_NAME_MAX } from "~/lib/transcript/awards";
import { counterText } from "~/lib/transcript/headView";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "../../_components/Bits";

export interface CatalogueItem {
  id: string;
  name: string;
  defaultCitation: string;
  archived: boolean;
  archivedAt: Date | string | null;
  archivedByName: string | null;
  updatedByName: string | null;
  awardCount: number;
}

export interface CatalogueForm {
  name: string;
  defaultCitation: string;
}

export interface AwardCatalogueViewProps {
  items: CatalogueItem[];
  loading: boolean;
  loadError: string | null;
  showArchived: boolean;
  onShowArchived: (value: boolean) => void;
  draft: CatalogueForm;
  onDraft: (patch: Partial<CatalogueForm>) => void;
  onAdd: () => void;
  adding: boolean;
  addError: string | null;
  editing: (CatalogueForm & { id: string }) | null;
  onEdit: (item: CatalogueItem | null) => void;
  onEditChange: (patch: Partial<CatalogueForm>) => void;
  onSaveEdit: () => void;
  savingEdit: boolean;
  editError: string | null;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  busy: boolean;
  actionError: string | null;
}

/** The award catalogue: add, rename, archive and restore. Nothing is deleted. */
export function AwardCatalogueView(p: AwardCatalogueViewProps) {
  return (
    <div>
      <form
        className="mb-6 grid max-w-3xl gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (!p.adding && p.draft.name.trim() !== "") p.onAdd();
        }}
      >
        <div>
          <label htmlFor="catalogue-name" className={FIELD_LABEL}>
            Award name
          </label>
          <Input
            id="catalogue-name"
            value={p.draft.name}
            maxLength={AWARD_NAME_MAX}
            onChange={(e) => p.onDraft({ name: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(p.draft.name, AWARD_NAME_MAX)}
          </p>
        </div>
        <div>
          <label htmlFor="catalogue-citation" className={FIELD_LABEL}>
            Default citation (optional)
          </label>
          <Input
            id="catalogue-citation"
            value={p.draft.defaultCitation}
            maxLength={AWARD_CITATION_MAX}
            onChange={(e) => p.onDraft({ defaultCitation: e.target.value })}
          />
          <p className="mt-1 text-xs text-gray-500">
            {counterText(p.draft.defaultCitation, AWARD_CITATION_MAX)}
          </p>
        </div>
        <div className="sm:pt-5">
          <Button
            type="submit"
            disabled={p.adding || p.draft.name.trim() === ""}
          >
            {p.adding ? "Adding" : "Add award"}
          </Button>
        </div>
        <div className="sm:col-span-3">
          <ErrorLine message={p.addError} />
        </div>
      </form>

      <label className="mb-3 inline-flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={p.showArchived}
          onChange={(e) => p.onShowArchived(e.target.checked)}
        />
        Show archived
      </label>
      <ErrorLine message={p.loadError ?? p.actionError} />

      {p.loading ? (
        <div
          className="h-24 animate-pulse rounded-md bg-gray-100"
          aria-busy="true"
        />
      ) : p.items.length === 0 ? (
        <p className="text-sm text-gray-500">
          No awards in the catalogue yet. Add the first one above.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
          {p.items.map((item) => {
            const editing = p.editing?.id === item.id ? p.editing : null;
            return (
              <li key={item.id} className="px-3 py-3">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <p
                      className={`text-sm font-medium ${item.archived ? "text-gray-500" : "text-gray-900"}`}
                    >
                      {item.name}
                      {item.archived && (
                        <span className="ml-2 rounded border border-gray-300 px-1.5 py-0.5 text-xs font-normal text-gray-600">
                          Archived
                        </span>
                      )}
                    </p>
                    {item.defaultCitation && (
                      <p className="mt-0.5 text-xs italic text-gray-600">
                        {item.defaultCitation}
                      </p>
                    )}
                    <p className="mt-0.5 text-xs text-gray-500">
                      {item.awardCount}{" "}
                      {item.awardCount === 1 ? "award" : "awards"} given
                      {item.archived && item.archivedAt
                        ? ` · Archived${item.archivedByName ? ` by ${item.archivedByName}` : ""} on ${formatSgDate(item.archivedAt)}`
                        : ""}
                    </p>
                  </div>
                  {!editing && (
                    <div className="flex gap-2">
                      {!item.archived && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Edit ${item.name}`}
                          onClick={() => p.onEdit(item)}
                        >
                          Edit
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={p.busy}
                        aria-label={`${item.archived ? "Restore" : "Archive"} ${item.name}`}
                        onClick={() =>
                          item.archived
                            ? p.onRestore(item.id)
                            : p.onArchive(item.id)
                        }
                      >
                        {item.archived ? "Restore" : "Archive"}
                      </Button>
                    </div>
                  )}
                </div>
                {editing && (
                  <form
                    className="mt-3 grid gap-3 rounded-md border border-gray-200 p-3 sm:grid-cols-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!p.savingEdit && editing.name.trim() !== "") {
                        p.onSaveEdit();
                      }
                    }}
                  >
                    <div>
                      <label
                        htmlFor={`cat-name-${item.id}`}
                        className={FIELD_LABEL}
                      >
                        Name
                      </label>
                      <Input
                        id={`cat-name-${item.id}`}
                        value={editing.name}
                        maxLength={AWARD_NAME_MAX}
                        onChange={(e) =>
                          p.onEditChange({ name: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`cat-cit-${item.id}`}
                        className={FIELD_LABEL}
                      >
                        Default citation
                      </label>
                      <Input
                        id={`cat-cit-${item.id}`}
                        value={editing.defaultCitation}
                        maxLength={AWARD_CITATION_MAX}
                        onChange={(e) =>
                          p.onEditChange({ defaultCitation: e.target.value })
                        }
                      />
                    </div>
                    <p className="text-xs text-gray-500 sm:col-span-2">
                      Renaming does not change awards already given: each keeps
                      the name it was given.
                    </p>
                    <div className="sm:col-span-2">
                      <ErrorLine message={p.editError} />
                    </div>
                    <div className="flex gap-2 sm:col-span-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={p.savingEdit || editing.name.trim() === ""}
                      >
                        {p.savingEdit ? "Saving" : "Save"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={p.savingEdit}
                        onClick={() => p.onEdit(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const EMPTY: CatalogueForm = { name: "", defaultCitation: "" };

export default function AwardCatalogue({
  onDirty,
}: {
  onDirty: (dirty: boolean) => void;
}) {
  const utils = api.useUtils();
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<CatalogueForm>(EMPTY);
  const [editing, setEditing] = useState<
    (CatalogueForm & { id: string }) | null
  >(null);
  const [original, setOriginal] = useState<CatalogueForm | null>(null);

  const list = api.transcriptManage.awardTypes.list.useQuery(
    { includeArchived: showArchived },
    { retry: false },
  );
  const refresh = () => utils.transcriptManage.awardTypes.list.invalidate();

  const create = api.transcriptManage.awardTypes.create.useMutation({
    onSuccess: async () => {
      setDraft(EMPTY);
      await refresh();
    },
  });
  const update = api.transcriptManage.awardTypes.update.useMutation({
    onSuccess: async () => {
      setEditing(null);
      setOriginal(null);
      await Promise.all([
        refresh(),
        utils.transcriptManage.awards.list.invalidate(),
      ]);
    },
  });
  const archive = api.transcriptManage.awardTypes.archive.useMutation({
    onSuccess: refresh,
  });
  const restore = api.transcriptManage.awardTypes.restore.useMutation({
    onSuccess: refresh,
  });

  const dirty =
    draft.name.trim() !== "" ||
    draft.defaultCitation.trim() !== "" ||
    (editing !== null &&
      original !== null &&
      (editing.name.trim() !== original.name.trim() ||
        editing.defaultCitation.trim() !== original.defaultCitation.trim()));
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const createZod = create.error?.data?.zodError ?? null;
  const updateZod = update.error?.data?.zodError ?? null;
  const act = archive.error ?? restore.error;

  return (
    <AwardCatalogueView
      items={list.data ?? []}
      loading={list.isPending && list.fetchStatus !== "idle"}
      loadError={list.error ? errorText(list.error.message) : null}
      showArchived={showArchived}
      onShowArchived={setShowArchived}
      draft={draft}
      onDraft={(patch) => {
        create.reset();
        setDraft((d) => ({ ...d, ...patch }));
      }}
      onAdd={() =>
        create.mutate({
          name: draft.name,
          defaultCitation:
            draft.defaultCitation.trim() === "" ? null : draft.defaultCitation,
        })
      }
      adding={create.isPending}
      addError={
        create.error
          ? (fieldError(createZod, "name") ?? errorText(create.error.message))
          : null
      }
      editing={editing}
      onEdit={(item) => {
        update.reset();
        const form = item
          ? {
              id: item.id,
              name: item.name,
              defaultCitation: item.defaultCitation,
            }
          : null;
        setEditing(form);
        setOriginal(
          form
            ? { name: form.name, defaultCitation: form.defaultCitation }
            : null,
        );
      }}
      onEditChange={(patch) => {
        update.reset();
        setEditing((e) => (e ? { ...e, ...patch } : e));
      }}
      onSaveEdit={() =>
        editing &&
        update.mutate({
          id: editing.id,
          name: editing.name,
          defaultCitation:
            editing.defaultCitation.trim() === ""
              ? null
              : editing.defaultCitation,
        })
      }
      savingEdit={update.isPending}
      editError={
        update.error
          ? (fieldError(updateZod, "name") ?? errorText(update.error.message))
          : null
      }
      onArchive={(id) => archive.mutate({ id })}
      onRestore={(id) => restore.mutate({ id })}
      busy={archive.isPending || restore.isPending}
      actionError={act ? errorText(act.message) : null}
    />
  );
}
