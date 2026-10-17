"use client";

import { useState } from "react";

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
import { errorText } from "~/lib/transcript/adminView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL, SectionCard } from "./Bits";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface TaggedCca {
  ccaID: number;
  ccaName: string;
  category: string;
  isVolunteering: boolean;
}

export const MIN_SUGGEST_CHARACTERS = 2;
const MAX_SUGGESTIONS = 8;

export const REMOVE_CONFIRMATION =
  "Its heads will no longer be able to record new hours. Hours already recorded stay on residents’ transcripts.";

/** "1 volunteering CCA", "4 volunteering CCAs". */
export const countLine = (n: number) =>
  `${n} volunteering ${n === 1 ? "CCA" : "CCAs"}`;

/** The CCAs that are volunteering CCAs, in the order given. */
export const taggedCcas = (ccas: readonly TaggedCca[]): TaggedCca[] =>
  ccas.filter((c) => c.isVolunteering);

/**
 * Untagged CCAs whose name or category contains `query` (case-insensitive), to
 * pick one to add. Nothing until the query has two characters; at most eight.
 */
export function suggestCcas(
  ccas: readonly TaggedCca[],
  query: string,
): TaggedCca[] {
  const q = query.trim().toLowerCase();
  if (q.length < MIN_SUGGEST_CHARACTERS) return [];
  return ccas
    .filter(
      (c) =>
        !c.isVolunteering &&
        (c.ccaName.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q)),
    )
    .slice(0, MAX_SUGGESTIONS);
}

export interface VolunteeringTagsViewProps {
  ccas: TaggedCca[];
  query: string;
  onQueryChange: (q: string) => void;
  /** The CCA being added or removed, if a save is in flight. */
  pendingID: number | null;
  /** A failed save, shown beside that CCA (or the search box when adding). */
  error: { ccaID: number; message: string } | null;
  onAdd: (ccaID: number) => void;
  /** The CCA whose Remove is awaiting confirmation. */
  confirmRemoveID: number | null;
  onConfirmRemove: (ccaID: number | null) => void;
  onRemove: () => void;
  loadError: string | null;
}

/**
 * Section b: the volunteering CCAs. Only tagged CCAs are listed; one is added
 * by searching for it. Heads of a listed CCA can record volunteer hours for any
 * resident. Removing asks first, and says what stays.
 */
export function VolunteeringTagsView(p: VolunteeringTagsViewProps) {
  const returnFocus = useReturnFocus();
  const tagged = taggedCcas(p.ccas);
  const suggestions = suggestCcas(p.ccas, p.query);
  const asked = p.query.trim().length >= MIN_SUGGEST_CHARACTERS;
  const removing = p.ccas.find((c) => c.ccaID === p.confirmRemoveID) ?? null;
  const addError =
    p.error && !tagged.some((c) => c.ccaID === p.error!.ccaID)
      ? p.error.message
      : null;

  return (
    <AlertDialog
      open={removing !== null}
      onOpenChange={(o) =>
        !o && p.pendingID === null && p.onConfirmRemove(null)
      }
    >
      <SectionCard
        title="Volunteering CCAs"
        description="The heads of a CCA listed here can record volunteer hours for any resident. This does not depend on the academic year."
      >
        <ErrorLine message={p.loadError} />

        <div className="max-w-sm">
          <label htmlFor="transcripts-cca-search" className={FIELD_LABEL}>
            Add a volunteering CCA
          </label>
          <Input
            id="transcripts-cca-search"
            type="search"
            value={p.query}
            onChange={(e) => p.onQueryChange(e.target.value)}
            placeholder="CCA name or category"
            autoComplete="off"
          />
        </div>
        <div className="mt-1 text-xs text-gray-500" aria-live="polite">
          {!asked &&
            `Type at least ${MIN_SUGGEST_CHARACTERS} characters to search.`}
          {asked && suggestions.length === 0 && "No CCAs to add match."}
        </div>
        <ErrorLine message={addError} />
        {suggestions.length > 0 && (
          <ul className="mt-2 max-w-sm divide-y divide-gray-100 rounded-md border border-gray-200">
            {suggestions.map((cca) => (
              <li key={cca.ccaID}>
                <button
                  type="button"
                  disabled={p.pendingID === cca.ccaID}
                  onClick={() => p.onAdd(cca.ccaID)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none disabled:opacity-50"
                >
                  <span>
                    <span className="block font-medium text-gray-900">
                      {cca.ccaName}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {cca.category}
                    </span>
                  </span>
                  <span className="text-xs font-medium text-emerald-800">
                    {p.pendingID === cca.ccaID ? "Adding" : "Add"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <p
          className="mt-5 text-sm font-medium text-gray-900"
          aria-live="polite"
        >
          {countLine(tagged.length)}
        </p>

        {tagged.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">
            No volunteering CCAs yet.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-gray-100 rounded-md border border-gray-200">
            {tagged.map((cca) => {
              const failed =
                p.error?.ccaID === cca.ccaID ? p.error.message : null;
              return (
                <li key={cca.ccaID} className="px-3 py-2">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-gray-900">
                        {cca.ccaName}
                      </span>
                      <span className="block text-xs text-gray-500">
                        {cca.category}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={p.pendingID === cca.ccaID}
                      onClick={() => p.onConfirmRemove(cca.ccaID)}
                      aria-label={`Remove ${cca.ccaName}`}
                    >
                      {p.pendingID === cca.ccaID ? "Removing" : "Remove"}
                    </Button>
                  </div>
                  <ErrorLine message={failed} />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {removing ? `Remove ${removing.ccaName}?` : "Remove this CCA?"}
          </AlertDialogTitle>
          <AlertDialogDescription>{REMOVE_CONFIRMATION}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.pendingID !== null}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={p.onRemove}
            disabled={p.pendingID !== null}
          >
            Remove
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function VolunteeringTags() {
  const utils = api.useUtils();
  const list = api.transcriptManage.ccaTags.list.useQuery(undefined, {
    retry: false,
  });
  const [query, setQuery] = useState("");
  const [confirmRemoveID, setConfirmRemoveID] = useState<number | null>(null);
  const [failure, setFailure] = useState<{
    ccaID: number;
    message: string;
  } | null>(null);

  const save = api.transcriptManage.ccaTags.setVolunteering.useMutation({
    onSuccess: async (_saved, vars) => {
      setFailure(null);
      setConfirmRemoveID(null);
      if (vars.isVolunteering) setQuery("");
      await utils.transcriptManage.ccaTags.list.invalidate();
    },
    onError: (error, vars) => {
      setConfirmRemoveID(null);
      setFailure({ ccaID: vars.ccaID, message: errorText(error.message) });
    },
  });

  if (list.isPending) {
    return (
      <div
        className="h-48 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }

  return (
    <VolunteeringTagsView
      ccas={list.data ?? []}
      query={query}
      onQueryChange={setQuery}
      pendingID={save.isPending ? (save.variables?.ccaID ?? null) : null}
      error={failure}
      onAdd={(ccaID) => {
        setFailure(null);
        save.mutate({ ccaID, isVolunteering: true });
      }}
      confirmRemoveID={confirmRemoveID}
      onConfirmRemove={(id) => {
        setFailure(null);
        setConfirmRemoveID(id);
      }}
      onRemove={() => {
        if (confirmRemoveID === null) return;
        save.mutate({ ccaID: confirmRemoveID, isVolunteering: false });
      }}
      loadError={list.error ? errorText(list.error.message) : null}
    />
  );
}
