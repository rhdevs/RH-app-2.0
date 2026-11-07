import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Index = { name: string; key: Record<string, number>; unique: boolean };

// Loaded by path so the type checker does not read the plain .mjs file.
const script = pathToFileURL(
  join(process.cwd(), "scripts", "remediation", "create-aux-indexes.mjs"),
).href;
const { TARGETS } = (await import(/* @vite-ignore */ script)) as {
  TARGETS: Record<string, Index[]>;
};

const schema = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
).replace(/\r\n/g, "\n");

const MODELS = ["AuxAward", "AuxRecord", "AuxRecordAttendee"] as const;

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

describe("create-aux-indexes.mjs mirrors prisma/schema.prisma", () => {
  it("targets the three AUX collections and Event", () => {
    expect(Object.keys(TARGETS).sort()).toEqual([...MODELS, "Event"].sort());
  });

  it.each(MODELS)(
    "%s: same index names, keys, key order and uniqueness",
    (m) => {
      expect(shape(TARGETS[m]!)).toEqual(shape(schemaIndexes(modelBody(m))));
    },
  );

  it("adds only Event's auxYear index, as the schema declares it", () => {
    const declared = shape(schemaIndexes(modelBody("Event")));
    expect(shape(TARGETS.Event!)).toEqual([
      'event_auxYear {"auxYear":1} false',
    ]);
    for (const s of shape(TARGETS.Event!)) expect(declared).toContain(s);
  });
});
