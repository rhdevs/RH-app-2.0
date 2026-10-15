import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../../../app/admin/_lib/csv";
import {
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_ROWS,
  TEMPLATE_CSV,
  TEMPLATE_EXAMPLE,
  TEMPLATE_HEADER,
  TOO_MANY_ROWS_MESSAGE,
  awardImportCommitInput,
  awardImportPreviewInput,
  canCreate,
  classifyRows,
  countByStatus,
  effectiveCitation,
  guessImportColumn,
  guessMapping,
  heldNameKey,
  heldTypeKey,
  importButtonLabel,
  importSummaryLine,
  invalidReason,
  looksLikeHeader,
  mappingProblem,
  previewSummaryLine,
  rowsFromTable,
  undecided,
  unknownNames,
  type CatalogueEntry,
  type ImportRow,
} from "../awardImport";
import { errorText } from "../adminView";

const AY = "AY2026/27";
const ID = "0123456789abcdef01234567";

const catalogue: CatalogueEntry[] = [
  {
    id: "t1",
    name: "Full Colours",
    defaultCitation: "Default one.",
    archived: false,
  },
  {
    id: "t2",
    name: "Service Excellence Award",
    defaultCitation: null,
    archived: false,
  },
  { id: "t9", name: "Retired Award", defaultCitation: null, archived: true },
];
const PEOPLE: Record<string, { userID: string; displayName: string | null }> = {
  "a@u.nus.edu": { userID: "A", displayName: "Alice" },
  "b@u.nus.edu": { userID: "B", displayName: "Bob" },
  c: { userID: "C", displayName: null },
};

const classify = (
  rows: ImportRow[],
  held: string[] = [],
  cat: CatalogueEntry[] = catalogue,
) =>
  classifyRows({
    rows,
    resident: (id) => PEOPLE[id] ?? null,
    catalogue: cat,
    held: new Set(held),
  });

const row = (over: Partial<ImportRow> = {}): ImportRow => ({
  identifier: "a@u.nus.edu",
  award: "Full Colours",
  citation: "",
  ...over,
});

