import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The production index script, imported without running it. It is loaded by
// path so the type checker does not read the plain .mjs file.
const script = pathToFileURL(
  join(
    process.cwd(),
    "scripts",
    "remediation",
    "create-transcript-indexes.mjs",
  ),
).href;
const { TARGETS, classify, apply } = (await import(
  /* @vite-ignore */ script
)) as {
  TARGETS: Record<string, Index[]>;
  apply: (
    db: { $runCommandRaw: (cmd: Record<string, unknown>) => Promise<unknown> },
    commit: boolean,
    targets?: Record<string, Index[]>,
  ) => Promise<{ aborted: boolean; created: string[] }>;
  classify: (
    want: Index,
    existing: Array<Record<string, unknown>>,
  ) => { status: string; note: string };
};

type Index = { name: string; key: Record<string, number>; unique: boolean };

const schema = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
).replace(/\r\n/g, "\n");

/** The transcript models: from `model TranscriptPeriod` to the end of the file. */
const transcriptPart = schema.slice(schema.indexOf("model TranscriptPeriod {"));

function modelBlocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^model (\w+) \{\n([\s\S]*?)^\}/gm)) {
    out.set(m[1]!, m[2]!);
  }
  return out;
}

const fields = (list: string) =>
  list
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

/** Every index the schema declares on a model: @unique, @@unique and @@index. */
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
        key: Object.fromEntries(fields(block[2]!).map((f) => [f, 1])),
        unique: block[1] === "unique",
      });
    }
  }
  return found;
}

const models = modelBlocks(transcriptPart);
const fromSchema = new Map(
  [...models].map(([name, body]) => [name, schemaIndexes(body)] as const),
);
const withIndexes = [...fromSchema].filter(([, list]) => list.length > 0);

const shape = (list: Index[]) =>
  [...list].map((i) => `${i.name} ${JSON.stringify(i.key)} ${i.unique}`).sort();

describe("create-transcript-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("finds the transcript models, and the script has exactly the indexes the schema declares", () => {
    expect(models.has("TranscriptPeriod")).toBe(true);
    expect(models.has("ResidentEvent")).toBe(true);
    expect(models.has("User")).toBe(false);
    const declared = withIndexes.reduce((n, [, list]) => n + list.length, 0);
    const scripted = Object.values(TARGETS).reduce((n, l) => n + l.length, 0);
    expect(declared).toBeGreaterThan(0);
    expect(scripted).toBe(declared);
  });

  it("targets exactly the transcript collections that have indexes, and no other", () => {
    expect(Object.keys(TARGETS).sort()).toEqual(
      withIndexes.map(([name]) => name).sort(),
    );
    for (const name of Object.keys(TARGETS)) {
      expect(models.has(name)).toBe(true);
    }
  });

  it.each(withIndexes)(
    "%s: same index names, keys, key order and uniqueness",
    (name, list) => {
      expect(shape(TARGETS[name]!)).toEqual(shape(list));
    },
  );

  it("includes the activeKey uniques that make unlock and withhold idempotent", () => {
    expect(TARGETS.ResidentUnlock).toContainEqual({
      name: "unlock_active_key",
      key: { activeKey: 1 },
      unique: true,
    });
    expect(TARGETS.ResidentWithhold).toContainEqual({
      name: "withhold_active_key",
      key: { activeKey: 1 },
      unique: true,
    });
  });

  it("includes the unique key that stops an award being stored twice", () => {
    expect(TARGETS.Award).toContainEqual({
      name: "award_active_key",
      key: { activeKey: 1 },
      unique: true,
    });
  });

  it("never names a non-transcript collection", () => {
    for (const name of [
      "User",
      "CCA",
      "UserCCA",
      "CcaProfile",
      "CcaApplication",
    ]) {
      expect(TARGETS).not.toHaveProperty(name);
    }
  });
});

describe("classify", () => {
  const want = {
    name: "freeze_year_cca",
    key: { academicYear: 1, ccaID: 1 },
    unique: true,
  };
  const listed = (over: Record<string, unknown> = {}) => ({
    v: 2,
    key: { academicYear: 1, ccaID: 1 },
    name: "freeze_year_cca",
    unique: true,
    ...over,
  });

  it("is missing when nothing matches", () => {
    expect(
      classify(want, [{ v: 2, key: { _id: 1 }, name: "_id_" }]).status,
    ).toBe("missing");
  });

  it("is present for the identical index, and for the same key under another name", () => {
    expect(classify(want, [listed()]).status).toBe("present");
    expect(classify(want, [listed({ name: "other" })]).status).toBe("present");
  });

  it("is a conflict for the same name with another key, uniqueness or option", () => {
    expect(
      classify(want, [listed({ key: { ccaID: 1, academicYear: 1 } })]).status,
    ).toBe("conflict");
    expect(classify(want, [listed({ unique: undefined })]).status).toBe(
      "conflict",
    );
    expect(
      classify(want, [listed({ collation: { locale: "en" } })]).status,
    ).toBe("conflict");
  });

  it("is a conflict for the same key under another name with another uniqueness", () => {
    expect(
      classify(want, [listed({ name: "other", unique: undefined })]).status,
    ).toBe("conflict");
  });
});

