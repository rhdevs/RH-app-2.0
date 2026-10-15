"use client";

import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { errorText } from "~/lib/transcript/adminView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "./Bits";

export interface PickedResident {
  userID: string;
  displayName: string | null;
  matric: string | null;
}

export const MIN_SEARCH_CHARACTERS = 3;
const DEBOUNCE_MS = 300;

export type PickerStatus = "short" | "loading" | "error" | "empty" | "results";

/**
 * Pick a resident by name, email or matric. Residents are found through
 * transcriptManage.residents.search (manager-only, at most 10 hits). The matric
 * is shown in full here, on the search results a manager is authorised to see,
 * and nowhere else on these screens.
 */
export function ResidentPickerView({
  idPrefix,
  label,
  query,
  onQueryChange,
  status,
  hits,
  error,
  selected,
  onSelect,
  onClear,
  disabled,
}: {
  idPrefix: string;
  label: string;
  query: string;
  onQueryChange: (q: string) => void;
  status: PickerStatus;
  hits: PickedResident[];
  error: string | null;
  selected: PickedResident | null;
  onSelect: (r: PickedResident) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  if (selected) {
    return (
      <div>
        <p className={FIELD_LABEL}>{label}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-900">
          <span className="font-medium">
            {selected.displayName ?? selected.userID}
          </span>
          {selected.matric && (
            <span className="text-gray-500">{selected.matric}</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClear}
            disabled={disabled}
          >
            Change
          </Button>
        </div>
      </div>
    );
  }

  const inputId = `${idPrefix}-search`;
  return (
    <div>
      <label htmlFor={inputId} className={FIELD_LABEL}>
        {label}
      </label>
      <Input
        id={inputId}
        type="search"
        autoComplete="off"
        value={query}
        disabled={disabled}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Name, email or matric"
        maxLength={60}
        className="max-w-sm"
      />
      <div aria-live="polite" className="mt-1 text-xs text-gray-500">
        {status === "short" &&
          `Type at least ${MIN_SEARCH_CHARACTERS} characters to search.`}
        {status === "loading" && "Searching."}
        {status === "empty" && "No residents match."}
      </div>
      <ErrorLine message={status === "error" ? error : null} />
      {status === "results" && (
        <ul className="mt-2 max-w-sm divide-y divide-gray-100 rounded-md border border-gray-200">
          {hits.map((hit) => (
            <li key={hit.userID}>
              <button
                type="button"
                onClick={() => onSelect(hit)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none"
              >
                <span className="font-medium text-gray-900">
                  {hit.displayName ?? hit.userID}
                </span>
                <span className="text-xs text-gray-500">
                  {hit.matric ?? ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ResidentPicker({
  idPrefix,
  label = "Resident",
  selected,
  onSelect,
  onClear,
  disabled,
}: {
  idPrefix: string;
  label?: string;
  selected: PickedResident | null;
  onSelect: (r: PickedResident) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const long = debounced.length >= MIN_SEARCH_CHARACTERS;
  const search = api.transcriptManage.residents.search.useQuery(
    { query: debounced },
    { enabled: long && !selected, retry: false },
  );

  const status: PickerStatus = !long
    ? "short"
    : search.isPending || search.isFetching
      ? "loading"
      : search.error
        ? "error"
        : (search.data?.length ?? 0) === 0
          ? "empty"
          : "results";

  return (
    <ResidentPickerView
      idPrefix={idPrefix}
      label={label}
      query={query}
      onQueryChange={setQuery}
      status={status}
      hits={search.data ?? []}
      error={search.error ? errorText(search.error.message) : null}
      selected={selected}
      onSelect={(r) => {
        onSelect(r);
        setQuery("");
        setDebounced("");
      }}
      onClear={onClear}
      disabled={disabled}
    />
  );
}
