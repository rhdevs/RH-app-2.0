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
  /* @vite-ignore */ load("create-calendar-feed-indexes.mjs")
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

describe("create-calendar-feed-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("targets the one calendar collection", () => {
    expect(Object.keys(TARGETS)).toEqual(["CalendarFeedToken"]);
  });

  it("has the same index names, keys and uniqueness as the schema, and no others", () => {
    const declared = schemaIndexes(modelBody("CalendarFeedToken"));
    expect(declared).toHaveLength(2);
    expect(shape(TARGETS.CalendarFeedToken!)).toEqual(shape(declared));
  });

  it("both indexes are plain unique ones: one token per person, one owner per hash", () => {
    expect(TARGETS.CalendarFeedToken).toEqual([
      { name: "calendar_feed_user", key: { userID: 1 }, unique: true },
      { name: "calendar_feed_hash", key: { tokenHash: 1 }, unique: true },
    ]);
  });

  it("never has a field named academicYear, and stores no token", () => {
    const body = modelBody("CalendarFeedToken").replace(/\/\/.*$/gm, "");
    expect(body).not.toMatch(/\bacademicYear\b/);
    expect(body).toMatch(/\btokenHash\s+String\b/);
    expect(body).not.toMatch(/^\s+token\s/m);
  });
});

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

describe("running the calendar feed script", () => {
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
    script: "create-calendar-feed-indexes.mjs",
    label: "calendar feed",
  };

  it("a dry run writes nothing", async () => {
    const { db, writes } = fakeDb();

    const res = await apply(db, false, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("--commit creates both indexes, marked unique", async () => {
    const { db, store } = fakeDb();

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(false);
    expect(res.created.sort()).toEqual([
      "CalendarFeedToken.calendar_feed_hash",
      "CalendarFeedToken.calendar_feed_user",
    ]);
    expect(
      (store.get("CalendarFeedToken") ?? []).map((s) => [s.name, s.unique]),
    ).toEqual([
      ["calendar_feed_user", true],
      ["calendar_feed_hash", true],
    ]);
  });

  it("a second run finds everything present and writes nothing", async () => {
    const { db, writes } = fakeDb();
    await apply(db, true, TARGETS, labels);
    writes.length = 0;

    const res = await apply(db, true, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("refuses, and writes nothing, when the hash index exists but is not unique", async () => {
    const { db, writes, store } = fakeDb();
    store.set("CalendarFeedToken", [
      { key: { tokenHash: 1 }, name: "calendar_feed_hash", unique: false },
    ]);

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(true);
    expect(writes).toEqual([]);
  });
});
