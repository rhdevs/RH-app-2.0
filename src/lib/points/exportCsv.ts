import { EXPORT_FORMAT_VERSION } from "~/lib/points/constants";
import { isValidMatric, type PointsEntry } from "~/lib/points/entries";

/**
 * The leader export, in the exact format the sandbox imports
 * (rh-points-sandbox/docs/points-spec.md §2a). Built in the browser and handed
 * to the user as a download; it never goes to the server.
 */
export const EXPORT_HEADER = [
  "formatVersion",
  "ccaID",
  "ccaName",
  "matric",
  "name",
  "basePoints",
  "semesterOnly",
  "outgoingRole",
  "incomingRole",
  "ihg",
  "exportedAt",
] as const;

const CRLF = "\r\n";

/**
 * One RFC 4180 cell. With `guard`, a leading = + - @ tab or carriage return gets an apostrophe
 * first (neutralise, THEN quote — the order matters, see serializeCsv's csvField
 * in src/app/events/_lib/format.ts), so a name that starts with a formula
 * character cannot execute when the file is opened in Excel.
 */
function cell(value: string, guard: boolean): string {
  const safe = guard && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Only ccaName and name are free text; every other column is a controlled value. */
function row(
  ccaID: number,
  ccaName: string,
  entry: PointsEntry,
  exportedAt: string,
): string {
  if (!entry.resolved) {
    throw new Error(
      "Cannot export: a roster entry is not matched to an account.",
    );
  }
  if (entry.matric === null) {
    throw new Error("Cannot export: a member has no matric on record.");
  }
  if (!isValidMatric(entry.matric)) {
    throw new Error(
      "Cannot export: a member's matric is not in the right format.",
    );
  }
  if (entry.basePoints === null) {
    throw new Error("Cannot export: a member has no score.");
  }
  return [
    cell(String(EXPORT_FORMAT_VERSION), false),
    cell(String(ccaID), false),
    cell(ccaName, true),
    cell(entry.matric.toUpperCase(), false),
    cell(entry.name ?? "", true),
    cell(String(entry.basePoints), false),
    entry.semesterOnly ? "Y" : "N",
    entry.outgoingRole,
    entry.incomingRole,
    entry.ihg ? "Y" : "N",
    cell(exportedAt, false),
  ].join(",");
}

export function buildPointsCsv(args: {
  ccaID: number;
  ccaName: string;
  entries: readonly PointsEntry[];
  exportedAt: Date;
}): string {
  const stamp = args.exportedAt.toISOString();
  const lines = [
    EXPORT_HEADER.join(","),
    ...args.entries.map((e) => row(args.ccaID, args.ccaName, e, stamp)),
  ];
  return lines.join(CRLF) + CRLF;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** points_<ccaID>_<YYYYMMDD>.csv, with the date in the leader's local time. */
export function pointsCsvFilename(ccaID: number, date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `points_${ccaID}_${day}.csv`;
}
