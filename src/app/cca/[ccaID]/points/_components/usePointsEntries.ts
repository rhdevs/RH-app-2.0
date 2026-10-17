"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Range } from "~/lib/points/constants";
import {
  buildDraft,
  canAutosave,
  draftKey,
  mergeDraftWithRoster,
  mergeRosterOverEntries,
  readDraftItem,
  removeDraftItem,
  type ParsedDraft,
  type RosterMember,
} from "~/lib/points/draft";
import {
  exportBlockers,
  isValidScore,
  type PointsEntry,
} from "~/lib/points/entries";
import { adjustmentHint } from "~/lib/points/hints";
import { scoreHistogram } from "~/lib/points/histogram";
import { checkMeanSd } from "~/lib/points/meanSd";

const AUTOSAVE_MS = 500;

/** The text in a score box → the stored score: blank → null, junk → NaN. */
export function parseScoreText(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

const scoreText = (n: number | null): string =>
  n === null || Number.isNaN(n) ? "" : String(n);

/** The stored draft; storage that cannot be read at all counts as unreadable. */
function readStored(key: string, ccaID: number): ParsedDraft {
  try {
    return readDraftItem(window.localStorage, key, ccaID);
  } catch {
    return { status: "unreadable" };
  }
}

/** Remove the stored draft, treating even an unavailable localStorage as a failure. */
function removeStored(key: string): boolean {
  try {
    return removeDraftItem(window.localStorage, key);
  } catch {
    return false;
  }
}

/**
 * All of the page's state, in the browser only. Scores live in React state and,
 * as a draft, in THIS browser's localStorage — never on the server.
 *
 * `storageKey` is null while the session is still loading or when the account
 * has no canonical id; drafts are then neither read nor written.
 *
 * The entries are also held in a ref that is updated at the same moment as the
 * state, so the unmount / pagehide flush and a roster refetch always see the
 * latest edits, not the last render's.
 */
export function usePointsEntries(args: {
  ccaID: number;
  roster: readonly RosterMember[];
  storageKeyUserID: string | null;
  range: Readonly<Range>;
  entryOpen: boolean;
}) {
  const { ccaID, roster, storageKeyUserID, range, entryOpen } = args;
  const storageKey =
    storageKeyUserID === null ? null : draftKey(ccaID, storageKeyUserID);

  const [entries, setEntriesState] = useState<PointsEntry[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [droppedCount, setDroppedCount] = useState(0);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);

  const entriesRef = useRef<PointsEntry[]>([]);
  const touched = useRef(false);
  const dirty = useRef(false);
  const loadedFor = useRef<string | null>(null);
  const keyRef = useRef(storageKey);
  const ccaRef = useRef(ccaID);
  const unreadableRef = useRef(false);
  keyRef.current = storageKey;
  ccaRef.current = ccaID;
  unreadableRef.current = unreadable;

  const commit = useCallback((next: PointsEntry[]) => {
    entriesRef.current = next;
    setEntriesState(next);
  }, []);

  // First load per roster/key: today's roster with the saved draft laid on top.
  // Later roster changes merge over what is on screen instead (see below).
  useEffect(() => {
    const id = `${storageKey ?? ""}|${ccaID}`;
    if (loadedFor.current === id) {
      const merged = mergeRosterOverEntries(roster, entriesRef.current);
      commit(merged.entries);
      setTexts((prev) =>
        Object.fromEntries(
          merged.entries.map((e) => [
            e.rowKey,
            prev[e.rowKey] ?? scoreText(e.basePoints),
          ]),
        ),
      );
      if (merged.droppedCount > 0)
        setDroppedCount((c) => c + merged.droppedCount);
      return;
    }
    loadedFor.current = id;
    const parsed: ParsedDraft = storageKey
      ? readStored(storageKey, ccaID)
      : { status: "none" };
    const draft = parsed.status === "ok" ? parsed.draft : null;
    const merged = mergeDraftWithRoster(roster, draft);
    commit(merged.entries);
    setTexts(
      Object.fromEntries(
        merged.entries.map((e) => [e.rowKey, scoreText(e.basePoints)]),
      ),
    );
    setDroppedCount(merged.droppedCount);
    setSavedAt(draft ? new Date(draft.savedAt) : null);
    unreadableRef.current = parsed.status === "unreadable";
    setUnreadable(parsed.status === "unreadable");
    touched.current = false;
    dirty.current = false;
  }, [roster, storageKey, ccaID, commit]);

  // Write the draft now. Used by the debounce timer, on unmount and on pagehide.
  const flush = useCallback(() => {
    const key = keyRef.current;
    if (
      !dirty.current ||
      key === null ||
      !canAutosave({
        storageKey: key,
        touched: touched.current,
        unreadable: unreadableRef.current,
      })
    )
      return;
    const now = new Date();
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify(buildDraft(ccaRef.current, entriesRef.current, now)),
      );
      dirty.current = false;
      setSavedAt(now);
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    }
  }, []);

  // Debounced autosave, only after the leader has changed something.
  useEffect(() => {
    if (!dirty.current) return;
    if (!canAutosave({ storageKey, touched: touched.current, unreadable }))
      return;
    const timer = window.setTimeout(flush, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [entries, storageKey, unreadable, flush]);

  // A pending save must not be lost when the page is left or this view unmounts.
  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      flush();
    };
  }, [flush]);

  const update = useCallback(
    (rowKey: string, patch: Partial<PointsEntry>) => {
      if (!entryOpen) return;
      touched.current = true;
      dirty.current = true;
      commit(
        entriesRef.current.map((e) =>
          e.rowKey === rowKey ? { ...e, ...patch } : e,
        ),
      );
    },
    [entryOpen, commit],
  );

  const setScoreText = useCallback(
    (rowKey: string, text: string) => {
      if (!entryOpen) return;
      setTexts((t) => ({ ...t, [rowKey]: text }));
      update(rowKey, { basePoints: parseScoreText(text) });
    },
    [entryOpen, update],
  );

  /** True when the draft is gone. On failure nothing changes and `clearFailed` is set. */
  const clearDraft = useCallback((): boolean => {
    if (storageKey && !removeStored(storageKey)) {
      setClearFailed(true);
      return false;
    }
    setClearFailed(false);
    const fresh = mergeDraftWithRoster(roster, null);
    touched.current = false;
    dirty.current = false;
    commit(fresh.entries);
    setTexts(Object.fromEntries(fresh.entries.map((e) => [e.rowKey, ""])));
    setSavedAt(null);
    setDroppedCount(0);
    setUnreadable(false);
    return true;
  }, [storageKey, roster, commit]);

  /** Delete a stored draft that could not be read, which lets autosave resume. */
  const discardUnreadable = useCallback((): boolean => {
    if (storageKey && !removeStored(storageKey)) {
      setClearFailed(true);
      return false;
    }
    setClearFailed(false);
    setUnreadable(false);
    return true;
  }, [storageKey]);

  const derived = useMemo(() => {
    const scores = entries
      .map((e) => e.basePoints)
      .filter((s): s is number => s !== null && isValidScore(s));
    const check = checkMeanSd(scores, range);
    return {
      scoredCount: scores.length,
      stats: { mean: check.mean, sd: check.sd },
      meanOk: check.meanOk,
      sdOk: check.sdOk,
      hints: scores.length > 0 ? adjustmentHint(check, range) : [],
      histogram: scoreHistogram(entries),
      blockers: exportBlockers(entries, range, entryOpen),
    };
  }, [entries, range, entryOpen]);

  return {
    entries,
    texts,
    droppedCount,
    dismissDropped: () => setDroppedCount(0),
    savedAt,
    saveFailed,
    unreadable,
    clearFailed,
    draftsEnabled: storageKey !== null,
    update,
    setScoreText,
    clearDraft,
    discardUnreadable,
    ...derived,
  };
}

export type PointsState = ReturnType<typeof usePointsEntries>;
