import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { classifyRows } from "~/lib/transcript/awardImport";
import {
  ImportDoneView,
  ImportInputView,
  ImportMapView,
  ImportPreviewView,
  ImportProgressView,
  StatusChip,
  importableCount,
  type ImportDoneViewProps,
  type ImportInputViewProps,
  type ImportMapViewProps,
  type ImportPreviewData,
  type ImportPreviewViewProps,
} from "../awards/_components/AwardImport";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

const input = (over: Partial<ImportInputViewProps> = {}) =>
  renderToStaticMarkup(
    <ImportInputView
      text=""
      onText={noop}
      fileName={null}
      onFile={noop}
      onDownloadTemplate={noop}
      onContinue={noop}
      readOnly={false}
      error={null}
      {...over}
    />,
  );

describe("import: the file", () => {
  it("offers the template, a file upload and pasting", () => {
    const html = input();
    expect(html).toContain("Download template");
    expect(html).toContain('id="award-csv-file"');
    expect(html).toContain('accept=".csv,text/csv"');
    expect(html).toContain('id="award-csv-text"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  });

  it("enables Continue once there is text, and names the file", () => {
    const html = input({ text: "identifier,award", fileName: "awards.csv" });
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
    expect(html).toContain("(from awards.csv)");
  });

  it("is disabled in a published year", () => {
    const html = input({ readOnly: true, text: "x" });
    expect(html).toMatch(/id="award-csv-file"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue<\/button>/);
  });
});

const map = (over: Partial<ImportMapViewProps> = {}) =>
  renderToStaticMarkup(
    <ImportMapView
      table={[
        ["identifier", "award", "citation"],
        ["a@u.nus.edu", "Full Colours", ""],
      ]}
      hasHeader
      onHasHeader={noop}
      mapping={["identifier", "award", "citation"]}
      onMapping={noop}
      rowCount={1}
      onBack={noop}
      onPreview={noop}
      previewing={false}
      error={null}
      {...over}
    />,
  );

describe("import: the columns", () => {
  it("shows a selector per column with the guess chosen, and a sample", () => {
    const html = map();
    expect(html).toContain('id="map-0"');
    expect(html).toContain('id="map-2"');
    expect(html).toMatch(/<option value="identifier" selected="">/);
    expect(html).toContain("a@u.nus.edu");
    expect(html).toContain("1 row found.");
    expect(html).toContain("The first row is a heading");
  });

  it("will not preview until an identifier and an award column are chosen", () => {
    const html = map({ mapping: ["identifier", "ignore", "ignore"] });
    expect(html).toContain("Choose exactly one column for the award.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preview<\/button>/);
    expect(map()).not.toMatch(/<button[^>]*disabled=""[^>]*>Preview<\/button>/);
  });

  it("refuses more than 2,000 rows with the plain message", () => {
    const html = map({ rowCount: 2001 });
    expect(html).toContain(
      "This file has more than 2,000 rows. Split it and upload in parts.",
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preview<\/button>/);
  });
});

/* ---- the preview ---------------------------------------------------------------- */

const rows = classifyRows({
  rows: [
    { identifier: "a", award: "Full Colours", citation: "" },
    { identifier: "b", award: "Hall Spirit Award", citation: "For spirit." },
    { identifier: "c", award: "Retired Award", citation: "" },
    { identifier: "nobody", award: "Full Colours", citation: "" },
    { identifier: "a", award: "full colours", citation: "" },
    { identifier: "d", award: "", citation: "" },
  ],
  resident: (id) =>
    (
      ({
        a: { userID: "A", displayName: "Alice" },
        b: { userID: "B", displayName: "Bob" },
        c: { userID: "C", displayName: "Cara" },
        d: { userID: "D", displayName: null },
      }) as Record<string, { userID: string; displayName: string | null }>
    )[id] ?? null,
  catalogue: [
    { id: "t1", name: "Full Colours", defaultCitation: null, archived: false },
    { id: "t9", name: "Retired Award", defaultCitation: null, archived: true },
  ],
  held: new Set(),
});

const data: ImportPreviewData = {
  rows,
  counts: { ready: 3, not_found: 1, duplicate: 1, invalid: 1 },
  unknown: [],
  types: [{ id: "t1", name: "Full Colours", archived: false }],
  archivedTypes: [{ id: "t9", name: "Retired Award", archived: true }],
};

const preview = (over: Partial<ImportPreviewViewProps> = {}) =>
  renderToStaticMarkup(
    <ImportPreviewView
      preview={data}
      skipped={new Set()}
      onSkip={noop}
      decisions={[]}
      onDecision={noop}
      onBack={noop}
      onImport={noop}
      importing={false}
      error={null}
      {...over}
    />,
  );

describe("import: the preview", () => {
  it("counts rows per status, in words as well as colour", () => {
    const html = preview();
    expect(html).toContain("3 Ready, 1 Not found, 1 Duplicate, 1 Invalid");
    for (const word of ["Ready", "Not found", "Duplicate", "Invalid"]) {
      expect(html).toContain(`>${word}<`);
    }
  });

  it("shows a reason for every row that is not Ready", () => {
    const html = preview();
    expect(html).toContain("No resident matches that email or NUSNET id.");
    expect(html).toContain("Listed earlier in the file (row 1).");
    expect(html).toContain("The award name is empty.");
  });

  it("offers a Skip toggle on Ready rows only", () => {
    const html = preview();
    expect((html.match(/aria-label="Skip row \d+"/g) ?? []).length).toBe(3);
    expect(html).not.toContain('aria-label="Skip row 4"');
  });

  it("lists each unknown name in a Decide unknown awards panel", () => {
    const html = preview();
    expect(html).toContain("Decide unknown awards");
    expect(html).toContain("Hall Spirit Award");
    expect(html).toContain("Retired Award");
    expect(html).toContain("2 unknown awards need a decision.");
  });

  it("offers Create only for a name no archived award holds, and labels archived awards", () => {
    const html = preview();
    const at = (id: string) => html.indexOf(`id="decide-${id}"`);
    expect(
      html.slice(at("hall spirit award"), at("hall spirit award") + 600),
    ).toContain("Create new award");
    expect(
      html.slice(at("retired award"), at("retired award") + 700),
    ).not.toContain("Create new award");
    expect(html).toContain("Retired Award (archived)");
    expect(html).toContain("Using it does not unarchive it.");
  });

  it("keeps Import disabled until every unknown name is decided", () => {
    const disabled = (html: string) =>
      /<button[^>]*disabled=""[^>]*>Import \d+ rows?<\/button>/.test(html);
    expect(disabled(preview())).toBe(true);
    expect(
      disabled(
        preview({
          decisions: [{ nameKey: "hall spirit award", action: "create" }],
        }),
      ),
    ).toBe(true);
    const all = preview({
      decisions: [
        { nameKey: "hall spirit award", action: "create" },
        { nameKey: "retired award", action: "existing", awardTypeID: "t9" },
      ],
    });
    expect(disabled(all)).toBe(false);
    expect(all).toContain("Import 3 rows");
  });

  it("does not ask about a name whose rows were all skipped, and counts only importable rows", () => {
    const html = preview({ skipped: new Set([2]) });
    expect(html).toContain("1 unknown award needs a decision.");
    expect(importableCount(rows, new Set([2]))).toBe(2);
    expect(importableCount(rows, new Set([1, 2, 3]))).toBe(0);
  });

  it("marks a new award on its row and shows the citation", () => {
    const html = preview();
    expect(html).toContain("New award");
    expect(html).toContain("For spirit.");
  });

  it("shows an error from the import, and a spinner while importing", () => {
    expect(preview({ error: "Nope." })).toContain('role="alert"');
    expect(preview({ importing: true })).toContain("Importing");
  });
});

describe("import: progress and the summary", () => {
  it("says how many rows are being written, in chunks of 200", () => {
    const html = renderToStaticMarkup(<ImportProgressView rows={48} />);
    expect(html).toContain("Importing 48 rows, 200 at a time.");
    expect(html).toContain('role="progressbar"');
  });

  const done = (over: Partial<ImportDoneViewProps> = {}) =>
    renderToStaticMarkup(
      <ImportDoneView
        result={{
          batchId: "b1",
          imported: 48,
          skipped: [
            {
              row: 3,
              identifier: "x",
              award: "Full Colours",
              reason: "Already has this award for the year.",
            },
            {
              row: 9,
              identifier: "y",
              award: "Full Colours",
              reason: "No resident matches that email or NUSNET id.",
            },
          ],
          created: ["Hall Spirit Award"],
        }}
        onHistory={noop}
        onAnother={noop}
        {...over}
      />,
    );

  it("gives the counts, the skipped rows with reasons, and the way to History", () => {
    const html = done();
    expect(html).toContain("48 imported, 2 skipped");
    expect(html).toContain("Already has this award for the year.");
    expect(html).toContain("No resident matches that email or NUSNET id.");
    expect(html).toContain("Added to the catalogue: Hall Spirit Award.");
    expect(html).toContain("See it in History");
    expect(html).toContain("Upload another file");
  });

  it("has no skipped table when nothing was skipped", () => {
    const html = done({
      result: { batchId: "b", imported: 5, skipped: [], created: [] },
    });
    expect(html).toContain("5 imported, 0 skipped");
    expect(html).not.toContain("Why it was skipped");
  });

  it("renders a status chip with its word", () => {
    expect(renderToStaticMarkup(<StatusChip status="not_found" />)).toContain(
      "Not found",
    );
  });
});
