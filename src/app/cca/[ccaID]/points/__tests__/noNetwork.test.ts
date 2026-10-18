import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CONFIDENTIALITY GUARD. Points must never leave the leader's browser, so the
 * points page and its pure helpers may not contain any network or server-write
 * path, nor log anything. The only server calls the page makes are the two
 * head-gated reads (ccaPoints.getEntryContext, cca.memberDirectory), which are
 * `useQuery`, and neither carries a score.
 */

// Vitest runs from the repository root.
const ROOTS = ["src/app/cca/[ccaID]/points", "src/lib/points"];
const SOURCE = /\.(ts|tsx)$/;

// Built from pieces so this file does not trip its own scan.
const piece = (...parts: string[]): string => parts.join("");
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: "useMutation", pattern: new RegExp(piece("use", "Mutation")) },
  { name: "fetch(", pattern: new RegExp(piece("\\bfet", "ch\\s*\\(")) },
  { name: "XMLHttpRequest", pattern: new RegExp(piece("XMLHttp", "Request")) },
  { name: "sendBeacon", pattern: new RegExp(piece("send", "Beacon")) },
  {
    name: '"use server"',
    pattern: new RegExp(piece("[\"']use ", "server[\"']")),
  },
  { name: "console.log", pattern: new RegExp(piece("console", "\\.log")) },
  {
    name: ".mutate(",
    pattern: new RegExp(piece("\\.mut", "ate(Async)?\\s*\\(")),
  },
  { name: "WebSocket", pattern: new RegExp(piece("\\bWeb", "Socket\\b")) },
  { name: "EventSource", pattern: new RegExp(piece("\\bEvent", "Source\\b")) },
  { name: "axios", pattern: new RegExp(piece("\\bax", "ios\\b")) },
];

// The only tRPC hooks the points page and its helpers may call: the two
// head-gated READS. Anything else (another query, or any mutation) must be a
// deliberate change to this list.
const ALLOWED_HOOKS = new Set([
  "api.ccaPoints.getEntryContext.useQuery",
  "api.cca.memberDirectory.useQuery",
]);
const HOOK_CALL = new RegExp(
  piece(
    "api\\.[\\w.]+\\.use(Query|Suspense",
    "Query|InfiniteQuery|Mut",
    "ation)\\b",
  ),
  "g",
);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = ROOTS.flatMap(walk).filter((path) => SOURCE.test(path));
const SELF = join("src/app/cca/[ccaID]/points/__tests__/noNetwork.test.ts");

describe("points: no network, no logging", () => {
  it("finds the files it is meant to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("calls only the two allowed tRPC reads", () => {
    const found = files
      .filter((path) => relative(".", path) !== relative(".", SELF))
      .flatMap((path) => readFileSync(path, "utf8").match(HOOK_CALL) ?? []);
    expect(new Set(found)).toEqual(ALLOWED_HOOKS);
  });

  it.each(FORBIDDEN)("no file uses $name", ({ pattern }) => {
    const offenders = files
      .filter((path) => relative(".", path) !== relative(".", SELF))
      .filter((path) => pattern.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
