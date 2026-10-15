import { useCallback, useEffect } from "react";

export const DISCARD_CHANGES_QUESTION =
  "You have unsaved changes. Leave without saving them?";

/**
 * The decision, apart from the browser: nothing to lose means go ahead;
 * otherwise ask, and only an explicit yes goes ahead.
 */
export function mayLeave(isDirty: boolean, ask: () => boolean): boolean {
  return isDirty ? ask() : true;
}

/**
 * Guards unsaved edits.
 *  - While `isDirty`, closing or reloading the tab shows the browser's own
 *    "leave site?" prompt (beforeunload).
 *  - The returned `confirmLeave()` is for changes made INSIDE the app (switching
 *    the year or a tab, closing an editor): it asks once and returns whether to
 *    go ahead. When nothing is dirty it returns true without asking.
 */
export function useUnsavedChangesGuard(isDirty: boolean): () => boolean {
  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers only prompt when returnValue is set.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  return useCallback(
    () => mayLeave(isDirty, () => window.confirm(DISCARD_CHANGES_QUESTION)),
    [isDirty],
  );
}
