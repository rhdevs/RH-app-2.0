import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Index = {
  name: string;
  key: Record<string, number>;
  unique: boolean;
  expireAfterSeconds?: number;
};
type Fake = {
  $runCommandRaw: (c: Record<string, unknown>) => Promise<unknown>;
};

// Loaded by path so the type checker does not read the plain .mjs files.
const load = (file: string) =>
  pathToFileURL(join(process.cwd(), "scripts", "remediation", file)).href;
const { TARGETS } = (await import(
  /* @vite-ignore */ load("create-proposal-indexes.mjs")
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

const MODELS = [
  "Proposal",
  "ProposalStatusHistory",
  "ProposalComment",
  "ProposalCommentRead",
];

describe("create-proposal-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("targets exactly the four proposal collections", () => {
    expect(Object.keys(TARGETS)).toEqual(MODELS);
  });

  it.each(MODELS)(
    "%s: same index names, keys and uniqueness as the schema, and no others",
    (model) => {
      const declared = schemaIndexes(modelBody(model));
      expect(declared.length).toBeGreaterThan(0);
      expect(shape(TARGETS[model]!)).toEqual(shape(declared));
      expect(
        TARGETS[model]!.some((i) => i.expireAfterSeconds !== undefined),
      ).toBe(false);
    },
  );

  it.each(MODELS)("%s never has a field named academicYear", (model) => {
    expect(modelBody(model)).not.toMatch(/\bacademicYear\b/);
  });

  it("the one unique index is the per-person read marker", () => {
    const unique = Object.values(TARGETS)
      .flat()
      .filter((i) => i.unique)
      .map((i) => i.name);
    expect(unique).toEqual(["proposal_comment_read_unique"]);
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

describe("running the proposal script", () => {
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

  const labels = { script: "create-proposal-indexes.mjs", label: "proposal" };

  it("a dry run writes nothing", async () => {
    const { db, writes } = fakeDb();

    const res = await apply(db, false, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("--commit creates every index, the unique one marked unique", async () => {
    const { db, store } = fakeDb();

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(false);
    expect(res.created.sort()).toEqual(
      Object.entries(TARGETS)
        .flatMap(([model, list]) => list.map((i) => `${model}.${i.name}`))
        .sort(),
    );
    const read = store.get("ProposalCommentRead") ?? [];
    expect(read.find((s) => s.name === "proposal_comment_read_unique")).toEqual(
      {
        key: { proposalID: 1, userID: 1 },
        name: "proposal_comment_read_unique",
        unique: true,
      },
    );
  });

  it("a second run finds everything present and writes nothing", async () => {
    const { db, writes } = fakeDb();
    await apply(db, true, TARGETS, labels);
    writes.length = 0;

    const res = await apply(db, true, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("refuses, and writes nothing, when a same-named index has a different key", async () => {
    const { db, writes, store } = fakeDb();
    store.set("Proposal", [
      { key: { createdBy: 1, ccaID: 1 }, name: "proposal_creator" },
    ]);

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(true);
    expect(writes).toEqual([]);
  });
});
