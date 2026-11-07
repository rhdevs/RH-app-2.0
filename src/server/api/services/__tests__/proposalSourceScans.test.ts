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

describe("A32 (PR 9): the link runs one way, from the proposal to the Event", () => {
  // Every event router and event service file, found rather than listed, so a
  // new one is covered the day it is added. The helper that writes the row
  // (eventDraft.ts) is one of them.
  const EVENT_CODE = SRC_FILES.filter(
    (f) =>
      /^src\/server\/api\/routers\/event[A-Za-z]*\.ts$/.test(f) ||
      /^src\/server\/api\/services\/event[A-Za-z]*\.ts$/.test(f),
  );

  it("finds the event files, the row helper among them", () => {
    expect(EVENT_CODE).toContain("src/server/api/routers/event.ts");
    expect(EVENT_CODE).toContain("src/server/api/services/eventDraft.ts");
    expect(EVENT_CODE.length).toBeGreaterThanOrEqual(7);
  });

  it("none imports, names or authorizes on anything proposal", () => {
    for (const f of EVENT_CODE) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/proposal/i);
      expect(code, f).not.toMatch(/eventLink|willBeEvent/);
    }
  });

  it("the Event router makes its row through the shared helper, once", () => {
    const code = stripComments(read("src/server/api/routers/event.ts"));
    expect(code.match(/\bcreateEventRow\(/g)).toHaveLength(1);
    expect(code).toMatch(/from "~\/server\/api\/services\/eventDraft"/);
  });

  it("only the Event router and the proposal link import the row helper", () => {
    const importers = SRC_FILES.filter((f) =>
      stripComments(read(f)).includes('services/eventDraft"'),
    );
    expect(importers.sort()).toEqual([
      "src/server/api/routers/event.ts",
      "src/server/api/services/proposals/eventLink.ts",
    ]);
  });

  it("no proposal file or screen changes, deletes or publishes an Event", () => {
    const files = SRC_FILES.filter(
      (f) =>
        f.startsWith("src/server/api/services/proposals/") ||
        f === "src/server/api/routers/proposal.ts" ||
        f.includes("/cca/_components/Proposal") ||
        f.startsWith("src/app/director/"),
    );
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(
        /\.event\s*\.\s*(update|updateMany|delete|deleteMany|upsert|create|createMany)\b/,
      );
      expect(code, f).not.toMatch(/eventPublish|publishEvent|"published"/);
      expect(code, f).not.toMatch(/deleteDraft|\.event\.(cancel|publish)/);
    }
  });
});

