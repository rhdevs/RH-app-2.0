"use client";

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import type { Range } from "~/lib/points/constants";
import type { RosterMember } from "~/lib/points/draft";
import type { ExportBlocker } from "~/lib/points/entries";
import DraftPanel from "./DraftPanel";
import ExportDialog from "./ExportDialog";
import { rowDomId } from "./fields";
import { DEFAULT_VIEW, visibleEntries, type ListView } from "./listView";
import { MemberCards, MemberTable } from "./MemberList";
import MobileBar from "./MobileBar";
import PointsHeader from "./PointsHeader";
import SummaryCard from "./SummaryCard";
import Toolbar from "./Toolbar";
import { usePointsEntries } from "./usePointsEntries";

const HIGHLIGHT_MS = 2500;

type EntryContext = {
  entryOpen: boolean;
  range: Range;
  isWaived: boolean;
  note: string | null;
};

/** Scroll the VISIBLE copy of a row (table on desktop, card on a phone). */
function scrollToRow(rowKey: string): void {
  for (const variant of ["table", "card"] as const) {
    const el = document.getElementById(rowDomId(variant, rowKey));
    if (el && el.offsetParent !== null) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.querySelector<HTMLInputElement>("input[data-score-input]")?.focus({
        preventScroll: true,
      });
      return;
    }
  }
}

export default function Workbench({
  ccaID,
  ccaName,
  roster,
  userID,
  context,
}: {
  ccaID: number;
  ccaName: string;
  roster: RosterMember[];
  userID: string | null;
  context: EntryContext;
}) {
  const { entryOpen, range } = context;
  const state = usePointsEntries({
    ccaID,
    roster,
    storageKeyUserID: userID,
    range,
    entryOpen,
  });
  const [view, setView] = useState<ListView>(DEFAULT_VIEW);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!highlightKey) return;
    const timer = window.setTimeout(() => setHighlightKey(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightKey]);

  const rows = visibleEntries(state.entries, view);
  const disabled = !entryOpen;

  const showBlocker = (b: ExportBlocker) => {
    const key = b.rowKeys?.[0];
    if (!key) return;
    setView(DEFAULT_VIEW); // the row must be visible to be found
    setSheetOpen(false);
    setHighlightKey(key);
    window.setTimeout(() => scrollToRow(key), 50);
  };
  const startExport = () => {
    setExported(null);
    setSheetOpen(false);
    setExporting(true);
  };

  const summary = (
    <SummaryCard
      state={state}
      range={range}
      entryOpen={entryOpen}
      onBlockerClick={showBlocker}
      onExport={startExport}
    />
  );

  return (
    <div className="space-y-5 pb-24 lg:pb-0">
      <PointsHeader
        ccaName={ccaName}
        entryOpen={entryOpen}
        range={range}
        isWaived={context.isWaived}
        note={context.note}
      />

      {exported && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
          role="status"
        >
          <CheckCircle2 className="h-4 w-4" />
          <span>
            Saved <span className="font-mono">{exported}</span> to this device.
            Email it only to your portfolio head.
          </span>
          {state.draftsEnabled && state.savedAt && (
            <button
              type="button"
              onClick={() => {
                state.clearDraft();
                setExported(null);
              }}
              className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              Clear draft from this device
            </button>
          )}
        </div>
      )}

      <DraftPanel state={state} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="min-w-0 space-y-3">
          <Toolbar view={view} onChange={setView} />
          {state.entries.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
              There is nobody on this CCA&rsquo;s roster yet.
            </p>
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
              No members match.{" "}
              {view.unscoredOnly ? "Everyone shown is scored." : ""}
            </p>
          ) : (
            <>
              <div className="hidden lg:block">
                <MemberTable
                  rows={rows}
                  state={state}
                  disabled={disabled}
                  highlightKey={highlightKey}
                />
              </div>
              <div className="lg:hidden">
                <MemberCards
                  rows={rows}
                  state={state}
                  disabled={disabled}
                  highlightKey={highlightKey}
                />
              </div>
            </>
          )}
        </div>
        <aside className="hidden lg:sticky lg:top-4 lg:block">{summary}</aside>
      </div>

      <MobileBar
        state={state}
        entryOpen={entryOpen}
        summary={summary}
        sheetOpen={sheetOpen}
        onSheetOpenChange={setSheetOpen}
        onExport={startExport}
      />

      <ExportDialog
        open={exporting}
        onOpenChange={setExporting}
        ccaID={ccaID}
        ccaName={ccaName}
        entries={state.entries}
        mean={state.stats.mean}
        sd={state.stats.sd}
        onExported={setExported}
      />
    </div>
  );
}
