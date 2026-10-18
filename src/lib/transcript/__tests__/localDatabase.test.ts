import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The dev scripts' local-database gate, loaded by path so the type checker
// does not read the plain .mjs file.
const gate = pathToFileURL(
  join(process.cwd(), "scripts", "dev", "localDatabase.mjs"),
).href;
const { localDatabaseProblem, REQUIRED_DB } = (await import(
  /* @vite-ignore */ gate
)) as {
  localDatabaseProblem: (url: string | undefined) => string | null;
  REQUIRED_DB: string;
};

describe("the dev scripts' local-database gate (seed and dev:db:push)", () => {
  it("lets through only the local rhapp_transcript_dev database", () => {
    expect(REQUIRED_DB).toBe("rhapp_transcript_dev");
    for (const url of [
      "mongodb://localhost:27017/rhapp_transcript_dev?replicaSet=rs0&directConnection=true",
      "mongodb://127.0.0.1:27017/rhapp_transcript_dev",
    ]) {
      expect(localDatabaseProblem(url), url).toBeNull();
    }
  });

  it("refuses any other host or database, a bad URL, or none", () => {
    for (const url of [
      "mongodb+srv://user:pass@cluster0.example.mongodb.net/rhapp",
      "mongodb://db.example.net:27017/rhapp_transcript_dev",
      "mongodb://localhost:27017/rhapp",
      "not a url",
      undefined,
    ]) {
      expect(localDatabaseProblem(url), String(url)).not.toBeNull();
    }
  });

  it("is what the seed and dev:db:push both use, and the npm script points at the guard", () => {
    const seed = readFileSync("scripts/dev/seed-transcript.mjs", "utf8");
    const push = readFileSync("scripts/dev/db-push.mjs", "utf8");
    expect(seed).toContain('requireLocalDatabase("seed")');
    expect(push).toContain("requireLocalDatabase(");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["dev:db:push"]).toBe("node scripts/dev/db-push.mjs");
  });
});
