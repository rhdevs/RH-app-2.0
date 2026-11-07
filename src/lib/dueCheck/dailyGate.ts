import { sgtDayKey } from "~/lib/time/sgt";

/** The `sessionStorage` key holding the Singapore day the check last fired. */
export const DUE_CHECK_STORAGE_KEY = "rhapp.dueCheck.day";

/** The part of `Storage` the gate needs, so a test can hand in a fake. */
export type DayStorage = Pick<Storage, "getItem" | "setItem">;

/** What one page load remembers when it cannot rely on storage. */
export type DueCheckMemory = { day: string | null; fallbackFired: boolean };

export const newDueCheckMemory = (): DueCheckMemory => ({
  day: null,
  fallbackFired: false,
});

/** The page's own memory, shared by every bell on the page. */
const pageMemory = newDueCheckMemory();

/** `window.sessionStorage`, or null where touching it throws (blocked, private). */
export function browserSessionStorage(): DayStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Decide whether the bell should fire the due check now, and remember that it
 * did. True at most once per browser session (tab) per Singapore day:
 *
 *  - the day is `sgtDayKey(now)`, so it rolls over at 16:00 UTC, Singapore
 *    midnight;
 *  - it is remembered in `sessionStorage`; a second bell, a re-render or React's
 *    double effect on the same page finds the page's own memory first;
 *  - if storage is missing or any read or write throws, it falls back to once
 *    per page load, which is safe because the server's unique keys stop
 *    duplicates anyway.
 *
 * The decision is made BEFORE the request, so a failed request is not retried
 * until the next session or day (the failure is silent and logged).
 */
export function claimDueCheck(
  now: Date,
  storage: DayStorage | null = browserSessionStorage(),
  memory: DueCheckMemory = pageMemory,
): boolean {
  const day = sgtDayKey(now);
  if (memory.day === day) return false;

  if (storage !== null) {
    try {
      if (storage.getItem(DUE_CHECK_STORAGE_KEY) === day) {
        memory.day = day;
        return false;
      }
      storage.setItem(DUE_CHECK_STORAGE_KEY, day);
      memory.day = day;
      return true;
    } catch {
      // Fall through to once per page load.
    }
  }
  if (memory.fallbackFired) return false;
  memory.fallbackFired = true;
  memory.day = day;
  return true;
}

/** The part of `document` the watcher needs, so a test can hand in a fake. */
export type VisibilityDoc = {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", fn: () => void) => void;
  removeEventListener: (type: "visibilitychange", fn: () => void) => void;
};

/**
 * Fire now if the page is visible, and again each time it becomes visible,
 * through `claimDueCheck`, so a tab or app left open across Singapore midnight
 * fires once on the new day and never more than once per session and day. When
 * storage is unavailable `claimDueCheck` allows one fire per page load, so
 * returning to the tab does not refire. Returns the cleanup.
 */
export function watchDueCheck(
  doc: VisibilityDoc,
  fire: () => void,
  now: () => Date = () => new Date(),
  claim: (at: Date) => boolean = claimDueCheck,
): () => void {
  const check = () => {
    if (doc.visibilityState === "visible" && claim(now())) fire();
  };
  check();
  doc.addEventListener("visibilitychange", check);
  return () => doc.removeEventListener("visibilitychange", check);
}
