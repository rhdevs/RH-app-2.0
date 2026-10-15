"use client";

import { useState } from "react";

import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { errorText } from "~/lib/transcript/adminView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL, SectionCard } from "./Bits";

export interface TaggedCca {
  ccaID: number;
  ccaName: string;
  category: string;
  isVolunteering: boolean;
}

/** The CCAs whose name or category contains `query` (case-insensitive). */
export function filterCcas(
  ccas: readonly TaggedCca[],
  query: string,
): TaggedCca[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...ccas];
  return ccas.filter(
    (c) =>
      c.ccaName.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q),
  );
}

export interface VolunteeringTagsViewProps {
  ccas: TaggedCca[];
  query: string;
  onQueryChange: (q: string) => void;
  /** The CCA whose switch is being saved, if any. */
  pendingID: number | null;
  /** A failed switch, shown beside that CCA; the switch shows the saved value. */
  error: { ccaID: number; message: string } | null;
  onToggle: (ccaID: number, next: boolean) => void;
  loadError: string | null;
}

/**
 * Section b: which CCAs count as volunteering CCAs. Heads of a tagged CCA can
 * record volunteer hours for any resident. The switch always shows what the
 * server holds: it changes after the save lands, and a failed save leaves it
 * where it was with the reason beside it.
 */
export function VolunteeringTagsView(p: VolunteeringTagsViewProps) {
  const shown = filterCcas(p.ccas, p.query);
  const tagged = p.ccas.filter((c) => c.isVolunteering).length;

  return (
    <SectionCard
      title="Volunteering CCAs"
      description="The heads of a CCA marked here can record volunteer hours for any resident. Changing this does not depend on the academic year."
    >
      <ErrorLine message={p.loadError} />
      <div className="max-w-sm">
        <label htmlFor="transcripts-cca-search" className={FIELD_LABEL}>
          Search CCAs
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
      <p className="mt-2 text-xs text-gray-500" aria-live="polite">
        {tagged} of {p.ccas.length} CCAs marked as volunteering.
      </p>

      {shown.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No CCAs match.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100 rounded-md border border-gray-200">
          {shown.map((cca) => {
            const id = `volunteering-${cca.ccaID}`;
            const failed =
              p.error?.ccaID === cca.ccaID ? p.error.message : null;
            return (
              <li key={cca.ccaID} className="px-3 py-2">
                <div className="flex items-center justify-between gap-4">
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block truncate text-sm font-medium text-gray-900">
                      {cca.ccaName}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {cca.category}
                    </span>
                  </label>
                  <span className="text-xs text-gray-500" aria-live="polite">
                    {p.pendingID === cca.ccaID
                      ? "Saving"
                      : cca.isVolunteering
                        ? "Volunteering"
                        : ""}
                  </span>
                  <Switch
                    id={id}
                    checked={cca.isVolunteering}
                    disabled={p.pendingID === cca.ccaID}
                    onCheckedChange={(next) => p.onToggle(cca.ccaID, next)}
                    aria-label={`${cca.ccaName} is a volunteering CCA`}
                  />
                </div>
                <ErrorLine message={failed} />
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

export default function VolunteeringTags() {
  const utils = api.useUtils();
  const list = api.transcriptManage.ccaTags.list.useQuery(undefined, {
    retry: false,
  });
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<{
    ccaID: number;
    message: string;
  } | null>(null);

  const save = api.transcriptManage.ccaTags.setVolunteering.useMutation({
    onSuccess: async () => {
      setFailure(null);
      await utils.transcriptManage.ccaTags.list.invalidate();
    },
    onError: (error, vars) =>
      setFailure({ ccaID: vars.ccaID, message: errorText(error.message) }),
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
      onToggle={(ccaID, next) => {
        setFailure(null);
        save.mutate({ ccaID, isVolunteering: next });
      }}
      loadError={list.error ? errorText(list.error.message) : null}
    />
  );
}
