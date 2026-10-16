"use client";

import { AlertTriangle, CheckCircle2, Download } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Progress } from "~/components/ui/progress";
import { SD_LIMITS, SCORE_MAX, type Range } from "~/lib/points/constants";
import type { ExportBlocker } from "~/lib/points/entries";
import { advisoryHints } from "~/lib/points/hints";
import { RangeMeter, ScoreHistogram } from "./Meters";
import type { PointsState } from "./usePointsEntries";

/**
 * Everything a leader needs to decide whether they are done: progress, the two
 * live meters, the histogram, advice, what still blocks the export, and the
 * export button itself.
 */
export default function SummaryCard({
  state,
  range,
  entryOpen,
  onBlockerClick,
  onExport,
}: {
  state: PointsState;
  range: Readonly<Range>;
  entryOpen: boolean;
  onBlockerClick: (blocker: ExportBlocker) => void;
  onExport: () => void;
}) {
  const total = state.entries.length;
  const pct = total === 0 ? 0 : (state.scoredCount / total) * 100;
  const blockers = state.blockers.filter((b) => b.code !== "NOT_OPEN");
  // While entry is open the mean/SD advice is already a blocker line.
  const hints = entryOpen
    ? advisoryHints(
        state.hints,
        blockers.map((b) => b.message),
      )
    : state.hints;
  return (
    <section
      aria-label="Summary"
      className="space-y-5 rounded-xl bg-white p-5 shadow-lg"
    >
      <div>
        <p className="text-sm text-gray-600">
          Scored{" "}
          <span className="text-lg font-semibold tabular-nums text-gray-900">
            {state.scoredCount} / {total}
          </span>
        </p>
        <Progress
          value={pct}
          className="mt-2 h-2"
          aria-label="Members scored"
        />
      </div>

      <RangeMeter
        label="Average"
        value={state.stats.mean}
        min={range.meanMin}
        max={range.meanMax}
        scaleMax={SCORE_MAX}
        ok={state.meanOk}
      />
      <RangeMeter
        label="Spread (SD)"
        value={state.stats.sd}
        min={range.sdMin}
        max={range.sdMax}
        scaleMax={SD_LIMITS[1]}
        ok={state.sdOk}
      />
      <ScoreHistogram counts={state.histogram} />

      {hints.length > 0 && (
        <ul className="space-y-1 text-sm text-amber-800">
          {hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}

      {entryOpen && (
        <div className="space-y-3 border-t border-gray-100 pt-4">
          {blockers.length === 0 ? (
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> Ready to export.
            </p>
          ) : (
            <div>
              <p className="text-sm font-medium text-gray-900">
                Before you can export:
              </p>
              <ul className="mt-1.5 space-y-1">
                {blockers.map((b) => (
                  <li key={b.code}>
                    <button
                      type="button"
                      onClick={() => onBlockerClick(b)}
                      disabled={!b.rowKeys?.length}
                      className="flex w-full items-start gap-2 rounded-md px-1 py-1 text-left text-sm text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:hover:bg-transparent"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        {b.message}
                        {b.rowKeys?.length ? (
                          <span className="ml-1 underline underline-offset-2">
                            Show
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button
            className="w-full"
            disabled={blockers.length > 0}
            onClick={onExport}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </div>
      )}
    </section>
  );
}
