import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Index = {
  name: string;
  key: Record<string, number>;
  unique: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
};
type Fake = {
  $runCommandRaw: (c: Record<string, unknown>) => Promise<unknown>;
};

// Loaded by path so the type checker does not read the plain .mjs files.
const load = (file: string) =>
  pathToFileURL(join(process.cwd(), "scripts", "remediation", file)).href;
const { TARGETS } = (await import(
  /* @vite-ignore */ load("create-milestone-indexes.mjs")
)) as { TARGETS: Record<string, Index[]> };
const { apply } = (await import(
  /* @vite-ignore */ load("create-transcript-indexes.mjs")
)) as {
  apply: (
    db: Fake,
    commit: boolean,
    targets: Record<string, Index[]>,
    labels?: { script: string; label: string },
  ) => Promise<{ aborted: boolean; created: string[] }>;
};

const schema = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
).replace(/\r\n/g, "\n");

function modelBody(name: string): string {
  const head = `model ${name} {\n`;
  const start = schema.indexOf(head);
  if (start < 0) throw new Error(`model ${name} not found`);
  const from = start + head.length;
  return schema.slice(from, schema.indexOf("\n}", from));
}

function schemaIndexes(body: string): Index[] {
  const found: Index[] = [];
  for (const line of body.split("\n")) {
    const field = /^\s+(\w+)\s+\S+.*@unique\(map:\s*"([^"]+)"\)/.exec(line);
    if (field) {
      found.push({ name: field[2]!, key: { [field[1]!]: 1 }, unique: true });
    }
    const block = /@@(unique|index)\(\[([^\]]+)\],\s*map:\s*"([^"]+)"\)/.exec(
      line,
    );
    if (block) {
      found.push({
        name: block[3]!,
        key: Object.fromEntries(block[2]!.split(",").map((f) => [f.trim(), 1])),
        unique: block[1] === "unique",
      });
    }
  }
  return found;
}

const shape = (list: Index[]) =>
  list.map((i) => `${i.name} ${JSON.stringify(i.key)} ${i.unique}`).sort();

const MODEL = "MilestoneEvidence";
const FILING_MODELS = ["MilestoneSubmission", "MilestoneAssessment"] as const;
const ALL_NAMES = Object.keys(TARGETS).flatMap((m) =>
  TARGETS[m]!.map((i) => `${m}.${i.name}`),
);

describe("create-milestone-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("targets the evidence collection and the two PR 16 collections", () => {
    expect(Object.keys(TARGETS).sort()).toEqual(
      [MODEL, ...FILING_MODELS].sort(),
    );
  });

  it("every schema index is in TARGETS, with the same keys and uniqueness", () => {
    for (const model of [MODEL, ...FILING_MODELS]) {
      const declared = schemaIndexes(modelBody(model));
      expect(declared.length).toBeGreaterThan(0);
      expect(shape(TARGETS[model]!)).toEqual(shape(declared));
    }
  });

  it("one filing per milestone and one rating per filing are unique", () => {
    expect(
      TARGETS.MilestoneSubmission!.find(
        (i) => i.name === "milestone_submission_key",
      ),
    ).toEqual({
      name: "milestone_submission_key",
      key: { milestoneKey: 1 },
      unique: true,
    });
    expect(TARGETS.MilestoneAssessment).toEqual([
      {
        name: "milestone_assessment_submission",
        key: { submissionID: 1 },
        unique: true,
      },
    ]);
  });

  it("the pathname is unique, so one blob is one row", () => {
    expect(
      TARGETS[MODEL]!.find((i) => i.name === "milestone_evidence_pathname"),
    ).toEqual({
      name: "milestone_evidence_pathname",
      key: { pathname: 1 },
      unique: true,
    });
  });

  it("no index expires, and the model has no academicYear", () => {
    expect(
      Object.values(TARGETS).some((list) =>
        list.some((i) => i.expireAfterSeconds !== undefined),
      ),
    ).toBe(false);
    for (const model of [MODEL, ...FILING_MODELS]) {
      expect(modelBody(model)).not.toMatch(/academicYear/);
    }
  });

  it("the evidence stores a pathname and no address", () => {
    expect(modelBody(MODEL)).toMatch(/^\s+pathname\s+String$/m);
    expect(modelBody(MODEL)).not.toMatch(/^\s+(url|downloadUrl)\s/m);
  });
});

/* ---- the script against a fake command runner ----------------------------- */

type Listed = Record<string, unknown>;

function fakeDb() {
  const writes: Array<Record<string, unknown>> = [];
  const store = new Map<string, Listed[]>();
  const db: Fake = {
    $runCommandRaw: (cmd) => {
      if (typeof cmd.listIndexes === "string") {
        const have = store.get(cmd.listIndexes);
        return Promise.resolve(
          have === undefined
            ? { ok: 0, code: 26, errmsg: "ns does not exist" }
            : {
                ok: 1,
                cursor: {
                  firstBatch: [
                    { v: 2, key: { _id: 1 }, name: "_id_" },
                    ...have,
                  ],
                },
              },
        );
      }
      if (typeof cmd.create === "string") {
        writes.push(cmd);
        if (!store.has(cmd.create)) store.set(cmd.create, []);
        return Promise.resolve({ ok: 1 });
      }
      if (typeof cmd.createIndexes === "string") {
        writes.push(cmd);
        store.set(cmd.createIndexes, [
          ...(store.get(cmd.createIndexes) ?? []),
          ...(cmd.indexes as Listed[]),
        ]);
        return Promise.resolve({ ok: 1 });
      }
      return Promise.resolve({ ok: 0, code: 59, errmsg: "no such command" });
    },
  };
  return { db, writes, store };
}

describe("running the milestone script", () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  const labels = {
    script: "create-milestone-indexes.mjs",
    label: "milestone",
  };

  it("a dry run writes nothing", async () => {
    const { db, writes } = fakeDb();

    const res = await apply(db, false, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("--commit creates every index", async () => {
    const { db } = fakeDb();

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(false);
    expect(res.created.sort()).toEqual([...ALL_NAMES].sort());
  });

  it("a second run finds everything present and writes nothing", async () => {
    const { db, writes } = fakeDb();
    await apply(db, true, TARGETS, labels);
    writes.length = 0;

    const res = await apply(db, true, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("refuses, and writes nothing, when the pathname index exists but is not unique", async () => {
    const { db, writes, store } = fakeDb();
    store.set(MODEL, [
      { key: { pathname: 1 }, name: "milestone_evidence_pathname" },
    ]);

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(true);
    expect(writes).toEqual([]);
  });
});