describe("the Event link is made once, after the approval, and never fails it", () => {
  const LINK = "src/server/api/services/proposals/eventLink.ts";
  const code = () => stripComments(read(LINK));

  it("follows 4.7's order: read, allocate, compare-and-set, then create", () => {
    const c = code();
    const start = c.indexOf("async function linkAndCreate");
    const body = c.slice(start, c.indexOf("\n}\n", start));
    const at = (needle: string) => body.indexOf(needle);
    expect(at("readLinkedEvent(")).toBeGreaterThan(-1);
    expect(at("nextEventId(db)")).toBeGreaterThan(at("readLinkedEvent("));
    expect(at("db.proposal.updateMany(")).toBeGreaterThan(
      at("nextEventId(db)"),
    );
    expect(at("createEventRow(")).toBeGreaterThan(at("claimed.count !== 1"));
    // The expected value is the one read, and a missing key counts as null.
    expect(c).toMatch(/isSet: false/);
    expect(body).toMatch(/\.\.\.eventIDIs\(expected\)/);
    // Only an approved proposal can be linked: the caller names which statuses.
    expect(body).toMatch(/status: \{ in: statuses \}/);
    expect(c).toMatch(/draftEventAfterApproval[\s\S]*?\[\s*"cleared",?\s*\]/);
    // The link write is not a content edit and not a status move.
    const data = body.slice(body.indexOf("data:"));
    expect(data.slice(0, data.indexOf("}") + 1)).toBe(
      "data: { eventID, eventClaimedAt: new Date() }",
    );
  });

  it("the automatic step wraps its whole body in one try and reads the flag first", () => {
    const c = code();
    const start = c.indexOf("export async function draftEventAfterApproval");
    const body = c.slice(start, c.indexOf("\n}\n", start));
    expect(body.match(/\btry\b/g)).toHaveLength(1);
    expect(body.match(/\bcatch\b/g)).toHaveLength(1);
    expect(body.indexOf("try {")).toBeLessThan(body.indexOf("loadSource("));
    expect(body.indexOf("areEventsEnabled(db)")).toBeLessThan(
      body.indexOf("linkAndCreate("),
    );
    expect(body).not.toMatch(/\bthrow\b/);
    // The only other catches are the two best-effort notices.
    expect(c.match(/\bcatch\b/g)).toHaveLength(3);
  });

  it("the button checks the flag, then the head, then spends budget, then links", () => {
    const c = code();
    const start = c.indexOf("export async function createEventFromProposal");
    const body = c.slice(start);
    const order = [
      "await assertEventsEnabled(db)",
      "await assertCcaHead(",
      'await assertWithinLimit("createEvent", userID)',
      "linkAndCreate(",
    ].map((n) => body.indexOf(n));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toMatch(/hideExistence: true/);
    expect(c).not.toMatch(/getUserRoles|assertHeadsCca|isDirectorOf/);
  });

  it("approve makes the draft only after the approval has committed", () => {
    const c = stripComments(
      read("src/server/api/services/proposals/review.ts"),
    );
    const start = c.indexOf("export async function approveProposal");
    const body = c.slice(start, c.indexOf("\n}\n", start));
    expect(body.indexOf('reviewMove(db, userID, "approve"')).toBeGreaterThan(
      -1,
    );
    expect(body.indexOf("draftEventAfterApproval(")).toBeGreaterThan(
      body.indexOf("reviewMove("),
    );
    // Return and finish never make an Event.
    expect(c.match(/draftEventAfterApproval\(/g)).toHaveLength(1);
  });

  it("the router's Create event is a gated procedure that passes only the id", () => {
    const c = stripComments(read("src/server/api/routers/proposal.ts"));
    expect(c).toMatch(
      /createEvent: gated\s*\.input\(proposalIdInput\)\s*\.mutation\(\(\{ ctx, input \}\) =>\s*createEventFromProposal\(ctx\.db, ctx\.session\.user\.userID, input\.id\)/,
    );
  });

  it("copies only the named fields into the Event row", () => {
    const c = code();
    const start = c.indexOf("function eventRowFrom");
    const body = c.slice(start, c.indexOf("\n}\n", start));
    for (const absent of [
      "posterUrl",
      "docLink",
      "category",
      "budget",
      "bannerUrl",
      "status",
    ]) {
      expect(body, absent).not.toMatch(new RegExp(`\b${absent}\b`));
    }
    for (const nulled of [
      "location: null",
      "facilityID: null",
      "capacity: null",
    ]) {
      expect(body).toContain(nulled);
    }
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
    // One each in assertCcaHead, assertProposalReader, proposalAccess,
    // assertProposalDirector, directedCcasOrRefuse, directorsOrRefuse and readSelfApproved; each
    // calls refuseOnFailure, which throws FORBIDDEN.
    expect(code.match(/\bcatch\b/g)).toHaveLength(7);
    expect(code.match(/return refuseOnFailure\(err\)/g)).toHaveLength(7);
    expect(code).toMatch(/function refuseOnFailure\(err: unknown\): never/);
  });

  it("the other proposal services catch nothing", () => {
    for (const f of FILES) {
      if (f.endsWith("/access.ts") || f.endsWith("/flag.ts")) continue;
      if (f.endsWith("/transition.ts")) continue; // maps a conflict, see below
      if (f.endsWith("/eventLink.ts")) continue; // best-effort draft, see below
      expect(stripComments(read(f)), f).not.toMatch(/\bcatch\b/);
    }
  });

  it("every gated proposal procedure runs inside sanitizeErrors", () => {
    const code = stripComments(read("src/server/api/routers/proposal.ts"));
    // The one builder every procedure but `enabled` starts from.
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(/,
    );
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(11);
    expect(code.match(/^ {2}\w+: protectedProcedure/gm)).toHaveLength(1);
    // The navigation entry's query is the one deliberate exception: it must
    // answer `show: false` for everyone else, so the switch check lives in the
    // service, and it is still wrapped in sanitizeErrors.
    expect(code).toMatch(
      /directorEntry: identifiedProcedure\s*\.use\(sanitizeErrors\)/,
    );
    expect(code.match(/^ {2}\w+: identifiedProcedure/gm)).toHaveLength(1);
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
      f === "src/app/cca/_lib/proposalForm.ts" ||
      f.startsWith("src/app/director/") ||
      f === "src/lib/proposals/historyLine.ts",
  );

  it("finds the screens", () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(12);
    expect(SCREENS).toContain(
      "src/app/director/_components/DirectorProposal.tsx",
    );
    expect(SCREENS).toContain("src/app/director/_components/DirectorHome.tsx");
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

describe("approve, return and finish cannot skip the guard", () => {
  const REVIEW = "src/server/api/services/proposals/review.ts";
  const ACCESS = "src/server/api/services/proposals/access.ts";
  const code = () => stripComments(read(REVIEW));

  it("all three go through the one shared move", () => {
    const c = code();
    expect(c.match(/\breviewMove\(db, userID, "/g)).toHaveLength(3);
    for (const action of ["approve", "return", "finish"]) {
      expect(c).toMatch(new RegExp(`reviewMove\\(db, userID, "${action}"`));
    }
    // The shared move is the only caller of the status writer.
    expect(c.match(/\btransitionProposal\(/g)).toHaveLength(1);
  });

  it("the director guard runs first, then the budget, then the move", () => {
    const c = code();
    const guard = c.indexOf("await assertProposalDirector(");
    const limit = c.indexOf("await assertWithinLimit(action, userID)");
    const move = c.indexOf("await transitionProposal(");
    expect(guard).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(guard);
    expect(move).toBeGreaterThan(limit);
    // The CCA the guard is asked about is the STORED row's, never the input's.
    expect(c).toMatch(/assertProposalDirector\(db, userID, row\.ccaID,/);
    expect(c).not.toMatch(/input\.ccaID|input\.cca\b/);
    // The load that supplies it is the first read.
    expect(c.indexOf("db.proposal.findUnique(")).toBeLessThan(guard);
  });

  it("the guard is the strict isDirectorOf, with its read failure refused", () => {
    const c = stripComments(read(ACCESS));
    const start = c.indexOf("export async function assertProposalDirector");
    expect(start).toBeGreaterThan(-1);
    const body = c.slice(start, c.indexOf("\n}\n", start));
    expect(body).toMatch(/await isDirectorOf\(/);
    expect(body).toMatch(/return refuseOnFailure\(err\)/);
  });

  it("the self-approved label is read inside the transaction, from the actor and the stored row", () => {
    const c = code();
    expect(c).toMatch(/selfApproved: \(tx, proposal\) =>/);
    expect(c).toMatch(/readSelfApproved\(tx, userID, proposal\)/);
    // It is never taken from the request.
    expect(c).not.toMatch(/input\.selfApproved|input\.approverID/);
    const schema = stripComments(read("src/lib/schemas/proposal.ts"));
    expect(schema).not.toMatch(/selfApproved|approverID/);
  });

  it("the head's notice is written on the transaction client", () => {
    const c = code();
    expect(c).toMatch(/inTransaction: \(tx, proposal\) =>/);
    expect(c).toMatch(/notify\(tx,/);
    expect(c).not.toMatch(/notify\(db,/);
  });

  it("every move starts from the status the table allows", () => {
    const status = stripComments(read("src/lib/proposals/status.ts"));
    for (const [action, from, to] of [
      ["approve", "in_review", "cleared"],
      ["return", "in_review", "needs_action"],
      ["finish", "cleared", "finished"],
    ] as const) {
      expect(status).toMatch(
        new RegExp(`${action}: \\{ from: "${from}", to: "${to}" \\}`),
      );
    }
  });

  it("the director's views make one guard call each and no per-proposal check", () => {
    const c = stripComments(
      read("src/server/api/services/proposals/directorView.ts"),
    );
    // mustDirectSome (home and queue) and the navigation entry.
    expect(c.match(/directedCcasOrRefuse\(/g)).toHaveLength(2);
    expect(c).not.toMatch(
      /isDirectorOf|currentDirectorIDs|assertProposalDirector/,
    );
    // Drafts are filtered out of the counts (B19) and the queue is in_review.
    expect(c).toMatch(/status: \{ not: "draft" \}/);
    expect(c).toMatch(/status: "in_review"/);
  });

  it("the new files use none of the forgiving reads", () => {
    for (const f of [
      REVIEW,
      "src/server/api/services/proposals/directorView.ts",
      "src/server/api/services/proposals/names.ts",
      "src/app/director/_components/DirectorHome.tsx",
      "src/app/director/_components/DirectorProposal.tsx",
    ]) {
      const c = stripComments(read(f));
      expect(c, f).not.toMatch(/getUserRoles|myPositionCcas|overseesAll/);
      expect(c, f).not.toMatch(/session\.user\.roles|useSession/);
    }
  });
});
