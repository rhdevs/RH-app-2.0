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
  /* @vite-ignore */ load("create-notification-indexes.mjs")
)) as { TARGETS: Record<string, Index[]> };
const { apply, classify } = (await import(
  /* @vite-ignore */ load("create-transcript-indexes.mjs")
)) as {
  apply: (
    db: Fake,
    commit: boolean,
    targets: Record<string, Index[]>,
  ) => Promise<{ aborted: boolean; created: string[] }>;
  classify: (
    want: Index,
    existing: Array<Record<string, unknown>>,
  ) => { status: string; note: string };
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

const TTL_NAME = "notification_expiry";
const body = modelBody("Notification");

describe("create-notification-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("targets only Notification", () => {
    expect(Object.keys(TARGETS)).toEqual(["Notification"]);
  });

  it("has every index the schema declares, with the same names, keys and uniqueness", () => {
    const plain = TARGETS.Notification!.filter(
      (i) => i.expireAfterSeconds === undefined,
    );
    expect(shape(plain)).toEqual(shape(schemaIndexes(body)));
    expect(plain.length).toBeGreaterThan(0);
  });

  it("adds exactly one more: the expiry index Prisma cannot express", () => {
    const extra = TARGETS.Notification!.filter(
      (i) => i.expireAfterSeconds !== undefined,
    );
    expect(extra).toEqual([
      {
        name: TTL_NAME,
        key: { expiresAt: 1 },
        unique: false,
        expireAfterSeconds: 0,
      },
    ]);
    // It is not in the schema, so a stray `db push` cannot create a plain
    // index under the same name; and it sits on a real field.
    expect(body).not.toContain(TTL_NAME);
    expect(body).toMatch(/^\s+expiresAt\s+DateTime\s*$/m);
  });

  it("never gives the model a field named academicYear", () => {
    expect(body).not.toMatch(/\bacademicYear\b/);
  });
});

/* ---- the engine's TTL support, against a fake command runner ------------- */

type Listed = Record<string, unknown>;

function fakeDb(initial: Listed[] | null) {
  const writes: Array<Record<string, unknown>> = [];
  let indexes = initial;
  const db: Fake = {
    $runCommandRaw: (cmd) => {
      if (typeof cmd.listIndexes === "string") {
        return Promise.resolve(
          indexes === null
            ? { ok: 0, code: 26, errmsg: "ns does not exist" }
            : {
                ok: 1,
                cursor: {
                  firstBatch: [
                    { v: 2, key: { _id: 1 }, name: "_id_" },
                    ...indexes,
                  ],
                },
              },
        );
      }
      if (typeof cmd.create === "string") {
        writes.push(cmd);
        indexes ??= [];
        return Promise.resolve({ ok: 1 });
      }
      if (typeof cmd.createIndexes === "string") {
        writes.push(cmd);
        indexes = [...(indexes ?? []), ...(cmd.indexes as Listed[])];
        return Promise.resolve({ ok: 1 });
      }
      return Promise.resolve({ ok: 0, code: 59, errmsg: "no such command" });
    },
  };
  return { db, writes };
}

describe("the shared engine understands expireAfterSeconds", () => {
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

  const ttl = TARGETS.Notification!.find((i) => i.name === TTL_NAME)!;

  it("a dry run writes nothing", async () => {
    const { db, writes } = fakeDb(null);

    const res = await apply(db, false, TARGETS);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("--commit creates the TTL index with expireAfterSeconds: 0, then verifies it", async () => {
    const { db, writes } = fakeDb(null);

    const res = await apply(db, true, TARGETS);

    expect(res.aborted).toBe(false);
    expect(res.created).toContain(`Notification.${TTL_NAME}`);
    const specs = writes.flatMap((w) =>
      Array.isArray(w.indexes) ? (w.indexes as Listed[]) : [],
    );
    expect(specs.find((s) => s.name === TTL_NAME)).toEqual({
      key: { expiresAt: 1 },
      name: TTL_NAME,
      expireAfterSeconds: 0,
    });
    // Plain indexes carry no TTL option.
    expect(specs.find((s) => s.name === "notification_user_created")).toEqual({
      key: { userID: 1, createdAt: 1 },
      name: "notification_user_created",
    });
  });

  it("a second run finds everything present and writes nothing", async () => {
    const { db, writes } = fakeDb(null);
    await apply(db, true, TARGETS);
    writes.length = 0;

    const res = await apply(db, true, TARGETS);

    expect(res).toEqual({ aborted: false, created: [] });
    expect(writes).toEqual([]);
  });

  it("treats a TTL value as part of the index: the wrong one is a conflict", () => {
    const listed = (over: Listed) => ({
      v: 2,
      key: { expiresAt: 1 },
      name: TTL_NAME,
      ...over,
    });

    expect(classify(ttl, [listed({ expireAfterSeconds: 0 })]).status).toBe(
      "present",
    );
    // Mongo's extended JSON for a 32-bit int must still match.
    expect(
      classify(ttl, [listed({ expireAfterSeconds: { $numberInt: "0" } })])
        .status,
    ).toBe("present");
    expect(classify(ttl, [listed({ expireAfterSeconds: 60 })]).status).toBe(
      "conflict",
    );
    // A plain index of that name (what a `db push` would leave) is refused,
    // not silently accepted as the expiry index.
    expect(classify(ttl, [listed({})]).status).toBe("conflict");
    expect(
      classify(ttl, [listed({ name: "other", expireAfterSeconds: 60 })]).status,
    ).toBe("conflict");
  });

  it("refuses to run, and writes nothing, when the existing index has a different TTL", async () => {
    const { db, writes } = fakeDb([
      { key: { expiresAt: 1 }, name: TTL_NAME, expireAfterSeconds: 3600 },
    ]);

    const res = await apply(db, true, TARGETS);

    expect(res.aborted).toBe(true);
    expect(writes).toEqual([]);
  });
});