/* ---- the run itself, against a fake command runner ----------------------- */

type Listed = Record<string, unknown>;
interface FakeCollection {
  absent?: boolean;
  indexes: Listed[];
  /** The duplicate pre-check finds rows that already violate uniqueness. */
  duplicates?: boolean;
}

function fakeDb(state: Record<string, FakeCollection>) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    $runCommandRaw: (cmd: Record<string, unknown>) => {
      if (typeof cmd.listIndexes === "string") {
        const c = state[cmd.listIndexes];
        if (!c || c.absent) {
          return Promise.resolve({
            ok: 0,
            code: 26,
            errmsg: "ns does not exist",
          });
        }
        return Promise.resolve({
          ok: 1,
          cursor: {
            firstBatch: [{ v: 2, key: { _id: 1 }, name: "_id_" }, ...c.indexes],
          },
        });
      }
      if (typeof cmd.aggregate === "string") {
        const c = state[cmd.aggregate];
        return Promise.resolve({
          ok: 1,
          cursor: {
            id: 0,
            firstBatch: c?.duplicates ? [{ _id: { x: "dup" }, n: 2 }] : [],
          },
        });
      }
      if (typeof cmd.create === "string") {
        writes.push(cmd);
        state[cmd.create] = {
          indexes: [],
          ...state[cmd.create],
          absent: false,
        };
        return Promise.resolve({ ok: 1 });
      }
      if (typeof cmd.createIndexes === "string") {
        writes.push(cmd);
        const c = (state[cmd.createIndexes] ??= { indexes: [] });
        c.absent = false;
        for (const ix of cmd.indexes as Listed[]) {
          c.indexes.push({ v: 2, ...ix });
        }
        return Promise.resolve({ ok: 1 });
      }
      return Promise.resolve({ ok: 0, code: 59, errmsg: "no such command" });
    },
  };
  return { db, writes, state };
}

const SMALL: Record<string, Index[]> = {
  Thing: [
    { name: "thing_u", key: { x: 1 }, unique: true },
    { name: "thing_i", key: { y: 1 }, unique: false },
  ],
};

describe("running the index script (against a fake database)", () => {
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

  it("a dry run writes nothing, and says what it would create", async () => {
    const { db, writes } = fakeDb({ Thing: { absent: true, indexes: [] } });

    const result = await apply(db, false, SMALL);

    expect(result).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("refuses a conflicting index before writing anything, even with --commit", async () => {
    const { db, writes } = fakeDb({
      Thing: {
        indexes: [{ key: { y: 1, z: 1 }, name: "thing_i" }],
      },
    });

    const result = await apply(db, true, SMALL);

    expect(result.aborted).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(writes).toEqual([]);
  });

  it("refuses to build a unique index over rows that already break it", async () => {
    const { db, writes } = fakeDb({ Thing: { indexes: [], duplicates: true } });

    const result = await apply(db, true, SMALL);

    expect(result.aborted).toBe(true);
    expect(writes).toEqual([]);
  });

  it("--commit creates only the missing indexes, then verifies, and a second run changes nothing", async () => {
    const { db, writes, state } = fakeDb({
      Thing: { indexes: [{ key: { y: 1 }, name: "thing_i" }] },
    });

    const first = await apply(db, true, SMALL);

    expect(first).toEqual({ aborted: false, created: ["Thing.thing_u"] });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      createIndexes: "Thing",
      indexes: [{ key: { x: 1 }, name: "thing_u", unique: true }],
    });
    expect(state.Thing!.indexes).toHaveLength(2);

    writes.length = 0;
    const second = await apply(db, true, SMALL);
    expect(second).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("creates the collection first when it is absent", async () => {
    const { db, writes } = fakeDb({ Thing: { absent: true, indexes: [] } });

    const result = await apply(db, true, SMALL);

    expect(result.created).toEqual(["Thing.thing_u", "Thing.thing_i"]);
    expect(writes.map((w) => Object.keys(w)[0])).toEqual([
      "create",
      "createIndexes",
    ]);
  });
});
