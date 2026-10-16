"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Range } from "~/lib/points/constants";
import {
  buildDraft,
  draftKey,
  mergeDraftWithRoster,
  parseDraft,
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

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * All of the page's state, in the browser only. Scores live in React state and,
 * as a draft, in THIS browser's localStorage — never on the server.
 *
 * `storageKey` is null while the session is still loading or when the account
 * has no canonical id; drafts are then neither read nor written.
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

  const [entries, setEntries] = useState<PointsEntry[]>([]);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [droppedCount, setDroppedCount] = useState(0);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const touched = useRef(false);

  // Load once per roster/key: today's roster with the saved draft laid on top.
  useEffect(() => {
    const draft = storageKey
      ? parseDraft(readStorage(storageKey), ccaID)
      : null;
    const merged = mergeDraftWithRoster(roster, draft);
    setEntries(merged.entries);
    setTexts(
      Object.fromEntries(
        merged.entries.map((e) => [e.rowKey, scoreText(e.basePoints)]),
      ),
    );
    setDroppedCount(merged.droppedCount);
    setSavedAt(draft ? new Date(draft.savedAt) : null);
    touched.current = false;
  }, [roster, storageKey, ccaID]);

  // Debounced autosave, only after the leader has changed something.
  useEffect(() => {
    if (!storageKey || !touched.current) return;
    const timer = window.setTimeout(() => {
      const now = new Date();
      try {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify(buildDraft(ccaID, entries, now)),
        );
        setSavedAt(now);
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [entries, storageKey, ccaID]);

  const update = useCallback(
    (rowKey: string, patch: Partial<PointsEntry>) => {
      if (!entryOpen) return;
      touched.current = true;
      setEntries((list) =>
        list.map((e) => (e.rowKey === rowKey ? { ...e, ...patch } : e)),
      );
    },
    [entryOpen],
  );

  const setScoreText = useCallback(
    (rowKey: string, text: string) => {
      if (!entryOpen) return;
      setTexts((t) => ({ ...t, [rowKey]: text }));
      update(rowKey, { basePoints: parseScoreText(text) });
    },
    [entryOpen, update],
  );

  const clearDraft = useCallback(() => {
    if (storageKey) {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // Nothing stored or storage blocked: either way nothing is left behind.
      }
    }
    const fresh = mergeDraftWithRoster(roster, null);
    touched.current = false;
    setEntries(fresh.entries);
    setTexts(Object.fromEntries(fresh.entries.map((e) => [e.rowKey, ""])));
    setSavedAt(null);
    setDroppedCount(0);
  }, [storageKey, roster]);

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
    draftsEnabled: storageKey !== null,
    update,
    setScoreText,
    clearDraft,
    ...derived,
  };
}

export type PointsState = ReturnType<typeof usePointsEntries>;
