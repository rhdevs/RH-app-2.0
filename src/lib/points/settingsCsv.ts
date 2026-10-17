import { EXPORT_FORMAT_VERSION } from "~/lib/points/constants";
import type { Range } from "~/lib/points/constants";
import { fillRange } from "~/lib/points/meanSd";

/**
 * The points settings file JCRC gives the sandbox: the allowed mean/SD ranges
 * the sandbox re-checks every leader file against. CONFIG ONLY (no names of
 * people, no matrics, no scores). Built in the browser from what /admin/points
 * already shows.
 *
 * One `default` row, then one `waiver` row per waived CCA in ccaID order, each
 * with the EFFECTIVE range (blank waiver fields filled from the default, the
 * same per-field fallback the app uses).
 */
export const SETTINGS_EXPORT_HEADER = [
  "formatVersion",
  "scope",
  "ccaID",
  "ccaName",
  "meanMin",
  "meanMax",
  "sdMin",
  "sdMax",
  "note",
  "exportedAt",
] as const;

const CRLF = "\r\n";

/** One RFC 4180 cell; `guard` neutralises a leading = + - @ tab or CR (same as exportCsv.ts). */
function cell(value: string, guard: boolean): string {
  const safe = guard && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type SettingsWaiver = {
  ccaID: number;
  ccaName: string;
  meanMin: number | null;
  meanMax: number | null;
  sdMin: number | null;
  sdMax: number | null;
  note: string | null;
};

const rangeCells = (r: Readonly<Range>): string[] => [
  String(r.meanMin),
  String(r.meanMax),
  String(r.sdMin),
  String(r.sdMax),
];

export function buildSettingsCsv(args: {
  defaultRange: Readonly<Range>;
  waivers: readonly SettingsWaiver[];
  exportedAt: Date;
}): string {
  const version = String(EXPORT_FORMAT_VERSION);
  const stamp = args.exportedAt.toISOString();
  const defaultRow = [
    version,
    "default",
    "",
    "",
    ...rangeCells(args.defaultRange),
    "",
    stamp,
  ].join(",");
  const waiverRows = [...args.waivers]
    .sort((a, b) => a.ccaID - b.ccaID)
    .map((w) =>
      [
        version,
        "waiver",
        String(w.ccaID),
        cell(w.ccaName, true),
        ...rangeCells(fillRange(w, args.defaultRange)),
        cell(w.note ?? "", true),
        stamp,
      ].join(","),
    );
  return (
    [SETTINGS_EXPORT_HEADER.join(","), defaultRow, ...waiverRows].join(CRLF) +
    CRLF
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function settingsCsvFilename(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `points_settings_${day}.csv`;
}
