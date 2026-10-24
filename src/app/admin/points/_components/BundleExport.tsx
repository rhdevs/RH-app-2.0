"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";

import { api } from "~/trpc/react";
import { downloadCsvFile } from "~/lib/points/download";
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
  buildBundleCsv,
  bundleCsvFilename,
  bundleGaps,
  type BundleCca,
} from "~/lib/points/bundleCsv";
import type { Range } from "~/lib/points/constants";
import {
  flatCsvCcas,
  flatExportBlockers,
  type FlatBlocker,
  type FlatExportCca,
  type FlatWarning,
} from "~/lib/points/flatCsv";
import type { SettingsWaiver } from "~/lib/points/settingsCsv";
import { bundleGapLines } from "./bundleGapCopy";
import { pointsErrorCopy } from "./errorCopy";

type BundleData = {
  effectiveDefault: Range;
  waivers: SettingsWaiver[];
  ccas: BundleCca[];
  flat: FlatExportCca[];
};

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
      data: BundleData;
      ccaCount: number;
      sportCount: number;
      flatCcaCount: number;
      totalRows: number;
      warnings: FlatWarning[];
      gapLines: string[];
    };

/**
 * "Download sandbox bundle". The data (flat rosters with matrics) is fetched only
 * when the button is pressed, checked here, and dropped as soon as the dialog
 * closes. The file is built in the browser and saved to this device; nothing is
 * uploaded. Missing types or IHG results are warned about but never block.
 */
export default function BundleExport() {
  // A mutation, not a query: each export is audited on the server and the rosters
  // (matrics) are never kept in the query cache. reset() drops them on close.
  const exportData = api.ccaPoints.bundleExportData.useMutation();
  const { reset: resetExport } = exportData;
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const close = () => {
    setDownloadError(null);
    resetExport();
    setStage({ kind: "idle" });
  };

  const start = async () => {
    setDownloadError(null);
    setStarted(null);
    setStage({ kind: "loading" });
    try {
      const data = await exportData.mutateAsync();
      const check = flatExportBlockers(data.flat);
      if (check.blockers.length > 0) {
        setStage({
          kind: "blocked",
          blockers: check.blockers,
          warnings: check.warnings,
        });
      } else {
        setStage({
          kind: "confirm",
          data,
          ccaCount: data.ccas.length,
          sportCount: data.ccas.filter((c) => c.isSport).length,
          flatCcaCount: check.ccaCount,
          totalRows: check.totalRows,
          warnings: check.warnings,
          gapLines: bundleGapLines(data.ccas, bundleGaps(data.ccas)),
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

  const download = (data: BundleData) => {
    try {
      const now = new Date();
      const fileName = bundleCsvFilename(now);
      downloadCsvFile(
        fileName,
        buildBundleCsv({
          defaultRange: data.effectiveDefault,
          waivers: data.waivers,
          ccas: data.ccas,
          flat: flatCsvCcas(data.flat),
          exportedAt: now,
        }),
      );
      close();
      setStarted(fileName);
    } catch (e) {
      setDownloadError(
        e instanceof Error ? e.message : "Something went wrong.",
      );
    }
  };

  const loading = stage.kind === "loading";
  return (
    <div>
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => void start()}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        Download sandbox bundle
      </Button>
      {started && (
        <p className="mt-3 text-sm text-emerald-700" role="status">
          Download started: <span className="font-mono">{started}</span>. Load
          it into the points sandbox together with the leader files and
          JCRC&rsquo;s residents list.
        </p>
      )}
      {stage.kind === "error" && (
        <p className="mt-3 text-sm text-red-700" role="alert">
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
                <p>Fix these first, then download again:</p>
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
            <AlertDialogTitle>Download the sandbox bundle?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-gray-600">
                <p className="font-medium text-gray-900">
                  This file lists matric numbers (members of flat-points CCAs).
                  Send it only to the JCRC member running the points sandbox.
                </p>
                {downloadError && (
                  <p className="text-red-700" role="alert">
                    Couldn&rsquo;t create the file: {downloadError}
                  </p>
                )}
                {stage.kind === "confirm" && (
                  <>
                    <p>
                      {stage.ccaCount} {stage.ccaCount === 1 ? "CCA" : "CCAs"} ·{" "}
                      {stage.sportCount}{" "}
                      {stage.sportCount === 1 ? "sport" : "sports"} ·{" "}
                      {stage.flatCcaCount} flat-points{" "}
                      {stage.flatCcaCount === 1 ? "CCA" : "CCAs"} ·{" "}
                      {stage.totalRows}{" "}
                      {stage.totalRows === 1 ? "member row" : "member rows"}
                    </p>
                    {stage.warnings.length > 0 && (
                      <ul className="list-disc pl-5 text-amber-800">
                        {stage.warnings.map((w) => (
                          <li key={w.ccaID}>{w.message}</li>
                        ))}
                      </ul>
                    )}
                    {stage.gapLines.length > 0 && (
                      <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                        {stage.gapLines.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                        <p>
                          The sandbox will warn about them and will not finalise
                          until they are set here and the bundle is downloaded
                          again.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={() => stage.kind === "confirm" && download(stage.data)}
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
