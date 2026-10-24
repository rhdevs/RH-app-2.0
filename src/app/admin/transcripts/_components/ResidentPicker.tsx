"use client";

import { useEffect, useState, type KeyboardEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { errorText } from "~/lib/transcript/adminView";
import {
  COMBO_CLOSED,
  comboReduce,
  listboxId,
  optionId,
  type ComboKey,
  type ComboState,
} from "~/lib/transcript/combobox";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "./Bits";

export interface PickedResident {
  userID: string;
  displayName: string | null;
  /** First character and last three only. */
  maskedMatric: string | null;
}

export const MIN_SEARCH_CHARACTERS = 3;
export const DEFAULT_PLACEHOLDER = "Name, email or matric";
export const HEAD_PLACEHOLDER = "Name";
/** Open, nothing active: the state a list shows in when first drawn. */
const OPEN: ComboState = { open: true, active: -1 };
const DEBOUNCE_MS = 300;

export type PickerStatus = "short" | "loading" | "error" | "empty" | "results";

/**
 * Pick a resident by name, email or matric. Residents are found through
 * transcriptManage.residents.search (managers and heads of volunteering CCAs,
 * at most 10 hits). Only a masked matric is shown, on the search results, and
 * nowhere else on these screens.
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
  hideSelectedMatric,
  placeholder = DEFAULT_PLACEHOLDER,
  combo = OPEN,
  onKeyDown,
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
  hideSelectedMatric?: boolean;
  /** "Name, email or matric" for a manager, "Name" for a head. */
  placeholder?: string;
  /** Whether the list is open and which option is active. */
  combo?: ComboState;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  if (selected) {
    return (
      <div>
        <p className={FIELD_LABEL}>{label}</p>
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-900">
          <span className="font-medium">
            {selected.displayName ?? selected.userID}
          </span>
          {selected.maskedMatric && !hideSelectedMatric && (
            <span className="text-gray-500">{selected.maskedMatric}</span>
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
  const showList = status === "results" && combo.open && hits.length > 0;
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
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        maxLength={60}
        className="max-w-sm"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listboxId(idPrefix)}
        aria-activedescendant={
          showList && combo.active >= 0
            ? optionId(idPrefix, combo.active)
            : undefined
        }
      />
      <div aria-live="polite" className="mt-1 text-xs text-gray-500">
        {status === "short" &&
          `Type at least ${MIN_SEARCH_CHARACTERS} characters to search.`}
        {status === "loading" && "Searching."}
        {status === "empty" && "No residents match."}
        {showList &&
          `${hits.length} ${hits.length === 1 ? "result" : "results"}. Use the up and down arrow keys, then Enter.`}
      </div>
      <ErrorLine message={status === "error" ? error : null} />
      {showList && (
        <ul
          id={listboxId(idPrefix)}
          role="listbox"
          aria-label={label}
          className="mt-2 max-w-sm divide-y divide-gray-100 rounded-md border border-gray-200"
        >
          {hits.map((hit, index) => (
            <li
              key={hit.userID}
              id={optionId(idPrefix, index)}
              role="option"
              aria-selected={index === combo.active}
              // The input keeps focus, so a click must not blur it first.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(hit)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-gray-50 ${
                index === combo.active ? "bg-emerald-50" : ""
              }`}
            >
              <span className="font-medium text-gray-900">
                {hit.displayName ?? hit.userID}
              </span>
              <span className="text-xs text-gray-500">
                {hit.maskedMatric ?? ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const KEYS: Record<string, ComboKey | undefined> = {
  ArrowDown: "ArrowDown",
  ArrowUp: "ArrowUp",
  Home: "Home",
  End: "End",
  Enter: "Enter",
  Escape: "Escape",
};

export default function ResidentPicker({
  idPrefix,
  label = "Resident",
  selected,
  onSelect,
  onClear,
  disabled,
  hideSelectedMatric,
  placeholder,
}: {
  idPrefix: string;
  label?: string;
  selected: PickedResident | null;
  onSelect: (r: PickedResident) => void;
  onClear: () => void;
  disabled?: boolean;
  hideSelectedMatric?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [combo, setCombo] = useState<ComboState>(COMBO_CLOSED);
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
      onQueryChange={(q) => {
        setQuery(q);
        setCombo(comboReduce(combo, "Type", 0).state);
      }}
      status={status}
      hits={search.data ?? []}
      placeholder={placeholder}
      combo={combo}
      onKeyDown={(event) => {
        const key = KEYS[event.key];
        if (!key) return;
        const hitsNow = status === "results" ? (search.data ?? []) : [];
        const result = comboReduce(combo, key, hitsNow.length);
        if (result.prevent) event.preventDefault();
        setCombo(result.state);
        const picked = result.pick === null ? undefined : hitsNow[result.pick];
        if (picked) {
          onSelect(picked);
          setQuery("");
          setDebounced("");
        }
      }}
      error={search.error ? errorText(search.error.message) : null}
      selected={selected}
      onSelect={(r) => {
        onSelect(r);
        setQuery("");
        setDebounced("");
      }}
      onClear={onClear}
      disabled={disabled}
      hideSelectedMatric={hideSelectedMatric}
    />
  );
}
