import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The kill-switch script, read as text only: importing it would run it (it
// always runs, S3). describeTarget is loaded from its lib by path, so the type
// checker does not read the plain .mjs file.
const SCRIPT = join(
  process.cwd(),
  "scripts",
  "remediation",
  "set-transcript-flag.mjs",
);
const LIB = join(
  process.cwd(),
  "scripts",
  "remediation",
  "lib",
  "dbTarget.mjs",
);
const { describeTarget } = (await import(
  /* @vite-ignore */ pathToFileURL(LIB).href
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

  it("never shows a password with an unescaped / ? or @ (S4)", () => {
    expect(describeTarget("mongodb://user:pa/ss@host/db")).toBe(
      "host host, database db",
    );
    // A "?" inside the password ends nothing: options start after the hosts.
    expect(describeTarget("mongodb://user:pa?ss@host/db")).toBe(
      "host host, database db",
    );
    // "a@b/c@host": the credentials end at "a@", so "c@host" is an "@" the
    // reading does not account for, and the target is not named (T7).
    expect(describeTarget("mongodb://user:a@b/c@host:27017/db")).toBe(
      "(host not recognised)",
    );
    // U1: a lead that is a host with a port or a user with a numeric password
    // cannot be told apart, so nothing is named.
    expect(
      describeTarget("mongodb://admin:12345?x=1@prod.example.net/rhapp"),
    ).toBe("(host not recognised)");
    expect(
      describeTarget("mongodb://admin:pw?x=1@prod.example.net/rhapp"),
    ).toBe("host prod.example.net, database rhapp");
    // T7: an "@" in the path after the hosts is never read as the boundary.
    expect(describeTarget("mongodb://user:pw@prod.example.net/rhapp@x")).toBe(
      "(host not recognised)",
    );
    expect(
      describeTarget("mongodb://user:pw@prod.example.net/rhapp?appName=a@b"),
    ).toBe("(host not recognised)");
    expect(describeTarget("mongodb://user:pw@host?x=a@b")).toBe(
      "(host not recognised)",
    );
    expect(describeTarget("mongodb://user:p@ss@host")).toBe(
      "host host, database (none: the default)",
    );
    for (const url of [
      "mongodb://user:pa/ss@host/db",
      "mongodb://user:pa?ss@host/db",
      "mongodb://user:a@b/c@host:27017/db",
      "mongodb://user:se cret@host/db",
      "mongodb://user:pa/ss@host/db?authSource=admin",
    ]) {
      const shown = describeTarget(url);
      for (const secret of ["user", "pa", "ss", "se cret", "a@b", "admin"]) {
        expect(shown, url).not.toContain(secret);
      }
    }
  });

  it("reads an @ after the hosts as part of the path or options, not credentials (U1)", () => {
    const cases: Array<[string, string]> = [
      [
        "mongodb://prod.example.net/rhapp?appName=a@b",
        "host prod.example.net, database rhapp",
      ],
      ["mongodb://real.host/db?x=a@evil.host", "host real.host, database db"],
      [
        "mongodb://prod.example.net/rhapp@x",
        "host prod.example.net, database (not recognised)",
      ],
      [
        "mongodb://prod.example.net/rhapp?authSource=admin&tlsCertificateKeyFilePassword=sec@ret",
        "host prod.example.net, database rhapp",
      ],
      ["mongodb://host#frag@x/db", "(host not recognised)"],
      // A port makes the lead ambiguous with user:password: fail closed.
      ["mongodb://host:27017/db?x=a@b", "(host not recognised)"],
      ["mongodb://a:1,b:2/db?x=a@b", "(host not recognised)"],
      [
        "mongodb://a.example.net,b.example.net/db?x=a@b",
        "host a.example.net,b.example.net, database db",
      ],
      // Options before any "/" never turn into a database name.
      ["mongodb://host?x=a/b", "host host, database (none: the default)"],
    ];
    for (const [url, expected] of cases) {
      const shown = describeTarget(url);
      expect(shown, url).toBe(expected);
      for (const secret of ["evil", "ret", "sec", "frag"]) {
        expect(shown, url).not.toContain(secret);
      }
    }
  });

  it("checks every host, and shows nothing but the refusal if any fails (S4)", () => {
    expect(describeTarget("mongodb://[::1]:27017,127.0.0.1/db")).toBe(
      "host [::1]:27017,127.0.0.1, database db",
    );
    expect(describeTarget("mongodb://good:27017,bad host:1/db")).toBe(
      "(host not recognised)",
    );
    expect(describeTarget("mongodb://host:port/db")).toBe(
      "(host not recognised)",
    );
    expect(describeTarget("mongodb:///db")).toBe("(host not recognised)");
    expect(describeTarget("mongodb://host/we!rd")).toBe(
      "host host, database (not recognised)",
    );
  });

  it("always runs main(), never behind a check on how it was started (S3)", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toContain("process.argv[1]");
    expect(source).not.toContain("import.meta.url");
    expect(source).toMatch(/^main\(\)/m);
    expect(source).toContain('from "./lib/dbTarget.mjs"');
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
