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
  /* @vite-ignore */ load("create-disposable-reminder-indexes.mjs")
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

const MODEL = "DisposableRequest";
const REMINDER_MODELS = ["ReminderBroadcast", "ReminderTarget"] as const;
const ALL_NAMES = Object.keys(TARGETS).flatMap((m) =>
  TARGETS[m]!.map((i) => `${m}.${i.name}`),
);
const PROPOSAL_INDEX = {
  name: "disposable_request_proposal_unique",
  key: { proposalID: 1 },
  unique: true,
  partialFilterExpression: { proposalID: { $gt: "" } },
};

describe("create-disposable-reminder-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("targets the three collections of phase 4", () => {
    expect(Object.keys(TARGETS)).toEqual([MODEL, ...REMINDER_MODELS]);
  });

  it.each(REMINDER_MODELS)(
    "%s: every schema index is in TARGETS, with the same keys and uniqueness, and no academicYear",
    (model) => {
      const declared = schemaIndexes(modelBody(model));
      expect(declared.length).toBeGreaterThan(0);
      expect(shape(TARGETS[model]!)).toEqual(shape(declared));
      expect(modelBody(model)).not.toMatch(/academicYear/);
      expect(
        TARGETS[model]!.some((i) => i.expireAfterSeconds !== undefined),
      ).toBe(false);
    },
  );

  it("the target pair is unique, which is what keeps one row per CCA per broadcast", () => {
    expect(
      TARGETS.ReminderTarget!.find(
        (i) => i.name === "reminder_target_broadcast_cca",
      ),
    ).toEqual({
      name: "reminder_target_broadcast_cca",
      key: { broadcastID: 1, ccaID: 1 },
      unique: true,
    });
  });

  it("the schema's indexes are all in TARGETS, with the same keys and uniqueness", () => {
    const declared = schemaIndexes(modelBody(MODEL));
    expect(declared.length).toBeGreaterThan(0);
    const scripted = TARGETS[MODEL]!.filter(
      (i) => i.name !== PROPOSAL_INDEX.name,
    );
    expect(shape(scripted)).toEqual(shape(declared));
  });

  it("the proposal link is a partial unique index the schema does not declare", () => {
    expect(TARGETS[MODEL]!.find((i) => i.name === PROPOSAL_INDEX.name)).toEqual(
      PROPOSAL_INDEX,
    );
    expect(modelBody(MODEL)).not.toContain(PROPOSAL_INDEX.name);
    expect(modelBody(MODEL)).toMatch(/proposalID +String[?]/);
  });

  it("no index expires, and the model has no academicYear", () => {
    expect(
      TARGETS[MODEL]!.some((i) => i.expireAfterSeconds !== undefined),
    ).toBe(false);
    expect(modelBody(MODEL)).not.toMatch(/academicYear/);
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

describe("running the disposable script", () => {
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
    script: "create-disposable-reminder-indexes.mjs",
    label: "disposable",
  };

  it("a dry run writes nothing", async () => {
    const { db, writes } = fakeDb();

    const res = await apply(db, false, TARGETS, labels);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("--commit creates every index and sends the partial filter", async () => {
    const { db, store } = fakeDb();

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(false);
    expect(res.created.sort()).toEqual([...ALL_NAMES].sort());
    expect(
      (store.get(MODEL) ?? []).find((s) => s.name === PROPOSAL_INDEX.name),
    ).toEqual({
      key: { proposalID: 1 },
      name: PROPOSAL_INDEX.name,
      unique: true,
      partialFilterExpression: { proposalID: { $gt: "" } },
    });
  });

  it("refuses an existing proposal index that is not partial", async () => {
    const { db, writes, store } = fakeDb();
    store.set(MODEL, [
      { key: { proposalID: 1 }, name: PROPOSAL_INDEX.name, unique: true },
    ]);

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(true);
    expect(writes).toEqual([]);
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
    store.set(MODEL, [
      {
        key: { collectionDay: 1, ccaID: 1 },
        name: "disposable_request_cca_day",
      },
    ]);

    const res = await apply(db, true, TARGETS, labels);

    expect(res.aborted).toBe(true);
    expect(writes).toEqual([]);
  });
});
