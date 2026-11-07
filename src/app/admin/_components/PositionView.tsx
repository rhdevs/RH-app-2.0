"use client";

import { useEffect, useState } from "react";

import { api } from "~/trpc/react";

/**
 * The "My positions / All CCAs" switch on JCRC lists.
 *
 * VIEWS ONLY. It filters what a list shows by default; it never hides an action
 * and the server never reads it. A member who holds no position, or an
 * oversees-all one, gets scope "all" and the switch is not shown: nothing
 * changes for anyone until positions are set up.
 *
 * The chosen view is remembered per page in localStorage, a per-viewer
 * convenience only, so every read and write is wrapped: a blocked store just
 * means the list opens on "My positions" again.
 */

export type PositionView = "mine" | "all";

const STORAGE_PREFIX = "rhapp.positionView.";

function readStored(page: string): PositionView | null {
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + page);
    return v === "mine" || v === "all" ? v : null;
  } catch {
    return null;
  }
}

function writeStored(page: string, view: PositionView) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + page, view);
  } catch {
    // A per-viewer convenience: nothing to do when storage is unavailable.
  }
}

export type PositionScopeState = {
  /** Whether the caller has a real scope, i.e. the switch is worth showing. */
  hasScope: boolean;
  view: PositionView;
  setView: (view: PositionView) => void;
  /** Whether a CCA is shown in the current view. */
  shows: (ccaID: number) => boolean;
  /** The caller's CCAs, empty when they see every CCA. */
  myCcaIDs: readonly number[];
};

/**
 * The caller's position scope for one page. A failed or pending read shows
 * every CCA: the filter must never be the reason something is missing.
 */
export function usePositionScope(page: string): PositionScopeState {
  const mine = api.jcrcPositions.mine.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const [view, setViewState] = useState<PositionView>("mine");

  useEffect(() => {
    const stored = readStored(page);
    if (stored) setViewState(stored);
  }, [page]);

  const scope = mine.data?.scope;
  const myCcaIDs = Array.isArray(scope) ? scope : [];
  const hasScope = Array.isArray(scope);

  const setView = (next: PositionView) => {
    setViewState(next);
    writeStored(page, next);
  };

  const shows = (ccaID: number) =>
    !hasScope || view === "all" || myCcaIDs.includes(ccaID);

  return { hasScope, view, setView, shows, myCcaIDs };
}

/** The switch itself. Renders nothing for a caller without a scope. */
export function PositionViewToggle({
  state,
  hiddenCount,
}: {
  state: PositionScopeState;
  /** How many items "My positions" is hiding, shown as a hint. */
  hiddenCount?: number;
}) {
  if (!state.hasScope) return null;
  const options: { value: PositionView; label: string }[] = [
    { value: "mine", label: "My positions" },
    { value: "all", label: "All CCAs" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Which CCAs to show"
        className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5"
      >
        {options.map((o) => {
          const active = state.view === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => state.setView(o.value)}
              className={`rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                active
                  ? "bg-white font-medium text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {state.view === "mine" &&
        hiddenCount !== undefined &&
        hiddenCount > 0 && (
          <span className="text-xs text-gray-500">
            {hiddenCount} other CCA{hiddenCount === 1 ? "" : "s"} hidden
          </span>
        )}
    </div>
  );
}
