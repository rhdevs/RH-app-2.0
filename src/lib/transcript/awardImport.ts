import { z } from "zod";
import {
  AWARD_CITATION_MAX,
  AWARD_NAME_MAX,
  normalizeAwardName,
} from "./awards";
import { academicYearInput, idInput, line } from "./manageInput";

/**
 * AWARDS CSV IMPORT, as pure rules: the template, the column mapping, how a row
 * is classified, and what the commit needs decided first. No database: the
 * service feeds in what it looked up.
 */

/** Rows in one upload. */
export const MAX_IMPORT_ROWS = 2000;
export const TOO_MANY_ROWS_MESSAGE =
  "This file has more than 2,000 rows. Split it and upload in parts.";
/** Rows written per chunk. */
export const IMPORT_CHUNK_SIZE = 200;

export interface ImportRow {
  identifier: string;
  award: string;
  citation?: string | null;
}

/* ---- the template and the columns ------------------------------------------- */

export const TEMPLATE_FILE_NAME = "awards-template.csv";
export const TEMPLATE_HEADER = "identifier,award,citation";
/** One made-up example row; the address is not a real person's. */
export const TEMPLATE_EXAMPLE =
  "e0000001@u.nus.edu,Full Colours,For outstanding contribution to hall life";
export const TEMPLATE_CSV = `${TEMPLATE_HEADER}\r\n${TEMPLATE_EXAMPLE}\r\n`;

