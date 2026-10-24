"use client";

import { Info, Lock } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import type { IhgContext, Range } from "~/lib/points/constants";
import { ihgResultLabel } from "./usePointsEntries";

/** Status, the allowed range in plain words, and any waiver note. */
export default function PointsHeader({
  ccaName,
  entryOpen,
  range,
  isWaived,
  note,
  ihg,
}: {
  ccaName: string;
  entryOpen: boolean;
  range: Readonly<Range>;
  isWaived: boolean;
  note: string | null;
  ihg: IhgContext | null;
}) {
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold text-gray-900">Points</h2>
        <span className="text-sm text-gray-500">{ccaName}</span>
        {entryOpen && (
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-emerald-800">
            Open
          </span>
        )}
      </div>

      {!entryOpen && (
        <p
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="status"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          Points entry isn&rsquo;t open yet. JCRC will announce when it opens.
        </p>
      )}

      <p className="flex flex-wrap items-center gap-1.5 text-sm text-gray-700">
        <span>
          Average must be{" "}
          <strong className="tabular-nums">
            {range.meanMin}–{range.meanMax}
          </strong>{" "}
          · Spread (SD) must be{" "}
          <strong className="tabular-nums">
            {range.sdMin}–{range.sdMax}
          </strong>
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="What is the spread?"
              className="rounded-full text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <Info className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            The spread (standard deviation) is how spread out your scores are.
            Too low means everyone got about the same; too high means scores are
            far apart. It is worked out over everyone&rsquo;s full score.
          </TooltipContent>
        </Tooltip>
      </p>

      {ihg &&
        (ihg.result !== null && ihg.cap !== null ? (
          <p className="text-sm text-gray-700">
            <span className="font-medium text-gray-900">
              IHG result: {ihgResultLabel(ihg.result)}
            </span>{" "}
            · up to {ihg.cap} members get the IHG points — tick them below.
          </p>
        ) : (
          <p
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            role="status"
          >
            JCRC hasn&rsquo;t set this CCA&rsquo;s IHG result and cap yet. You
            can enter scores and ticks now; the export waits for JCRC.
          </p>
        ))}

      {isWaived && (
        <p className="text-sm text-gray-600">
          <span className="font-medium text-gray-900">
            Your CCA has its own range.
          </span>
          {note ? ` JCRC note: ${note}` : null}
        </p>
      )}
    </header>
  );
}
