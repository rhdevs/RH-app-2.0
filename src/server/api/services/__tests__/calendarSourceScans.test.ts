import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans that keep the calendar honest. They read the files, not the
 * behaviour, and exist so a later edit cannot quietly undo a property the
 * behaviour tests only sample.
 */

const ROOT = process.cwd();
const read = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
/** Code only: comments and string literals removed. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const SERVICE_DIR = "src/server/api/services/calendar";
const SERVICE_FILES = readdirSync(path.join(ROOT, SERVICE_DIR))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `${SERVICE_DIR}/${f}`);
const ROUTE = "src/app/api/calendar/feed/[token]/route.ts";
const ROUTER = "src/server/api/routers/calendar.ts";

describe("the calendar's reads fail loudly", () => {
  it.each(SERVICE_FILES)("%s has no forgiving catch around a read", (file) => {
    const src = code(file);
    expect(src).not.toMatch(/\.catch\(/);
    expect(src).not.toMatch(/\.findMany\([^)]*\)\s*\.catch/);
    // Every try block in a service must log or return a refusal, never nothing.
    for (const m of src.matchAll(/catch\s*(\([^)]*\))?\s*\{\s*\}/g)) {
      throw new Error(`${file}: empty catch ${m[0]}`);
    }
  });

  it("the layer readers do not catch (the caller decides what a failure means)", () => {
    expect(code(`${SERVICE_DIR}/read.ts`)).not.toMatch(/\bcatch\b/);
  });
});

describe("the calendar never writes Events or proposals", () => {
  it.each([...SERVICE_FILES, ROUTER, ROUTE])("%s", (file) => {
    const src = code(file);
    expect(src).not.toMatch(
      /\b(event|proposal|proposalStatusHistory|booking)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
    );
    expect(src).not.toMatch(/\$runCommandRaw|\$executeRaw/);
  });
});

describe("the feed route", () => {
  const src = code(ROUTE);

  it("only answers GET", () => {
    expect(src).toMatch(/export\s+(async\s+)?function\s+GET\b/);
    expect(src).not.toMatch(
      /export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/,
    );
  });

  it("reads no session: the token is the credential", () => {
    expect(src).not.toMatch(
      /getServerAuthSession|getServerSession|~\/server\/auth|cookies\(|headers\(/,
    );
  });

  it("never logs and never puts the token in a response header or URL", () => {
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/searchParams|req\.url|request\.url/);
  });

  it("is private and uncached, on every path", () => {
    expect(src).toContain("private, no-store");
    expect(src).toMatch(/force-dynamic/);
  });
});

describe("the feed builder", () => {
  it("logs the kind of failure only, never a message, a stack or the token", () => {
    const src = code(`${SERVICE_DIR}/feed.ts`);
    expect(src).not.toMatch(/\.message|\.stack|String\(err\)/);
    expect(src).toMatch(/err\.name/);
  });

  it("holds no proposal description, note or person in an entry", () => {
    const src = code(`${SERVICE_DIR}/feed.ts`);
    expect(src).not.toMatch(/description:\s*p\./);
    expect(src).not.toMatch(/createdBy/);
  });
});

describe("the token is never stored or compared in the clear", () => {
  it("only the hash is written, and no secret comparison exists", () => {
    const src = code(`${SERVICE_DIR}/token.ts`);
    expect(src).toMatch(/tokenHash:\s*hashFeedToken\(token\)/g);
    expect(src).not.toMatch(/data:\s*\{[^}]*\btoken\b\s*[,}]/);
    expect(src).not.toMatch(/===\s*token|token\s*===|timingSafeEqual/);
  });
});
