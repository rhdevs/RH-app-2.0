"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { api } from "~/trpc/react";
import { downloadTextFile } from "~/app/events/_lib/format";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  buildFlatPointsCsv,
  flatCsvCcas,
  flatExportBlockers,
  flatPointsCsvFilename,
  type FlatBlocker,
  type FlatExportCca,
  type FlatWarning,
} from "~/lib/points/flatCsv";
import { pointsErrorCopy } from "./errorCopy";

type Stage =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "blocked";
      blockers: FlatBlocker[];
      warnings: FlatWarning[];
    }
  | {
      kind: "confirm";
      ccas: FlatExportCca[];
      ccaCount: number;
      totalRows: number;
      warnings: FlatWarning[];
    };

/**
 * "Export flat-points CSV". The roster (with matrics) is fetched only when the
 * button is pressed, checked here, and dropped as soon as the dialog closes. The
 * file is built in the browser and saved to this device; nothing is uploaded.
 */
export default function FlatExport({ flatCount }: { flatCount: number }) {
  const utils = api.useUtils();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const close = () => setStage({ kind: "idle" });

  const start = async () => {
    setStage({ kind: "loading" });
    try {
      const data = await utils.ccaPoints.flatExportData.fetch(undefined, {
        staleTime: 0,
      });
      const check = flatExportBlockers(data);
      if (check.blockers.length > 0) {
        setStage({
          kind: "blocked",
          blockers: check.blockers,
          warnings: check.warnings,
        });
      } else {
        setStage({
          kind: "confirm",
          ccas: data,
          ccaCount: check.ccaCount,
          totalRows: check.totalRows,
          warnings: check.warnings,
        });
      }
    } catch (error) {
      const e = error as { message?: string; data?: { code?: string } };
      setStage({
        kind: "error",
        message: pointsErrorCopy(e.message ?? "", e.data?.code),
      });
    }
  };

  const download = (ccas: FlatExportCca[]) => {
    const now = new Date();
    downloadTextFile(
      flatPointsCsvFilename(now),
      buildFlatPointsCsv({ ccas: flatCsvCcas(ccas), exportedAt: now }),
      "text/csv;charset=utf-8",
    );
    close();
  };

  const loading = stage.kind === "loading";
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={flatCount === 0 || loading}
        onClick={() => void start()}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        Export flat-points CSV
      </Button>
      {stage.kind === "error" && (
        <p className="mt-2 text-sm text-red-700" role="alert">
          {stage.message}{" "}
          <button
            type="button"
            onClick={() => void start()}
            className="rounded font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      )}

      <AlertDialog
        open={stage.kind === "blocked"}
        onOpenChange={(o) => !o && close()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              The file can&rsquo;t be made yet
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-gray-600">
                <p>Fix these first, then export again:</p>
                {stage.kind === "blocked" && (
                  <ul className="list-disc space-y-1 pl-5 text-gray-800">
                    {stage.blockers.map((b) => (
                      <li key={`${b.ccaID}-${b.code}`}>{b.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
            <Button disabled>
              <Download className="h-4 w-4" />
              Download
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={stage.kind === "confirm"}
        onOpenChange={(o) => !o && close()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Download the flat-points file?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-gray-600">
                <p className="font-medium text-gray-900">
                  This file lists matric numbers. Send it only to the JCRC
                  member running the points sandbox.
                </p>
                {stage.kind === "confirm" && (
                  <>
                    <p>
                      {stage.ccaCount} {stage.ccaCount === 1 ? "CCA" : "CCAs"} ·{" "}
                      {stage.totalRows} {stage.totalRows === 1 ? "row" : "rows"}
                    </p>
                    {stage.warnings.length > 0 && (
                      <ul className="list-disc pl-5 text-amber-800">
                        {stage.warnings.map((w) => (
                          <li key={w.ccaID}>{w.message}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={() => stage.kind === "confirm" && download(stage.ccas)}
            >
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
