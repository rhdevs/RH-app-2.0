import { FLAT_FORMAT_VERSION } from "~/lib/points/constants";
import { formatFlatPoints } from "~/lib/points/flat";
import { isValidMatric } from "~/lib/points/entries";

/**
 * The flat-points export JCRC feeds the sandbox (rh-points-sandbox
 * docs/points-spec.md §2e): ONE file for every flat CCA, one row per member per
 * CCA. Built in the browser from data the server returned to JCRC; it is
 * membership plus JCRC's own config, not leader-judged scores.
 */
export const FLAT_EXPORT_HEADER = [
  "formatVersion",
  "ccaID",
  "ccaName",
  "matric",
  "name",
  "flatPoints",
  "exportedAt",
] as const;

const CRLF = "\r\n";

/** One RFC 4180 cell; `guard` neutralises a leading = + - @ tab or CR (same as exportCsv.ts). */
function cell(value: string, guard: boolean): string {
  const safe = guard && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type FlatCcaMember = { matric: string; name: string };

export type FlatCsvCca = {
  ccaID: number;
  ccaName: string;
  flatPoints: number;
  members: readonly FlatCcaMember[];
};

export function buildFlatPointsCsv(args: {
  ccas: readonly FlatCsvCca[];
  exportedAt: Date;
}): string {
  const stamp = args.exportedAt.toISOString();
  const rows = args.ccas.flatMap((cca) =>
    cca.members.map((m) => {
      if (!isValidMatric(m.matric)) {
        throw new Error("Cannot export: a member's matric is not valid.");
      }
      return [
        String(FLAT_FORMAT_VERSION),
        String(cca.ccaID),
        cell(cca.ccaName, true),
        m.matric.toUpperCase(),
        cell(m.name, true),
        formatFlatPoints(cca.flatPoints),
        stamp,
      ].join(",");
    }),
  );
  return [FLAT_EXPORT_HEADER.join(","), ...rows].join(CRLF) + CRLF;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** flat_points_<YYYYMMDD>.csv, with the date in the exporter's local time. */
export function flatPointsCsvFilename(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `flat_points_${day}.csv`;
}

/* -------------------------------------------------------------------------- */
/* What stops the export                                                       */
/* -------------------------------------------------------------------------- */

/** A directory entry as the server returns it for the export. */
export type FlatExportMember = {
  rowKey: string;
  matric: string | null;
  name: string | null;
  resolved: boolean;
};

export type FlatExportCca = {
  ccaID: number;
  ccaName: string;
  flatPoints: number;
  members: readonly FlatExportMember[];
};

export type FlatBlockerCode =
  | "UNRESOLVED"
  | "NO_MATRIC"
  | "BAD_MATRIC"
  | "DUPLICATE_MATRIC";

export type FlatBlocker = {
  ccaID: number;
  ccaName: string;
  code: FlatBlockerCode;
  count: number;
  message: string;
};

export type FlatWarning = { ccaID: number; ccaName: string; message: string };

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

function messageFor(code: FlatBlockerCode, ccaName: string, n: number): string {
  switch (code) {
    case "UNRESOLVED":
      return `${ccaName}: ${n} roster ${plural(n, "entry is", "entries are")} not matched to an account — fix the roster`;
    case "NO_MATRIC":
      return `${ccaName}: ${n} ${plural(n, "member has", "members have")} no matric on record — ask them to add it in their RHApp profile, or fix the roster`;
    case "BAD_MATRIC":
      return `${ccaName}: ${n} ${plural(n, "member has a matric", "members have matrics")} not in the right format (A, seven digits, a letter) — ask them to correct it in their RHApp profile`;
    case "DUPLICATE_MATRIC":
      return `${ccaName}: ${n} ${plural(n, "matric appears", "matrics appear")} more than once in the roster — fix the roster`;
  }
}

/** Counts members of one CCA by the problem that would stop the export. */
function problemsOf(
  members: readonly FlatExportMember[],
): Map<FlatBlockerCode, number> {
  const counts = new Map<FlatBlockerCode, number>();
  const bump = (code: FlatBlockerCode) =>
    counts.set(code, (counts.get(code) ?? 0) + 1);
  const seen = new Set<string>();
  for (const m of members) {
    if (!m.resolved) bump("UNRESOLVED");
    else if (m.matric === null || m.matric.trim() === "") bump("NO_MATRIC");
    else if (!isValidMatric(m.matric.trim())) bump("BAD_MATRIC");
    else if (seen.has(m.matric.trim().toUpperCase())) bump("DUPLICATE_MATRIC");
    else seen.add(m.matric.trim().toUpperCase());
  }
  return counts;
}

const ORDER: readonly FlatBlockerCode[] = [
  "UNRESOLVED",
  "NO_MATRIC",
  "BAD_MATRIC",
  "DUPLICATE_MATRIC",
];

/** Everything that blocks the download, grouped per CCA, plus empty-CCA warnings. */
export function flatExportBlockers(ccas: readonly FlatExportCca[]): {
  blockers: FlatBlocker[];
  warnings: FlatWarning[];
  ccaCount: number;
  totalRows: number;
} {
  const blockers: FlatBlocker[] = [];
  const warnings: FlatWarning[] = [];
  for (const cca of ccas) {
    if (cca.members.length === 0) {
      warnings.push({
        ccaID: cca.ccaID,
        ccaName: cca.ccaName,
        message: `${cca.ccaName} has no members, so it adds no rows to the file`,
      });
      continue;
    }
    const counts = problemsOf(cca.members);
    for (const code of ORDER) {
      const count = counts.get(code);
      if (count) {
        blockers.push({
          ccaID: cca.ccaID,
          ccaName: cca.ccaName,
          code,
          count,
          message: messageFor(code, cca.ccaName, count),
        });
      }
    }
  }
  return {
    blockers,
    warnings,
    ccaCount: ccas.length,
    totalRows: ccas.reduce((n, c) => n + c.members.length, 0),
  };
}

/** The export's rows, once nothing blocks it (matrics trimmed; names defaulted). */
export function flatCsvCcas(ccas: readonly FlatExportCca[]): FlatCsvCca[] {
  return ccas.map((c) => ({
    ccaID: c.ccaID,
    ccaName: c.ccaName,
    flatPoints: c.flatPoints,
    members: c.members.map((m) => ({
      matric: (m.matric ?? "").trim(),
      name: m.name ?? "",
    })),
  }));
}
