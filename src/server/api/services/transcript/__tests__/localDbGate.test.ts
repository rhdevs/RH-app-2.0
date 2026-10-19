import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "./localDbGate";

describe("the database tests' gate is the dev scripts' gate (S7)", () => {
  it("accepts only the local rhapp_transcript_dev database, as the scripts do", () => {
    expect(
      isLocalDevDatabase(
        "mongodb://localhost:27017/rhapp_transcript_dev?replicaSet=rs0",
      ),
    ).toBe(true);
    for (const url of [
      undefined,
      "mongodb+srv://localhost/rhapp_transcript_dev",
      "mongodb://localhost:27017/prod/../rhapp_transcript_dev",
      "mongodb://db.example.net/rhapp_transcript_dev",
      "mongodb://localhost:27017/rhapp",
    ]) {
      expect(isLocalDevDatabase(url), String(url)).toBe(false);
    }
  });

  it("is the only gate the database test files use", () => {
    const dir = join(
      process.cwd(),
      "src",
      "server",
      "api",
      "services",
      "transcript",
      "__tests__",
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".int.test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const source = readFileSync(join(dir, f), "utf8");
      expect(source, f).toContain('from "./localDbGate"');
      expect(source, f).not.toMatch(/function isLocalDevDatabase/);
    }
  });
});
