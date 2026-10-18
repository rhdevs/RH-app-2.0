"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { Range } from "~/lib/points/constants";
import { downloadCsvFile } from "~/lib/points/download";
import {
  buildSettingsCsv,
  settingsCsvFilename,
  type SettingsWaiver,
} from "~/lib/points/settingsCsv";

/**
 * "Export settings file": the allowed ranges (default plus each waiver, filled
 * in) for the points sandbox. Built in the browser from the settings already on
 * this page; config only, so it asks the server for nothing and holds no
 * personal data.
 */
export default function SettingsExport({
  effectiveDefault,
  waivers,
}: {
  effectiveDefault: Range;
  waivers: readonly SettingsWaiver[];
}) {
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportFile = () => {
    setStarted(null);
    setError(null);
    try {
      const now = new Date();
      const fileName = settingsCsvFilename(now);
      downloadCsvFile(
        fileName,
        buildSettingsCsv({
          defaultRange: effectiveDefault,
          waivers,
          exportedAt: now,
        }),
      );
      setStarted(fileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-xl">
          <h3 className="text-sm font-semibold text-gray-900">
            Points settings file
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            The default ranges and every waiver, in one file for the points
            sandbox. It holds no names or matric numbers.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportFile}>
          <Download className="h-4 w-4" />
          Export settings file
        </Button>
      </div>
      {started && (
        <p className="mt-3 text-sm text-emerald-700" role="status">
          Download started: <span className="font-mono">{started}</span>. Load
          it into the points sandbox together with the leader files.
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-700" role="alert">
          Couldn&rsquo;t create the file: {error}
        </p>
      )}
    </section>
  );
}
