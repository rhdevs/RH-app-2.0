import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The kill-switch script, loaded by path so the type checker does not read the
// plain .mjs file. Importing it runs nothing: main() runs only as a script.
const SCRIPT = join(
  process.cwd(),
  "scripts",
  "remediation",
  "set-transcript-flag.mjs",
);
const { describeTarget } = (await import(
  /* @vite-ignore */ pathToFileURL(SCRIPT).href
)) as { describeTarget: (url: string | undefined) => string };

describe("set-transcript-flag.mjs names the database it writes to", () => {
  it("shows the host and database name", () => {
    expect(
      describeTarget(
        "mongodb://localhost:27017/rhapp_transcript_dev?replicaSet=rs0&directConnection=true",
      ),
    ).toBe("host localhost:27017, database rhapp_transcript_dev");
    expect(
      describeTarget("mongodb://a.example.net:27017,b.example.net:27017/rhapp"),
    ).toBe("host a.example.net:27017,b.example.net:27017, database rhapp");
    expect(describeTarget("mongodb://localhost:27017")).toBe(
      "host localhost:27017, database (none: the default)",
    );
    expect(describeTarget(undefined)).toBe("(DATABASE_URL is not set)");
  });

  it("never shows the user name, password or options", () => {
    const shown = describeTarget(
      "mongodb+srv://ops-user:s3cr%40t@cluster0.example.mongodb.net/rhapp?retryWrites=true&authSource=admin",
    );
    expect(shown).toBe("host cluster0.example.mongodb.net, database rhapp");
    for (const secret of ["ops-user", "s3cr", "%40t", "retryWrites", "admin"]) {
      expect(shown).not.toContain(secret);
    }
  });

  it("prints the target before the flag is read, so the dry run and --commit both show it", () => {
    const source = readFileSync(SCRIPT, "utf8");
    const main = source.slice(source.indexOf("async function main()"));
    const target = main.indexOf("describeTarget(process.env.DATABASE_URL)");
    expect(target).toBeGreaterThan(-1);
    expect(target).toBeLessThan(main.indexOf("await readFlag()"));
    expect(target).toBeLessThan(main.indexOf("DRY RUN"));
    const write = main.search(/\$runCommandRaw\(\{\s*update/);
    expect(write).toBeGreaterThan(-1);
    expect(target).toBeLessThan(write);
  });
});
