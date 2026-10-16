"use client";

import { ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";
import type { PointsState } from "./usePointsEntries";

function Dot({ ok, has }: { ok: boolean; has: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 rounded-full ${!has ? "bg-gray-300" : ok ? "bg-emerald-500" : "bg-red-500"}`}
    />
  );
}

/**
 * Phone only: a bar pinned to the bottom with the numbers that matter while
 * typing. Tapping it opens the full summary in a sheet.
 */
export default function MobileBar({
  state,
  entryOpen,
  summary,
  sheetOpen,
  onSheetOpenChange,
  onExport,
}: {
  state: PointsState;
  entryOpen: boolean;
  summary: ReactNode;
  sheetOpen: boolean;
  onSheetOpenChange: (open: boolean) => void;
  onExport: () => void;
}) {
  const has = state.scoredCount > 0;
  const ready = entryOpen && state.blockers.length === 0;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 px-3 py-2 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] backdrop-blur lg:hidden">
      <div className="mx-auto flex max-w-xl items-center gap-2">
        <Sheet open={sheetOpen} onOpenChange={onSheetOpenChange}>
          <SheetTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label="Open the full summary"
            >
              <span className="tabular-nums">
                <span className="font-semibold">{state.scoredCount}</span>/
                {state.entries.length}
              </span>
              <span className="flex items-center gap-1 tabular-nums">
                <Dot ok={state.meanOk} has={has} />
                Avg {has ? state.stats.mean.toFixed(2) : "—"}
              </span>
              <span className="flex items-center gap-1 tabular-nums">
                <Dot ok={state.sdOk} has={has} />
                SD {has ? state.stats.sd.toFixed(2) : "—"}
              </span>
              <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-gray-400" />
            </button>
          </SheetTrigger>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
            <SheetHeader>
              <SheetTitle>Summary</SheetTitle>
              <SheetDescription>
                Your scores so far, checked in this browser.
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4">{summary}</div>
          </SheetContent>
        </Sheet>
        {entryOpen && (
          <Button size="sm" disabled={!ready} onClick={onExport}>
            Export
          </Button>
        )}
      </div>
    </div>
  );
}
