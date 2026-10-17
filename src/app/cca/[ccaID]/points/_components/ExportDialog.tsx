"use client";

import { useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { downloadTextFile } from "~/app/events/_lib/format";
import type { Range } from "~/lib/points/constants";
import {
  exportAllowedNow,
  type ExportBlocker,
  type PointsEntry,
} from "~/lib/points/entries";
import { buildPointsCsv, pointsCsvFilename } from "~/lib/points/exportCsv";

/**
 * The last step: a reminder that the file is confidential, a summary to check,
 * and then a download built entirely in the browser. Nothing is sent anywhere —
 * the leader emails the file themselves.
 */
export default function ExportDialog({
  open,
  onOpenChange,
  ccaID,
  ccaName,
  entries,
  mean,
  sd,
  refreshContext,
  onExported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ccaID: number;
  ccaName: string;
  entries: readonly PointsEntry[];
  mean: number;
  sd: number;
  /** Re-reads JCRC's settings; null when the read failed. */
  refreshContext: () => Promise<{
    entryOpen: boolean;
    range: Range;
  } | null>;
  onExported: (fileName: string) => void;
}) {
  // Each time the dialog opens, JCRC's CURRENT settings are fetched and the export
  // is re-judged against them before a download is offered.
  const [check, setCheck] = useState<
    | { status: "checking" }
    | { status: "failed" }
    | { status: "done"; blockers: ExportBlocker[] }
  >({ status: "checking" });
  useEffect(() => {
    if (!open) return;
    let current = true;
    setCheck({ status: "checking" });
    void refreshContext()
      .then((fresh) => {
        if (!current) return;
        setCheck(
          fresh
            ? {
                status: "done",
                blockers: exportAllowedNow(entries, fresh).blockers,
              }
            : { status: "failed" },
        );
      })
      .catch(() => current && setCheck({ status: "failed" }));
    return () => {
      current = false;
    };
    // Only on opening: the dialog is modal, so entries cannot change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const blocked = check.status === "done" && check.blockers.length > 0;
  const download = () => {
    const now = new Date();
    const fileName = pointsCsvFilename(ccaID, now);
    const csv = buildPointsCsv({ ccaID, ccaName, entries, exportedAt: now });
    downloadTextFile(fileName, csv, "text/csv;charset=utf-8");
    onOpenChange(false);
    onExported(fileName);
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            Export points for {ccaName}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-gray-600">
              <p className="font-medium text-gray-900">
                This file is confidential. Email it only to your portfolio head.
              </p>
              <dl className="grid grid-cols-3 gap-2 rounded-md bg-gray-50 p-3 text-center">
                <div>
                  <dt className="text-xs text-gray-500">Members</dt>
                  <dd className="text-lg font-semibold tabular-nums text-gray-900">
                    {entries.length}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Average</dt>
                  <dd className="text-lg font-semibold tabular-nums text-gray-900">
                    {mean.toFixed(2)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-gray-500">Spread (SD)</dt>
                  <dd className="text-lg font-semibold tabular-nums text-gray-900">
                    {sd.toFixed(2)}
                  </dd>
                </div>
              </dl>
              <p>The file is saved to this device only. Nothing is uploaded.</p>
              {check.status === "checking" && (
                <p
                  className="flex items-center gap-2 text-gray-600"
                  role="status"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Checking latest settings…
                </p>
              )}
              {check.status === "failed" && (
                <p className="text-red-700" role="alert">
                  Couldn&rsquo;t check JCRC&rsquo;s latest settings, so the file
                  can&rsquo;t be downloaded right now. Close this and try again.
                </p>
              )}
              {check.status === "done" && check.blockers.length > 0 && (
                <ul
                  className="list-disc space-y-1 pl-5 text-red-700"
                  role="alert"
                >
                  {check.blockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <button
            type="button"
            onClick={download}
            disabled={check.status !== "done" || blocked}
            className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:pointer-events-none disabled:opacity-50"
          >
            Download CSV
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