describe("row status", () => {
  it("is Ready for a known person and a catalogue award", () => {
    const [r] = classify([row()]);
    expect(r).toMatchObject({
      row: 1,
      status: "ready",
      reason: null,
      userID: "A",
      displayName: "Alice",
      typeID: "t1",
      isNew: false,
    });
  });

  it("is Not found when the identifier names nobody, with a reason", () => {
    const [r] = classify([row({ identifier: "nobody@u.nus.edu" })]);
    expect(r!.status).toBe("not_found");
    expect(r!.reason).toMatch(/No resident/);
    expect(r!.userID).toBeNull();
  });

  it("is Invalid for empty or over-long text and forbidden characters, each with its reason", () => {
    const reason = (over: Partial<ImportRow>) => classify([row(over)])[0]!;
    expect(reason({ award: "  " })).toMatchObject({
      status: "invalid",
      reason: "The award name is empty.",
    });
    expect(reason({ award: "x".repeat(81) }).reason).toBe(
      "The award name is longer than 80 characters.",
    );
    expect(reason({ citation: "x".repeat(301) }).reason).toBe(
      "The citation is longer than 300 characters.",
    );
    expect(reason({ identifier: "" }).reason).toBe("The identifier is empty.");
    for (const bad of ["a\u0000b", "a‮b", "x​y"]) {
      expect(reason({ award: bad }).reason).toBe(
        "Contains characters that are not allowed.",
      );
    }
    expect(reason({ citation: "line\nbreak" }).status).toBe("invalid");
    expect(reason({ citation: "x".repeat(300) }).status).toBe("ready");
  });

  it("checks the text before looking for the person: Invalid wins over Not found", () => {
    const [r] = classify([row({ identifier: "nobody@u.nus.edu", award: "" })]);
    expect(r!.status).toBe("invalid");
  });

  it("is a Duplicate when the person already holds the award, by entry or by name", () => {
    expect(classify([row()], [heldTypeKey("A", "t1")])[0]).toMatchObject({
      status: "duplicate",
      reason: "Already has this award for the year.",
    });
    expect(
      classify([row()], [heldNameKey("A", "  FULL   colours ")])[0]!.status,
    ).toBe("duplicate");
    expect(classify([row()], [heldTypeKey("B", "t1")])[0]!.status).toBe(
      "ready",
    );
    expect(classify([row()], [heldTypeKey("A", "t2")])[0]!.status).toBe(
      "ready",
    );
  });

  it("is a Duplicate when the same person and award appear earlier in the file", () => {
    const rows = classify([
      row(),
      row({ award: "  full   COLOURS" }),
      row({ identifier: "b@u.nus.edu" }),
      row({ award: "Service Excellence Award" }),
    ]);
    expect(rows.map((r) => r.status)).toEqual([
      "ready",
      "duplicate",
      "ready",
      "ready",
    ]);
    expect(rows[1]!.reason).toBe("Listed earlier in the file (row 1).");
  });

  it("does not count an invalid or not-found row as the earlier one", () => {
    const rows = classify([row({ citation: "x".repeat(301) }), row()]);
    expect(rows.map((r) => r.status)).toEqual(["invalid", "ready"]);
  });

  it("counts rows per status and words the summary", () => {
    const rows = classify([
      row(),
      row(),
      row({ identifier: "zz" }),
      row({ award: "" }),
    ]);
    const counts = countByStatus(rows);
    expect(counts).toEqual({
      ready: 1,
      duplicate: 1,
      not_found: 1,
      invalid: 1,
    });
    expect(previewSummaryLine(counts)).toBe(
      "1 Ready, 1 Not found, 1 Duplicate, 1 Invalid",
    );
    expect(previewSummaryLine(countByStatus([]))).toBe("No rows.");
  });

  it("numbers rows from 1 and keeps the order", () => {
    expect(classify([row(), row(), row()]).map((r) => r.row)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe("unknown and archived award names", () => {
  it("marks a name that matches no live entry as new, and matches by normalised name", () => {
    const rows = classify([
      row({ award: "  SERVICE   excellence award " }),
      row({ identifier: "b@u.nus.edu", award: "Hall Spirit Award" }),
    ]);
    expect(rows[0]).toMatchObject({ typeID: "t2", isNew: false });
    expect(rows[1]).toMatchObject({
      typeID: null,
      isNew: true,
      archivedTypeID: null,
    });
  });

  it("treats a name that matches an ARCHIVED entry as unknown, offering the archived one", () => {
    const [r] = classify([row({ award: "retired award" })]);
    expect(r).toMatchObject({
      isNew: true,
      typeID: null,
      archivedTypeID: "t9",
    });
  });

  it("lists each distinct unknown name once, with its row count, among importable rows", () => {
    const rows = classify([
      row({ award: "Hall Spirit Award" }),
      row({ identifier: "b@u.nus.edu", award: "hall  spirit award" }),
      row({ identifier: "c", award: "Other New" }),
      row({ identifier: "nobody", award: "Never Seen" }),
    ]);
    const unknown = unknownNames(rows);
    expect(unknown.map((u) => [u.name, u.rows])).toEqual([
      ["Hall Spirit Award", 2],
      ["Other New", 1],
    ]);
  });

  it("leaves out a name whose only rows the user skipped", () => {
    const rows = classify([row({ award: "Hall Spirit Award" })]);
    expect(unknownNames(rows, new Set([1]))).toEqual([]);
  });

  it("needs a decision for every unknown name before the import can run", () => {
    const rows = classify([
      row({ award: "Hall Spirit Award" }),
      row({ identifier: "b@u.nus.edu", award: "Retired Award" }),
    ]);
    const unknown = unknownNames(rows);
    expect(undecided(unknown, []).map((u) => u.name)).toEqual([
      "Hall Spirit Award",
      "Retired Award",
    ]);
    expect(
      undecided(unknown, [
        { nameKey: "hall spirit award", action: "create" },
      ]).map((u) => u.name),
    ).toEqual(["Retired Award"]);
    expect(
      undecided(unknown, [
        { nameKey: "hall spirit award", action: "create" },
        { nameKey: "retired award", action: "existing", awardTypeID: "t9" },
      ]),
    ).toEqual([]);
  });

  it("offers Create new only when no archived entry already has the name", () => {
    const [plain, archived] = unknownNames(
      classify([
        row({ award: "Hall Spirit Award" }),
        row({ identifier: "b@u.nus.edu", award: "Retired Award" }),
      ]),
    );
    expect(canCreate(plain!)).toBe(true);
    expect(canCreate(archived!)).toBe(false);
  });

  it("takes the row's citation, else the award's default", () => {
    expect(effectiveCitation("Mine", "Default")).toBe("Mine");
    expect(effectiveCitation("  ", "Default")).toBe("Default");
    expect(effectiveCitation(null, "Default")).toBe("Default");
    expect(effectiveCitation("", null)).toBeNull();
    expect(effectiveCitation(undefined, "  ")).toBeNull();
  });
});

describe("the template and the columns", () => {
  it("has the three headings and one made-up example row", () => {
    expect(TEMPLATE_HEADER).toBe("identifier,award,citation");
    const table = parseCsv(TEMPLATE_CSV);
    expect(table).toHaveLength(2);
    expect(table[0]).toEqual(["identifier", "award", "citation"]);
    expect(table[1]![0]).toMatch(/^e0000001@u\.nus\.edu$/);
    expect(TEMPLATE_EXAMPLE.split(",")).toHaveLength(3);
  });

  it("reads the template back as a Ready-shaped row", () => {
    const table = parseCsv(TEMPLATE_CSV);
    const mapping = guessMapping(table[0]!);
    expect(mappingProblem(mapping)).toBeNull();
    expect(rowsFromTable(table, mapping, true)).toEqual([
      {
        identifier: "e0000001@u.nus.edu",
        award: "Full Colours",
        citation: "For outstanding contribution to hall life",
      },
    ]);
  });

  it("maps headings named identifier, email, nusnet, award and citation by themselves", () => {
    for (const h of [
      "identifier",
      "Email",
      "E-mail",
      "NUSNET",
      "NUSNET ID",
      "nus net",
      "User ID",
      "ID",
    ]) {
      expect(guessImportColumn(h), h).toBe("identifier");
    }
    for (const h of ["award", "Award name", "Awards"]) {
      expect(guessImportColumn(h), h).toBe("award");
    }
    for (const h of ["citation", "Citations", "Remarks", "Reason"]) {
      expect(guessImportColumn(h), h).toBe("citation");
    }
    expect(guessImportColumn("Notes to self")).toBe("ignore");
    expect(guessMapping(["Email", "Award", "Citation", "Other"])).toEqual([
      "identifier",
      "award",
      "citation",
      "ignore",
    ]);
  });

  it("gives a role to only the first column that claims it", () => {
    expect(guessMapping(["email", "nusnet", "award"])).toEqual([
      "identifier",
      "ignore",
      "award",
    ]);
  });

  it("knows a heading row from a data row", () => {
    expect(looksLikeHeader(["identifier", "award", "citation"])).toBe(true);
    expect(looksLikeHeader(["Email", "Award"])).toBe(true);
    expect(looksLikeHeader(["e0000001@u.nus.edu", "Full Colours"])).toBe(false);
  });

  it("asks for exactly one identifier and one award column", () => {
    expect(mappingProblem(["identifier", "award", "citation"])).toBeNull();
    expect(mappingProblem(["identifier", "award", "ignore"])).toBeNull();
    expect(mappingProblem(["award", "citation"])).toMatch(/email or NUSNET/);
    expect(mappingProblem(["identifier", "identifier", "award"])).toMatch(
      /email or NUSNET/,
    );
    expect(mappingProblem(["identifier", "citation"])).toMatch(/award/);
    expect(
      mappingProblem(["identifier", "award", "citation", "citation"]),
    ).toMatch(/citation/);
  });

  it("builds rows by the mapping, trims, and drops blank rows", () => {
    const table = [
      ["Award", "Who", "Notes", "Citation"],
      [" Full Colours ", " a@u.nus.edu ", "x", " For work "],
      ["", "", "", ""],
      ["Service Excellence Award", "b@u.nus.edu"],
    ];
    expect(
      rowsFromTable(table, ["award", "identifier", "ignore", "citation"], true),
    ).toEqual([
      {
        identifier: "a@u.nus.edu",
        award: "Full Colours",
        citation: "For work",
      },
      {
        identifier: "b@u.nus.edu",
        award: "Service Excellence Award",
        citation: "",
      },
    ]);
    expect(
      rowsFromTable(
        table,
        ["award", "identifier", "ignore", "citation"],
        false,
      ),
    ).toHaveLength(3);
  });

  it("works without a citation column", () => {
    expect(
      rowsFromTable(
        [["a@u.nus.edu", "Full Colours"]],
        ["identifier", "award"],
        false,
      ),
    ).toEqual([
      { identifier: "a@u.nus.edu", award: "Full Colours", citation: "" },
    ]);
  });
});

describe("limits and wording", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      identifier: `e${i}@u.nus.edu`,
      award: "A",
    }));

  it("takes 2000 rows and refuses 2001 with the plain message", () => {
    expect(MAX_IMPORT_ROWS).toBe(2000);
    expect(
      awardImportPreviewInput.safeParse({ academicYear: AY, rows: rows(2000) })
        .success,
    ).toBe(true);
    const over = awardImportPreviewInput.safeParse({
      academicYear: AY,
      rows: rows(2001),
    });
    expect(over.success).toBe(false);
    expect(TOO_MANY_ROWS_MESSAGE).toBe(
      "This file has more than 2,000 rows. Split it and upload in parts.",
    );
    expect(errorText("TOO_MANY_ROWS")).toBe(TOO_MANY_ROWS_MESSAGE);
    expect(
      awardImportCommitInput.safeParse({
        academicYear: AY,
        rows: rows(2001),
        decisions: [],
      }).success,
    ).toBe(false);
  });

  it("does not refuse a wrong row: that is reported as Invalid, not as an error", () => {
    expect(
      awardImportPreviewInput.safeParse({
        academicYear: AY,
        rows: [
          { identifier: "", award: "x".repeat(400), citation: "y".repeat(400) },
        ],
      }).success,
    ).toBe(true);
  });

  it("takes a decision to create or to use an existing award, and nothing else", () => {
    const ok = (decisions: object[]) =>
      awardImportCommitInput.safeParse({
        academicYear: AY,
        rows: [],
        decisions,
      }).success;
    expect(ok([{ nameKey: "a", action: "create" }])).toBe(true);
    expect(ok([{ nameKey: "a", action: "existing", awardTypeID: ID }])).toBe(
      true,
    );
    expect(ok([{ nameKey: "a", action: "existing" }])).toBe(false);
    expect(ok([{ nameKey: "a", action: "unarchive" }])).toBe(false);
  });

  it("writes in chunks of 200", () => {
    expect(IMPORT_CHUNK_SIZE).toBe(200);
  });

  it("words the button and the summary", () => {
    expect(importButtonLabel(48)).toBe("Import 48 rows");
    expect(importButtonLabel(1)).toBe("Import 1 row");
    expect(importSummaryLine(48, 2)).toBe("48 imported, 2 skipped");
  });

  it("explains an undecided name on the server too", () => {
    expect(errorText("UNDECIDED_AWARD_NAMES")).toMatch(
      /Decide every new award/,
    );
  });

  it("keeps invalidReason for a clean row null", () => {
    expect(invalidReason(row())).toBeNull();
  });
});

describe("the sample file", () => {
  const table = parseCsv(readFileSync("scripts/dev/sample-awards.csv", "utf8"));
  const mapping = guessMapping(table[0]!);
  const rows = rowsFromTable(table, mapping, true);

  it("reads with the headings the template uses", () => {
    expect(table[0]).toEqual(["identifier", "award", "citation"]);
    expect(rows).toHaveLength(12);
  });

  it("classifies as designed: 8 Ready, 1 Not found, 2 Duplicate, 1 Invalid", () => {
    const seeded = new Map<
      string,
      { userID: string; displayName: string | null }
    >(
      Array.from({ length: 20 }, (_, i) => {
        const n = String(i + 1).padStart(2, "0");
        return [
          `seed-r${n}`,
          { userID: `SEED-R${n}`, displayName: `Seed ${n}` },
        ] as const;
      }),
    );
    const classified = classifyRows({
      rows,
      resident: (id) => seeded.get(id.replace(/@u\.nus\.edu$/, "")) ?? null,
      catalogue,
      // SEED-R13 already holds Full Colours (from the seeded upload).
      held: new Set([heldTypeKey("SEED-R13", "t1")]),
    });
    expect(countByStatus(classified)).toEqual({
      ready: 8,
      not_found: 1,
      duplicate: 2,
      invalid: 1,
    });
    expect(unknownNames(classified).map((u) => u.name)).toEqual([
      "Hall Spirit Award",
      "Retired Award",
    ]);
    expect(unknownNames(classified)[1]!.archivedTypeID).toBe("t9");
    expect(rows.every((r) => !/@(?!u\.nus\.edu)/.test(r.identifier))).toBe(
      true,
    );
  });
});