export const IMPORT_COLUMNS = [
  "identifier",
  "award",
  "citation",
  "ignore",
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const COLUMN_LABEL: Record<ImportColumn, string> = {
  identifier: "NUS email or NUSNET id",
  award: "Award",
  citation: "Citation (optional)",
  ignore: "Ignore",
};

/** A header's likely meaning. The user can always change it. */
export function guessImportColumn(header: string): ImportColumn {
  const h = header.trim().toLowerCase();
  if (
    /^(identifier|e-?mail|email address|nusnet|nus ?net( id)?|user ?id|id)$/.test(
      h,
    )
  ) {
    return "identifier";
  }
  if (h.includes("mail") || h.includes("nusnet") || h === "identifier") {
    return "identifier";
  }
  if (/^(award|award name|award title)$/.test(h) || h.startsWith("award")) {
    return "award";
  }
  if (
    /^(citation|citations|remarks?|reason)$/.test(h) ||
    h.startsWith("citation")
  ) {
    return "citation";
  }
  return "ignore";
}

/** Guess every column. Only the first column to claim a role keeps it. */
export function guessMapping(headers: readonly string[]): ImportColumn[] {
  const taken = new Set<ImportColumn>();
  return headers.map((h) => {
    const g = guessImportColumn(h);
    if (g === "ignore" || taken.has(g)) return "ignore";
    taken.add(g);
    return g;
  });
}

/** Does the first row look like headings (it names at least the identifier or the award)? */
export function looksLikeHeader(first: readonly string[]): boolean {
  return first.some((c) => {
    const g = guessImportColumn(c);
    return g === "identifier" || g === "award";
  });
}

/** The mapping is usable when an identifier and an award column are chosen once each. */
export function mappingProblem(
  mapping: readonly ImportColumn[],
): string | null {
  const count = (c: ImportColumn) => mapping.filter((m) => m === c).length;
  if (count("identifier") !== 1) {
    return "Choose exactly one column for the NUS email or NUSNET id.";
  }
  if (count("award") !== 1) return "Choose exactly one column for the award.";
  if (count("citation") > 1)
    return "Choose at most one column for the citation.";
  return null;
}

/** Rows from a parsed table, by the mapping. Wholly blank rows are dropped. */
export function rowsFromTable(
  table: readonly (readonly string[])[],
  mapping: readonly ImportColumn[],
  hasHeader: boolean,
): ImportRow[] {
  const at = (c: ImportColumn) => mapping.indexOf(c);
  const [i, a, c] = [at("identifier"), at("award"), at("citation")];
  return table
    .slice(hasHeader ? 1 : 0)
    .map((r) => ({
      identifier: (r[i] ?? "").trim(),
      award: (r[a] ?? "").trim(),
      citation: c >= 0 ? (r[c] ?? "").trim() : "",
    }))
    .filter((r) => r.identifier !== "" || r.award !== "" || r.citation !== "");
}

/* ---- checking one row's text --------------------------------------------------- */

const awardNameField = line(1, AWARD_NAME_MAX);
// A citation is one line on the transcript, so a newline is not allowed.
const citationLine = line(0, AWARD_CITATION_MAX);

const FORBIDDEN = "Contains characters that are not allowed.";

function why(
  result: z.SafeParseReturnType<unknown, unknown>,
  field: string,
  max: number,
): string | null {
  if (result.success) return null;
  const msg = result.error.issues[0]?.message ?? "";
  if (msg === "REQUIRED") return `The ${field} is empty.`;
  if (msg.startsWith("AT_MOST_")) {
    return `The ${field} is longer than ${max} characters.`;
  }
  return FORBIDDEN;
}

/** Why a row's text is not acceptable, or null. Mirrors the server's input rules. */
export function invalidReason(row: ImportRow): string | null {
  if (row.identifier.trim() === "") return "The identifier is empty.";
  if (row.identifier.length > 200) return "The identifier is too long.";
  if (/[\u0000-\u001F\u007F-\u009F]/.test(row.identifier)) return FORBIDDEN;
  const award = why(
    awardNameField.safeParse(row.award),
    "award name",
    AWARD_NAME_MAX,
  );
  if (award) return award;
  const citation = (row.citation ?? "").trim();
  if (citation !== "") {
    const c = why(
      citationLine.safeParse(citation),
      "citation",
      AWARD_CITATION_MAX,
    );
    if (c) return c;
  }
  return null;
}

/* ---- classifying rows ------------------------------------------------------------ */

export type RowStatus = "ready" | "not_found" | "duplicate" | "invalid";
export const STATUS_LABEL: Record<RowStatus, string> = {
  ready: "Ready",
  not_found: "Not found",
  duplicate: "Duplicate",
  invalid: "Invalid",
};

export interface CatalogueEntry {
  id: string;
  name: string;
  defaultCitation: string | null;
  archived: boolean;
}

export interface ClassifiedRow {
  /** 1-based position in the rows sent (the heading row is not counted). */
  row: number;
  identifier: string;
  award: string;
  citation: string | null;
  status: RowStatus;
  reason: string | null;
  /** The resident's canonical key, when found. */
  userID: string | null;
  displayName: string | null;
  /** The live catalogue entry the award name matches, if any. */
  typeID: string | null;
  /** True when the name matches no live entry (it needs a decision). */
  isNew: boolean;
  /** The archived entry the name matches, offered under "Use existing". */
  archivedTypeID: string | null;
  /** normalizedName of the award, the key decisions use. */
  nameKey: string;
}

export interface ClassifyInput {
  rows: readonly ImportRow[];
  /** The resident for an identifier: canonical key and name, or null. */
  resident: (
    identifier: string,
  ) => { userID: string; displayName: string | null } | null;
  catalogue: readonly CatalogueEntry[];
  /** `${userID}|type:${id}` and `${userID}|name:${normalizedName}` of active awards held. */
  held: ReadonlySet<string>;
}

export const heldTypeKey = (userID: string, typeID: string) =>
  `${userID}|type:${typeID}`;
export const heldNameKey = (userID: string, name: string) =>
  `${userID}|name:${normalizeAwardName(name)}`;

/**
 * Give every row a status, in this order of precedence: Invalid (text), Not found
 * (no such resident), Duplicate (already held, or earlier in the file), else Ready.
 */
export function classifyRows(input: ClassifyInput): ClassifiedRow[] {
  const live = new Map(
    input.catalogue
      .filter((t) => !t.archived)
      .map((t) => [normalizeAwardName(t.name), t]),
  );
  const archived = new Map(
    input.catalogue
      .filter((t) => t.archived)
      .map((t) => [normalizeAwardName(t.name), t]),
  );
  const seen = new Map<string, number>();

  return input.rows.map((r, i): ClassifiedRow => {
    const row = i + 1;
    const award = r.award.trim();
    const nameKey = normalizeAwardName(award);
    const type = live.get(nameKey) ?? null;
    const old = type ? null : (archived.get(nameKey) ?? null);
    const citation = (r.citation ?? "").trim() || null;
    const base = {
      row,
      identifier: r.identifier.trim(),
      award,
      citation,
      userID: null,
      displayName: null,
      typeID: type?.id ?? null,
      isNew: type === null,
      archivedTypeID: old?.id ?? null,
      nameKey,
    };

    const bad = invalidReason(r);
    if (bad) return { ...base, status: "invalid", reason: bad };

    const person = input.resident(r.identifier.trim());
    if (!person) {
      return {
        ...base,
        status: "not_found",
        reason: "No resident matches that email or NUSNET id.",
      };
    }
    const withPerson = {
      ...base,
      userID: person.userID,
      displayName: person.displayName,
    };

    const held =
      (type && input.held.has(heldTypeKey(person.userID, type.id))) ||
      input.held.has(heldNameKey(person.userID, award));
    if (held) {
      return {
        ...withPerson,
        status: "duplicate",
        reason: "Already has this award for the year.",
      };
    }
    const key = `${person.userID}|${nameKey}`;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      return {
        ...withPerson,
        status: "duplicate",
        reason: `Listed earlier in the file (row ${earlier}).`,
      };
    }
    seen.set(key, row);
    return { ...withPerson, status: "ready", reason: null };
  });
}

