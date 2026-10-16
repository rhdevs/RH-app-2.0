import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

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
const { TARGETS, classify } = (await import(/* @vite-ignore */ script)) as {
  TARGETS: Record<string, Index[]>;
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
  it("finds the transcript models and a plausible number of indexes", () => {
    expect(models.has("TranscriptPeriod")).toBe(true);
    expect(models.has("ResidentEvent")).toBe(true);
    expect(models.has("User")).toBe(false);
    expect(
      withIndexes.reduce((n, [, list]) => n + list.length, 0),
    ).toBeGreaterThan(25);
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
