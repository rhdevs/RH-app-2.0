import type { IhgContext, Range } from "~/lib/points/constants";
import {
  exportAllowedNow,
  type ExportBlocker,
  type PointsEntry,
} from "~/lib/points/entries";

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