export function countByStatus(
  rows: readonly { status: RowStatus }[],
): Record<RowStatus, number> {
  const out: Record<RowStatus, number> = {
    ready: 0,
    not_found: 0,
    duplicate: 0,
    invalid: 0,
  };
  for (const r of rows) out[r.status] += 1;
  return out;
}

/* ---- unknown award names and the decisions they need -------------------------------- */

export interface UnknownName {
  nameKey: string;
  /** The first spelling seen, used if a new award is created. */
  name: string;
  /** Rows that would be imported under this name. */
  rows: number;
  /** The archived entry of the same name, if any. */
  archivedTypeID: string | null;
}

/**
 * The distinct award names that match no live catalogue entry, among rows that
 * could still be imported (Ready ones that the user has not skipped).
 */
export function unknownNames(
  rows: readonly ClassifiedRow[],
  skipped: ReadonlySet<number> = new Set(),
): UnknownName[] {
  const out = new Map<string, UnknownName>();
  for (const r of rows) {
    if (r.status !== "ready" || !r.isNew || skipped.has(r.row)) continue;
    const entry = out.get(r.nameKey) ?? {
      nameKey: r.nameKey,
      name: r.award,
      rows: 0,
      archivedTypeID: r.archivedTypeID,
    };
    entry.rows += 1;
    out.set(r.nameKey, entry);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export type Decision =
  | { nameKey: string; action: "create" }
  | { nameKey: string; action: "existing"; awardTypeID: string };

/** Which unknown names still have no decision. */
export function undecided(
  unknown: readonly UnknownName[],
  decisions: readonly Decision[],
): UnknownName[] {
  const decided = new Set(decisions.map((d) => d.nameKey));
  return unknown.filter((u) => !decided.has(u.nameKey));
}

/** "Create new award" is not offered for a name an archived entry already holds. */
export const canCreate = (u: UnknownName) => u.archivedTypeID === null;

/** The citation a row gets: its own, else the matched award's default. */
export function effectiveCitation(
  rowCitation: string | null | undefined,
  defaultCitation: string | null | undefined,
): string | null {
  const own = (rowCitation ?? "").trim();
  if (own !== "") return own;
  const fallback = (defaultCitation ?? "").trim();
  return fallback === "" ? null : fallback;
}

/* ---- wording ------------------------------------------------------------------------------ */

export function previewSummaryLine(counts: Record<RowStatus, number>): string {
  const parts = (Object.keys(counts) as RowStatus[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${STATUS_LABEL[s]}`);
  return parts.length === 0 ? "No rows." : parts.join(", ");
}

export const importButtonLabel = (n: number) =>
  `Import ${n} ${n === 1 ? "row" : "rows"}`;

export const importSummaryLine = (imported: number, skipped: number) =>
  `${imported} imported, ${skipped} skipped`;

export const SKIPPED_BY_USER = "Skipped by you.";

/* ---- the procedures' inputs ------------------------------------------------------------ */

/** Lenient on purpose: a row that is wrong is reported as Invalid, not refused. */
const importRow = z.object({
  identifier: z.string().max(500),
  award: z.string().max(500),
  citation: z.string().max(5000).nullish(),
});

const importRows = z.array(importRow).max(MAX_IMPORT_ROWS, "TOO_MANY_ROWS");

export const awardImportPreviewInput = z.object({
  academicYear: academicYearInput,
  rows: importRows,
});

const decision = z.discriminatedUnion("action", [
  z.object({ nameKey: z.string().max(200), action: z.literal("create") }),
  z.object({
    nameKey: z.string().max(200),
    action: z.literal("existing"),
    awardTypeID: idInput.shape.id,
  }),
]);

export const awardImportCommitInput = z.object({
  academicYear: academicYearInput,
  fileName: z.string().max(200).optional(),
  rows: importRows,
  decisions: z.array(decision).max(MAX_IMPORT_ROWS),
  /** Rows (by number) the user chose to skip. */
  skipRows: z
    .array(z.number().int().positive())
    .max(MAX_IMPORT_ROWS)
    .optional(),
});
