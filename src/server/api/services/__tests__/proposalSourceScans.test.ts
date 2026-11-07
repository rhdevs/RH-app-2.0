import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans for the proposal core. They read files as text, so they hold
 * without a database:
 *  - `transitionProposal` is the only production code that writes
 *    `Proposal.status` (merge proposal 4.1);
 *  - no `event.*` code reads or writes a proposal (A32);
 *  - the proposal access code never uses a forgiving role read.
 */

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Code only: comments removed so prose can name a symbol, while a quote, a
 * template or a regex holding a comment marker is kept as it is. A quote ends
 * at the end of its line (JSX text can hold a lone apostrophe).
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < n && source[i] !== c) {
        if (c !== "`" && source[i] === "\n") break;
        if (source[i] === "\\") out += source[i++];
        if (i < n) out += source[i++];
      }
      if (i < n && source[i] === c) out += source[i++];
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : walk(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const SRC_FILES = walk(path.join(ROOT, "src")).map((f) =>
  path.relative(ROOT, f).split(path.sep).join("/"),
);

const TRANSITION = "src/server/api/services/proposals/transition.ts";
const WRITES = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);
const READS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** The text of the balanced parentheses that open at `open`. */
function callArguments(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    if (code[i] === ")" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

/**
 * Things in one file that would let a status be stored by something other
 * than transitionProposal. Empty means none.
 */
export function statusWriteProblems(source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  for (const m of code.matchAll(/\.proposal\b(\s*\.\s*(\w+)\s*\()?/g)) {
    const method = m[2];
    if (method === undefined) {
      // `const p = tx.proposal` would hide a write from this scan.
      problems.push("proposal delegate used without a direct method call");
      continue;
    }
    if (READS.has(method)) continue;
    if (!WRITES.has(method)) {
      problems.push(`unknown proposal method ${method}`);
      continue;
    }
    const open = m.index! + m[0].length - 1;
    let args = callArguments(code, open);
    if (method === "update" || method === "updateMany") {
      // The filter may name a status (that is a read); the data must not.
      const at = args.search(/\bdata\s*:/);
      if (at < 0) {
        problems.push(`proposal.${method} without a data key`);
        continue;
      }
      args = args.slice(at);
    }
    if (/\bstatus\b/.test(args)) {
      problems.push(`proposal.${method} names status`);
    }
  }
  // A raw command could write the collection without the delegate.
  if (
    /(\$runCommandRaw|\$executeRaw|\$executeRawUnsafe)/.test(code) &&
    /["'`]Proposal["'`]/.test(code)
  ) {
    problems.push("raw command on the Proposal collection");
  }
  return problems;
}

describe("the scan itself (self-tests)", () => {
  it("catches a status write, however the call is spelled", () => {
    expect(
      statusWriteProblems(
        `await tx.proposal.updateMany({ where: {}, data: { status: "cleared" } });`,
      ),
    ).toEqual(["proposal.updateMany names status"]);
    expect(
      statusWriteProblems(
        `await db.proposal.create({ data: { title, status: "draft" } })`,
      ),
    ).toEqual(["proposal.create names status"]);
    expect(
      statusWriteProblems(`await db.proposal\n  .update({ data: { status } })`),
    ).toEqual(["proposal.update names status"]);
  });

  it("catches an aliased delegate and a raw command", () => {
    expect(statusWriteProblems(`const p = tx.proposal; p.update({});`)).toEqual(
      ["proposal delegate used without a direct method call"],
    );
    expect(
      statusWriteProblems(
        `await db.$runCommandRaw({ update: "Proposal", updates: [] });`,
      ),
    ).toEqual(["raw command on the Proposal collection"]);
  });

  it("allows reads that filter on status and writes that do not name it", () => {
    expect(
      statusWriteProblems(
        `await db.proposal.findMany({ where: { status: { not: "draft" } } });
         await db.proposal.updateMany({ where: { id }, data: { title } });`,
      ),
    ).toEqual([]);
  });

  it("ignores a comment or a string that only talks about it", () => {
    expect(
      statusWriteProblems(
        `// db.proposal.update({ data: { status } })\n/* tx.proposal */ const s = "status";`,
      ),
    ).toEqual([]);
  });

  it("is not fooled by a comment marker inside a string", () => {
    expect(
      statusWriteProblems(
        `const a = "/*"; await tx.proposal.update({ data: { status } });`,
      ),
    ).toEqual(["proposal.update names status"]);
  });
});

describe("only transitionProposal writes Proposal.status", () => {
  it("reads the whole source tree", () => {
    expect(SRC_FILES.length).toBeGreaterThan(100);
    expect(SRC_FILES).toContain(TRANSITION);
  });

  it("no production file other than transition.ts names status in a proposal write", () => {
    // A client component cannot hold a database client; its `api.proposal` is
    // the tRPC hook tree, which this scan would otherwise take for a delegate.
    const isClient = (f: string) => /^\s*["']use client["']/.test(read(f));
    const offenders = SRC_FILES.filter(
      (f) => f !== TRANSITION && !isClient(f),
    ).flatMap((f) => statusWriteProblems(read(f)).map((p) => `${f}: ${p}`));
    expect(offenders).toEqual([]);
  });

  it("transition.ts is the one that does, in a single compare-and-set", () => {
    const code = stripComments(read(TRANSITION));
    expect(code.match(/\.proposal\.updateMany\(/g)).toHaveLength(1);
    expect(code.match(/status:\s*input\.to/g)).toHaveLength(1);
    // The filter names the status the caller saw.
    expect(code).toMatch(/status:\s*input\.from/);
  });

  it("creating a draft leaves the status to the schema default", () => {
    const code = stripComments(
      read("src/server/api/services/proposals/drafts.ts"),
    );
    expect(code).toMatch(/\.proposal\.create\(/);
    expect(read("prisma/schema.prisma")).toMatch(
      /\n\s*status\s+String\s+@default\("draft"\)/,
    );
  });

  it("the router passes no status to anything", () => {
    const code = stripComments(read("src/server/api/routers/proposal.ts"));
    expect(code).not.toMatch(/\bstatus\b/);
    expect(code).not.toMatch(/transitionProposal/);
  });
});

describe("A32: events never read or write a proposal", () => {
  const EVENT_FILES = [
    "src/server/api/routers/event.ts",
    "src/server/api/services/events.ts",
    "src/server/api/services/eventPublish.ts",
    "src/server/api/services/eventLiveEdit.ts",
    "src/server/api/services/eventNotices.ts",
    "src/server/api/services/eventQr.ts",
  ];

  it("lists files that exist", () => {
    for (const f of EVENT_FILES) expect(SRC_FILES).toContain(f);
  });

  it("none of them names a proposal, its router or its services in code", () => {
    for (const f of EVENT_FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/\bproposals?\b/i);
      expect(code, f).not.toMatch(/services\/proposals|lib\/proposals/);
    }
  });

  it("the Event model has no field that points at a proposal", () => {
    const schema = read("prisma/schema.prisma").replace(/\r\n/g, "\n");
    const start = schema.indexOf("model Event {");
    const body = schema.slice(start, schema.indexOf("\n}", start));
    expect(body.replace(/\/\/.*$/gm, "")).not.toMatch(/proposal/i);
  });
});

describe("proposal access never uses a forgiving read", () => {
  const FILES = [
    "src/server/api/routers/proposal.ts",
    ...SRC_FILES.filter((f) =>
      f.startsWith("src/server/api/services/proposals/"),
    ),
  ];

  it("finds the proposal files", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(7);
  });

  it("none of them uses getUserRoles, the session's roles, assertHeadsCca or the views-only position helpers", () => {
    for (const f of FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/getUserRoles/);
      expect(code, f).not.toMatch(/assertHeadsCca|ccaScope/);
      expect(code, f).not.toMatch(/myPositionCcas|overseesAll/);
      expect(code, f).not.toMatch(/session\.user\.roles/);
      expect(code, f).not.toMatch(/\bgetServerAuthSession|\bauth\(/);
    }
  });

  it("access.ts catches only around a whole decision, and only to refuse", () => {
    const code = stripComments(
      read("src/server/api/services/proposals/access.ts"),
    );
    // One in assertCcaHead, one in assertProposalReader; each calls
    // refuseOnFailure, which throws FORBIDDEN.
    expect(code.match(/\bcatch\b/g)).toHaveLength(2);
    expect(code.match(/return refuseOnFailure\(err\)/g)).toHaveLength(2);
    expect(code).toMatch(/function refuseOnFailure\(err: unknown\): never/);
  });

  it("the other proposal services catch nothing", () => {
    for (const f of FILES) {
      if (f.endsWith("/access.ts") || f.endsWith("/flag.ts")) continue;
      if (f.endsWith("/transition.ts")) continue; // maps a conflict, see below
      expect(stripComments(read(f)), f).not.toMatch(/\bcatch\b/);
    }
  });

  it("every gated proposal procedure runs inside sanitizeErrors", () => {
    const code = stripComments(read("src/server/api/routers/proposal.ts"));
    // The one builder every procedure but `enabled` starts from.
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(/,
    );
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(5);
    expect(code.match(/^ {2}\w+: protectedProcedure/gm)).toHaveLength(1);
  });

  it("create, update and submit each spend rate-limit budget after the access check", () => {
    for (const [file, action] of [
      ["drafts.ts", "create"],
      ["drafts.ts", "update"],
      ["submit.ts", "submit"],
    ] as const) {
      const code = stripComments(
        read(`src/server/api/services/proposals/${file}`),
      );
      const head = code.indexOf("await assertCcaHead(");
      const limit = code.indexOf(`assertWithinLimit("${action}"`);
      expect(head, `${file} ${action}`).toBeGreaterThan(-1);
      expect(limit, `${file} ${action}`).toBeGreaterThan(head);
    }
  });

  it("transition.ts rethrows everything but a write conflict", () => {
    const code = stripComments(read(TRANSITION));
    expect(code.match(/\bcatch\b/g)).toHaveLength(1);
    expect(code).toMatch(/if \(isWriteConflict\(err\)\) throw conflict\(\)/);
    expect(code).toMatch(/throw err;/);
  });
});

describe("the proposal screens render server text as text", () => {
  const SCREENS = SRC_FILES.filter(
    (f) =>
      f.includes("/cca/_components/Proposal") ||
      f.includes("/cca/[ccaID]/proposals/") ||
      f === "src/app/cca/_lib/proposalForm.ts",
  );

  it("finds the screens", () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(6);
  });

  it("none injects HTML, evaluates a string or calls an event procedure", () => {
    for (const f of SCREENS) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
      expect(code, f).not.toMatch(/\beval\(|new Function\(/);
      expect(code, f).not.toMatch(/api\.event\b/);
    }
  });

  it("none sends a status: the screens only save and submit", () => {
    for (const f of SCREENS) {
      expect(stripComments(read(f)), f).not.toMatch(/\bstatus\s*:/);
    }
  });
});
