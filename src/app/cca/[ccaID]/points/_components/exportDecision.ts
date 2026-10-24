import type { IhgContext, Range } from "~/lib/points/constants";
import {
  exportAllowedNow,
  withoutStaleIhg,
  type ExportBlocker,
  type PointsEntry,
} from "~/lib/points/entries";
import { buildPointsCsv, pointsCsvFilename } from "~/lib/points/exportCsv";

/** The progress of the "check JCRC's latest settings" step when the dialog opens. */
export type ExportCheck =
  | { status: "checking" }
  | { status: "failed" }
  | { status: "done" };

const CHECKING: ExportCheck = { status: "checking" };

/**
 * Closing or (re)opening the dialog always goes back to "checking", so a reopen
 * can never start from the previous open's "done" with Download enabled.
 */
export function checkAfterOpenChange(
  previous: ExportCheck,
  open: boolean,
): ExportCheck {
  return !open || previous.status !== "checking" ? CHECKING : previous;
}

export type DownloadVerdict =
  | { allowed: true }
  | { allowed: false; reason: "checking" | "failed" }
  | { allowed: false; reason: "blocked"; blockers: ExportBlocker[] };

/**
 * May the file be downloaded right now? Needs the opening check to have finished
 * AND the LIVE settings (which can change while the dialog is open) to still pass.
 * Called for the button state and again just before the CSV is built.
 */
export function downloadVerdict(
  check: ExportCheck,
  entries: readonly PointsEntry[],
  live: {
    entryOpen: boolean;
    range: Readonly<Range>;
    ihg: IhgContext | null;
  },
): DownloadVerdict {
  if (check.status !== "done") return { allowed: false, reason: check.status };
  const now = exportAllowedNow(entries, live);
  return now.allowed
    ? { allowed: true }
    : { allowed: false, reason: "blocked", blockers: now.blockers };
}

export type ExportFile =
  | { allowed: false }
  | { allowed: true; fileName: string; csv: string; droppedIhg: number };

/**
 * Re-judges the export against the LIVE settings and, if it still passes, builds
 * the file: IHG ticks on a CCA that is no longer a sport are left out. Pure, so the
 * "left out" rule is tested without the dialog.
 */
export function buildExportFile({
  check,
  entries,
  live,
  ccaID,
  ccaName,
  now,
}: {
  check: ExportCheck;
  entries: readonly PointsEntry[];
  live: Parameters<typeof downloadVerdict>[2];
  ccaID: number;
  ccaName: string;
  now: Date;
}): ExportFile {
  if (!downloadVerdict(check, entries, live).allowed) return { allowed: false };
  const stale = withoutStaleIhg(entries, live.ihg);
  return {
    allowed: true,
    fileName: pointsCsvFilename(ccaID, now),
    csv: buildPointsCsv({
      ccaID,
      ccaName,
      entries: stale.entries,
      exportedAt: now,
    }),
    droppedIhg: stale.dropped,
  };
}
