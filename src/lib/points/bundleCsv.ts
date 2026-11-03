import {
  BUNDLE_FORMAT_VERSION,
  type CcaType,
  type IhgResult,
  type Range,
} from "~/lib/points/constants";
import { csvCell } from "~/lib/points/csvCell";
import { isValidMatric } from "~/lib/points/entries";
import { formatFlatPoints } from "~/lib/points/flat";
import type { FlatCsvCca } from "~/lib/points/flatCsv";
import { fillRange } from "~/lib/points/meanSd";
import type { SettingsWaiver } from "~/lib/points/settingsCsv";

/**
 * The ONE file JCRC gives the sandbox: mean/SD ranges and waivers, every CCA
 * (type, sport flag, IHG result and cap), the flat-points members and each
 * resident's AUX count for the points year. Config, membership and AUX counts
 * only, no scores; the AUX cap and conversion live in the sandbox. Built in
 * the browser from data the server returned to JCRC.
 *
 * MUST MATCH rh-points-sandbox src/import/parseBundle.ts; both repos pin the
 * same fixture. Every line has exactly 19 cells. Version 2 added the `aux`
 * column and section.
 */
export const BUNDLE_EXPORT_HEADER = [
  "formatVersion",
  "section",
  "scope",
  "ccaID",
  "ccaName",
  "matric",
  "name",
  "flatPoints",
  "type",
  "sport",
  "ihgResult",
  "ihgCap",
  "meanMin",
  "meanMax",
  "sdMin",
  "sdMax",
  "note",
  "aux",
  "exportedAt",
] as const;

export const BUNDLE_SECTIONS = ["settings", "cca", "flat", "aux"] as const;

const CRLF = "\r\n";

/** One CCA as the bundle's `cca` row. `isSport` is the caller's EFFECTIVE sport flag. */
export type BundleCca = {
  ccaID: number;
  ccaName: string;
  flatPoints: number | null;
  type: CcaType | null;
  isSport: boolean;
  ihgResult: IhgResult | null;
  ihgCap: number | null;
};

/** One resident's AUX count for the year: a row of the `aux` section. */
export type BundleAux = { matric: string; name: string; aux: number };

type BundleRow = Partial<Record<(typeof BUNDLE_EXPORT_HEADER)[number], string>>;

const byCcaID = <T extends { ccaID: number }>(a: T, b: T): number =>
  a.ccaID - b.ccaID;

export function buildBundleCsv(args: {
  defaultRange: Readonly<Range>;
  waivers: readonly SettingsWaiver[];
  ccas: readonly BundleCca[];
  flat: readonly FlatCsvCca[];
  /** The points year (written as each aux row's scope) and its counts. */
  aux: { year: string; rows: readonly BundleAux[] };
  exportedAt: Date;
}): string {
  const version = String(BUNDLE_FORMAT_VERSION);
  const stamp = args.exportedAt.toISOString();
  const line = (row: BundleRow): string =>
    BUNDLE_EXPORT_HEADER.map((name) => {
      if (name === "formatVersion") return version;
      if (name === "exportedAt") return stamp;
      return row[name] ?? "";
    }).join(",");
  const rangeCells = (r: Readonly<Range>): BundleRow => ({
    meanMin: String(r.meanMin),
    meanMax: String(r.meanMax),
    sdMin: String(r.sdMin),
    sdMax: String(r.sdMax),
  });

  const defaultRow = line({
    section: "settings",
    scope: "default",
    ...rangeCells(args.defaultRange),
  });
  const waiverRows = [...args.waivers].sort(byCcaID).map((w) =>
    line({
      section: "settings",
      scope: "waiver",
      ccaID: String(w.ccaID),
      ccaName: csvCell(w.ccaName, true),
      ...rangeCells(fillRange(w, args.defaultRange)),
      note: csvCell(w.note ?? "", true),
    }),
  );
  const ccaRows = [...args.ccas].sort(byCcaID).map((c) =>
    line({
      section: "cca",
      ccaID: String(c.ccaID),
      ccaName: csvCell(c.ccaName, true),
      flatPoints: c.flatPoints === null ? "" : formatFlatPoints(c.flatPoints),
      type: c.type ?? "",
      sport: c.isSport ? "Y" : "N",
      ihgResult: c.isSport ? (c.ihgResult ?? "") : "",
      ihgCap: c.isSport && c.ihgCap !== null ? String(c.ihgCap) : "",
    }),
  );
  const flatRows = [...args.flat].sort(byCcaID).flatMap((c) =>
    c.members.map((m) => {
      if (!isValidMatric(m.matric)) {
        throw new Error("Cannot export: a member's matric is not valid.");
      }
      return line({
        section: "flat",
        ccaID: String(c.ccaID),
        ccaName: csvCell(c.ccaName, true),
        matric: m.matric.toUpperCase(),
        name: csvCell(m.name, true),
        flatPoints: formatFlatPoints(c.flatPoints),
      });
    }),
  );
  const auxRows = args.aux.rows
    .filter((a) => a.aux !== 0)
    .map((a) => {
      if (!isValidMatric(a.matric)) {
        throw new Error("Cannot export: a resident's matric is not valid.");
      }
      if (!Number.isInteger(a.aux) || a.aux < 0) {
        throw new Error("Cannot export: an AUX count is not a whole number.");
      }
      return { ...a, matric: a.matric.toUpperCase() };
    })
    .sort((a, b) => (a.matric < b.matric ? -1 : a.matric > b.matric ? 1 : 0))
    .map((a) =>
      line({
        section: "aux",
        scope: args.aux.year,
        matric: a.matric,
        name: csvCell(a.name, true),
        aux: String(a.aux),
      }),
    );
  return (
    [
      BUNDLE_EXPORT_HEADER.join(","),
      defaultRow,
      ...waiverRows,
      ...ccaRows,
      ...flatRows,
      ...auxRows,
    ].join(CRLF) + CRLF
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** points_bundle_<YYYYMMDD>.csv, with the date in the exporter's local time. */
export function bundleCsvFilename(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `points_bundle_${day}.csv`;
}

/**
 * What JCRC has not set yet, as ccaIDs in ascending order. Flat CCAs never
 * count: they need no type and no IHG.
 */
export function bundleGaps(ccas: readonly BundleCca[]): {
  type: number[];
  ihg: number[];
} {
  const open = [...ccas].sort(byCcaID).filter((c) => c.flatPoints === null);
  return {
    type: open.filter((c) => c.type === null).map((c) => c.ccaID),
    ihg: open
      .filter((c) => c.isSport && (c.ihgResult === null || c.ihgCap === null))
      .map((c) => c.ccaID),
  };
}
