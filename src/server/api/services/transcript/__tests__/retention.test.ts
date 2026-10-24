import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { TRANSCRIPT_COLLECTIONS, purgeAcademicYear } from "../retention";

/**
 * The purge must know every collection that carries an academic year. This reads
 * prisma/schema.prisma, so a model added later with an \`academicYear\` field
 * fails here until it is added to the registry.
 */
function modelsWithAcademicYear(schema: string): string[] {
  const out: string[] = [];
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = m[2]!.split("\n").map(
      (l) =>
        l
          .replace(/\/\/.*$/, "")
          .trim()
          .split(/\s+/)[0],
    );
    if (fields.includes("academicYear")) out.push(m[1]!);
  }
  return out.sort();
}

describe("the purge registry", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  it("lists every model that has an academicYear field", () => {
    const withYear = modelsWithAcademicYear(schema);

    expect(withYear.length).toBeGreaterThanOrEqual(7);
    const missing = withYear.filter(
      (name) => !(TRANSCRIPT_COLLECTIONS as readonly string[]).includes(name),
    );
    expect(missing, "add these to TRANSCRIPT_COLLECTIONS").toEqual([]);
  });

  it("names only models that exist and carry an academicYear", () => {
    const withYear = new Set(modelsWithAcademicYear(schema));

    for (const name of TRANSCRIPT_COLLECTIONS) {
      expect(withYear.has(name), name).toBe(true);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(TRANSCRIPT_COLLECTIONS).size).toBe(
      TRANSCRIPT_COLLECTIONS.length,
    );
  });

  it("finds the models in a schema the way it should (so the check cannot pass by accident)", () => {
    const sample = `model Alpha {\n  id String\n  academicYear String\n}\n\nmodel Beta {\n  id String\n  note String // academicYear in a comment\n}\n`;

    expect(modelsWithAcademicYear(sample)).toEqual(["Alpha"]);
  });
});

describe("purgeAcademicYear", () => {
  it("runs the period status write again when it loses a write conflict (T4)", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const updateMany = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("c"), { code: "P2034" }))
      .mockResolvedValue({ count: 1 });
    const db = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "transcriptPeriod"
            ? { updateMany, deleteMany }
            : { deleteMany },
      },
    ) as PrismaClient;

    await purgeAcademicYear(db, "AY2026/27");

    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenCalled();
  });
});
