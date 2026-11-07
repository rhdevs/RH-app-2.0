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
  return delegateStatusWriteProblems(source, "proposal", "Proposal");
}

/**
 * The same scan for any model: `delegate` is the Prisma client property
 * ("proposal", "disposableRequest") and `collection` the stored name.
 */
export function delegateStatusWriteProblems(
  source: string,
  delegate: string,
  collection: string,
): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  for (const m of code.matchAll(
    new RegExp(`\\.${delegate}\\b(\\s*\\.\\s*(\\w+)\\s*\\()?`, "g"),
  )) {
    const method = m[2];
    if (method === undefined) {
      // `const p = tx.proposal` would hide a write from this scan.
      problems.push(`${delegate} delegate used without a direct method call`);
      continue;
    }
    if (READS.has(method)) continue;
    if (!WRITES.has(method)) {
      problems.push(`unknown ${delegate} method ${method}`);
      continue;
    }
    const open = m.index! + m[0].length - 1;
    let args = callArguments(code, open);
    if (method === "update" || method === "updateMany") {
      // The filter may name a status (that is a read); the data must not.
      const at = args.search(/\bdata\s*:/);
      if (at < 0) {
        problems.push(`${delegate}.${method} without a data key`);
        continue;
      }
      args = args.slice(at);
    }
    if (/\bstatus\b/.test(args)) {
      problems.push(`${delegate}.${method} names status`);
    }
  }
  // A raw command could write the collection without the delegate.
  if (
    /(\$runCommandRaw|\$executeRaw|\$executeRawUnsafe)/.test(code) &&
    new RegExp(`["'\`]${collection}["'\`]`).test(code)
  ) {
    problems.push(`raw command on the ${collection} collection`);
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
    // The claim runs in one transaction with the move of the proposal's
    // disposables request (4.9, A66).
    expect(at("db.$transaction(")).toBeGreaterThan(at("nextEventId(db)"));
    expect(at("tx.proposal.updateMany(")).toBeGreaterThan(
      at("db.$transaction("),
    );
    expect(at("moveProposalRequestToEvent(tx")).toBeGreaterThan(
      at("tx.proposal.updateMany("),
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
    // The only other catches are the two best-effort notices, the bounded
    // retry of a write conflict (P2034) on the claim and its backout, and the
    // log-only catch on the move after the Event exists.
    expect(c.match(/\bcatch\b/g)).toHaveLength(5);
    expect(c).toMatch(/err\.code === "P2034"/);
    expect(c).toMatch(
      /if \(!isWriteConflict\(err\) \|\| tries >= CONFLICT_RETRIES\) throw err;/,
    );
    // The claim and its backout both use it.
    expect(c.match(/await retryOnConflict\(/g)).toHaveLength(2);
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
      if (f.endsWith("/comments.ts")) continue; // first-read race, see below
      if (f.endsWith("/nudge.ts")) continue; // same-day race, see below
      expect(stripComments(read(f)), f).not.toMatch(/\bcatch\b/);
    }
  });

  it("comments.ts and nudge.ts catch only a unique-key race, and rethrow everything else", () => {
    const comments = stripComments(
      read("src/server/api/services/proposals/comments.ts"),
    );
    expect(comments.match(/\bcatch\b/g)).toHaveLength(1);
    expect(comments).toMatch(/if \(!isUniqueViolation\(err\)\) throw err;/);
    const nudge = stripComments(
      read("src/server/api/services/proposals/nudge.ts"),
    );
    expect(nudge.match(/\bcatch\b/g)).toHaveLength(2);
    expect(nudge).toMatch(/NUDGE_TRY_AGAIN/);
    expect(nudge).toMatch(/throw first;/);
  });

  it("every gated proposal procedure runs inside sanitizeErrors", () => {
    const code = stripComments(read("src/server/api/routers/proposal.ts"));
    // The one builder every procedure but `enabled` starts from.
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(/,
    );
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(15);
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

describe("disposables follows the same rules as proposals", () => {
  const TRANSITION_D = "src/server/api/services/disposables/transition.ts";
  const DISPOSABLE_FILES = SRC_FILES.filter(
    (f) =>
      f.startsWith("src/server/api/services/disposables/") ||
      f === "src/server/api/routers/disposable.ts",
  );
  const problems = (src: string) =>
    delegateStatusWriteProblems(src, "disposableRequest", "DisposableRequest");

  it("finds the disposable files", () => {
    expect(DISPOSABLE_FILES).toContain(TRANSITION_D);
    expect(DISPOSABLE_FILES.length).toBeGreaterThanOrEqual(8);
  });

  it("the scan catches a disposable status write and lets reads through", () => {
    expect(
      problems(
        `await tx.disposableRequest.updateMany({ where: {}, data: { status: "approved" } });`,
      ),
    ).toEqual(["disposableRequest.updateMany names status"]);
    expect(problems(`const d = tx.disposableRequest; d.update({});`)).toEqual([
      "disposableRequest delegate used without a direct method call",
    ]);
    expect(
      problems(
        `await db.$runCommandRaw({ update: "DisposableRequest", updates: [] });`,
      ),
    ).toEqual(["raw command on the DisposableRequest collection"]);
    expect(
      problems(
        `await db.disposableRequest.findMany({ where: { status: "pending" } });`,
      ),
    ).toEqual([]);
  });

  it("only transition.ts names a status in a disposable write", () => {
    const isClient = (f: string) => /^\s*["']use client["']/.test(read(f));
    const offenders = SRC_FILES.filter(
      (f) => f !== TRANSITION_D && !isClient(f),
    ).flatMap((f) => problems(read(f)).map((p) => `${f}: ${p}`));
    expect(offenders).toEqual([]);
  });

  it("transition.ts moves the status in one compare-and-set on the status and version seen", () => {
    const code = stripComments(read(TRANSITION_D));
    expect(code.match(/\.disposableRequest\.updateMany\(/g)).toHaveLength(1);
    expect(code.match(/status:\s*input\.to/g)).toHaveLength(2);
    expect(code).toMatch(/status:\s*input\.from/);
    expect(code).toMatch(/version:\s*input\.expectedVersion/);
  });

  it("creating a request leaves the status to the schema default", () => {
    expect(read("prisma/schema.prisma")).toMatch(
      /\n\s*status\s+String\s+@default\("pending"\)/,
    );
    expect(
      stripComments(read("src/server/api/routers/disposable.ts")),
    ).not.toMatch(/\bstatus\b|changeRequest/);
  });

  it("no disposable file uses a forgiving role read", () => {
    for (const f of DISPOSABLE_FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/getUserRoles|assertHeadsCca|ccaScope/);
      expect(code, f).not.toMatch(/myPositionCcas|overseesAll/);
      expect(code, f).not.toMatch(/session\.user\.roles/);
      expect(code, f).not.toMatch(/\bgetServerAuthSession|\bauth\(/);
    }
  });

  it("access.ts catches only around a whole decision, and only to refuse", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/access.ts"),
    );
    // loadViewer, loadFiler, mayFile and headsOrRefuse: one each.
    expect(code.match(/\bcatch\b/g)).toHaveLength(4);
    expect(code.match(/return refuseOnFailure\(err\)/g)).toHaveLength(4);
    expect(code).toMatch(/function refuseOnFailure\(err: unknown\): never/);
  });

  it("the other disposable services catch nothing, apart from the flag read, the conflict mapping, the best-effort filed notice and the best-effort tag", () => {
    for (const f of DISPOSABLE_FILES) {
      if (f.endsWith("/access.ts") || f.endsWith("/flag.ts")) continue;
      if (f.endsWith("/notices.ts")) continue;
      if (f.endsWith("/write.ts")) continue; // best-effort tag, see below
      if (f === TRANSITION_D) continue;
      if (f.endsWith("/nudge.ts")) continue; // same-day race, see below
      expect(stripComments(read(f)), f).not.toMatch(/\bcatch\b/);
    }
  });

  it("nudge.ts catches only a unique-key race or write conflict, and rethrows everything else", () => {
    const nudge = stripComments(
      read("src/server/api/services/disposables/nudge.ts"),
    );
    expect(nudge.match(/\bcatch\b/g)).toHaveLength(2);
    expect(nudge).toMatch(/DISPOSABLE_NUDGE_TRY_AGAIN/);
    expect(nudge).toMatch(/throw first;/);
    expect(nudge).toMatch(/throw err;/);
    // The CCA comes from the stored request, never from the client.
    expect(nudge).not.toMatch(/input\.ccaID/);
  });

  it("notices.ts catches in exactly one place: the best-effort filed notice, which logs a name and never rethrows (#134)", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/notices.ts"),
    );
    expect(code.match(/\bcatch\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/throw err/);
    const start = code.indexOf("export async function noticeFiled");
    const end = code.indexOf(String.fromCharCode(10, 125, 10), start);
    const body = code.slice(start, end);
    expect(body).toMatch(/catch \(err\)/);
    expect(body).toMatch(/notify\(db,/);
    expect(body).toMatch(/currentSocialDirectorIDs\(db\)/);
    expect(body).toMatch(/id\.trim\(\) !== ""/);
  });

  it("write.ts catches in exactly one place: the best-effort tag after the save, which logs a name and never rethrows (#138)", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/write.ts"),
    );
    expect(code.match(/\bcatch\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/throw err/);
    const at = code.indexOf("try {");
    const body = code.slice(at, code.indexOf("noticeFiled(db,", at));
    expect(body).toMatch(
      /await tagIfProposalGotAnEvent\(db, made\.id, target\)/,
    );
    expect(body).toMatch(/catch \(err\)/);
    expect(body).toMatch(/err instanceof Error \? err\.name : typeof err/);
    expect(body).not.toMatch(/err\.message/);
  });

  it("transition.ts rethrows everything but a write conflict", () => {
    const code = stripComments(read(TRANSITION_D));
    expect(code.match(/\bcatch\b/g)).toHaveLength(2);
    expect(
      code.match(/if \(isWriteConflict\(err\)\) throw conflict\(\)/g),
    ).toHaveLength(2);
    // each catch passes a TRPCError through, then rethrows what is left
    expect(code.match(/throw err;/g)).toHaveLength(4);
  });

  it("every gated disposable procedure runs inside sanitizeErrors, behind the flag", () => {
    const code = stripComments(read("src/server/api/routers/disposable.ts"));
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(/,
    );
    expect(code).toMatch(/await assertDisposablesEnabled\(ctx\.db\)/);
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(12);
    expect(code.match(/^ {2}\w+: protectedProcedure/gm)).toHaveLength(1);
    expect(code).toMatch(
      /entry: identifiedProcedure\s*\.use\(sanitizeErrors\)/,
    );
  });

  it("approve and reject run the strict Social director guard first, then the budget, then the move", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/write.ts"),
    );
    const start = code.indexOf("export async function decideRequest");
    const body = code.slice(start, code.indexOf("\n}\n", start));
    const guard = body.indexOf("await assertSocialDirector(db, userID)");
    const limit = body.indexOf("await assertWithinLimit(");
    const move = body.indexOf("await changeRequest(");
    expect(guard).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(guard);
    expect(move).toBeGreaterThan(limit);
    expect(code).not.toMatch(/input\.ccaID\b.*decide/);
  });

  it("update and delete run the strict Social director guard first, and a head has no edit path (A9)", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/write.ts"),
    );
    for (const fn of ["updateRequest", "deleteRequest"]) {
      const start = code.indexOf(`export async function ${fn}`);
      const end = code.indexOf(String.fromCharCode(10, 125, 10), start);
      const body = code.slice(start, end);
      const guard = body.indexOf("await assertSocialDirector(db, userID)");
      const limit = body.indexOf("await assertWithinLimit(");
      expect(guard, fn).toBeGreaterThan(-1);
      expect(limit, fn).toBeGreaterThan(guard);
      expect(body.indexOf("findUnique"), fn).toBeGreaterThan(limit);
    }
    expect(code).not.toMatch(/loadViewer|headedCcaIDs|HEAD_EDITABLE/);
    expect(code).not.toMatch(/noticeEditedByHead/);
    // The digest and the nudge are not edits: they sit in other files.
    expect(code).not.toMatch(/collectionDigest|nudgeSocialDirector/);
    expect(stripComments(read("src/lib/disposables/actions.ts"))).not.toMatch(
      /headsCca|HEAD_EDITABLE/,
    );
  });

  it("the router maps only the proposal index violation, in the middleware, not in a catch", () => {
    const code = stripComments(read("src/server/api/routers/disposable.ts"));
    expect(code).toMatch(
      /\.use\(sanitizeErrors\)\s*\.use\(\s*mapUniqueViolation\(\s*DISPOSABLE_PROPOSAL_INDEX,\s*DISPOSABLE_PROPOSAL_TAKEN,?\s*\)/,
    );
    expect(code).not.toMatch(/catch/);
  });

  it("create works out the CCA from the stored event, checks who may file, then spends budget", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/write.ts"),
    );
    const target = code.indexOf("await resolveTarget(db, input)");
    const head = code.indexOf("await assertCanFile(db, userID, target.ccaID)");
    const limit = code.indexOf('assertWithinLimit("create"');
    const problem = code.indexOf("target.problem");
    const taggable = code.indexOf("assertTaggable(target");
    expect(target).toBeGreaterThan(-1);
    expect(head).toBeGreaterThan(target);
    expect(limit).toBeGreaterThan(head);
    // A stranger is refused before they learn anything about the event, and the
    // CCA is never an input.
    expect(problem).toBeGreaterThan(head);
    expect(taggable).toBeGreaterThan(head);
    expect(code).not.toMatch(/input\.ccaID/);
  });

  it("filing for a CCA's event never lets an admin or JCRC member through", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/access.ts"),
    );
    const start = code.indexOf("export async function mayFile");
    const body = code.slice(start, code.indexOf("\n}\n", start));
    // A CCA's event: the heads only. Hall-wide: a live jcrc or an admin.
    expect(body).toMatch(
      /if \(ccaID !== null\) return \(await headedCcas\(db, userID\)\)\.includes\(ccaID\);/,
    );
    expect(body).toMatch(/holdsLiveJcrc/);
    expect(body).toMatch(/holdsStoredAdmin/);
  });

  it("the tag is not editable: update takes no event or proposal", () => {
    const schema = stripComments(read("src/lib/schemas/disposable.ts"));
    const start = schema.indexOf("export const disposableUpdateInput");
    const body = schema.slice(start, schema.indexOf(");", start));
    expect(body).not.toMatch(/eventID|proposalID|ccaID/);
    const write = stripComments(
      read("src/server/api/services/disposables/write.ts"),
    );
    const update = write.slice(
      write.indexOf("export async function updateRequest"),
    );
    expect(update).not.toMatch(/eventID|proposalID|eventTitle/);
  });

  it("the notices are written on the transaction client", () => {
    const code = stripComments(
      read("src/server/api/services/disposables/notices.ts"),
    );
    expect(code).toMatch(/notify\(tx,/);
    // The one exception is the filed notice: it runs after the request is
    // saved, on the plain client, and is best effort.
    expect(code.match(/notify\(db,/g)).toHaveLength(1);
  });
});

describe("reminders (broadcasts, digest and nudges) follow the same rules", () => {
  const WRITE = "src/server/api/services/reminders/write.ts";
  const ACCESS = "src/server/api/services/reminders/access.ts";
  const REMINDER_FILES = SRC_FILES.filter(
    (f) =>
      f.startsWith("src/server/api/services/reminders/") ||
      f === "src/server/api/routers/reminder.ts" ||
      f === "src/server/api/services/disposables/digest.ts" ||
      f === "src/server/api/services/dueCheck/collectionDigest.ts" ||
      f === "src/server/api/services/dueCheck/broadcastNudge.ts",
  );
  const problems = (src: string) =>
    delegateStatusWriteProblems(src, "reminderBroadcast", "ReminderBroadcast");

  it("finds the reminder files", () => {
    expect(REMINDER_FILES).toContain(WRITE);
    expect(REMINDER_FILES).toContain(ACCESS);
    expect(REMINDER_FILES.length).toBeGreaterThanOrEqual(9);
  });

  it("only write.ts names a status in a broadcast write, and only to cancel", () => {
    const isClient = (f: string) => /^\s*["']use client["']/.test(read(f));
    const offenders = SRC_FILES.filter(
      (f) => f !== WRITE && !isClient(f),
    ).flatMap((f) => problems(read(f)).map((p) => `${f}: ${p}`));
    expect(offenders).toEqual([]);
    const code = stripComments(read(WRITE));
    expect(code.match(/\.reminderBroadcast\.updateMany\(/g)).toHaveLength(1);
    expect(code.match(/status:\s*BROADCAST_CANCELLED/g)).toHaveLength(1);
    // Created with the schema default, and no raw command touches the collection.
    expect(code).not.toMatch(/reminderBroadcast\.create\([^)]*status/s);
    expect(code).not.toMatch(/runCommandRaw/);
  });

  it("no reminder file uses a forgiving role read or the session's roles", () => {
    for (const f of REMINDER_FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/getUserRoles|assertHeadsCca|ccaScope/);
      expect(code, f).not.toMatch(/myPositionCcas|overseesAll/);
      expect(code, f).not.toMatch(/session\.user\.roles/);
      expect(code, f).not.toMatch(/\bgetServerAuthSession|\bauth\(/);
    }
  });

  it("access.ts catches only around a whole decision, and only to refuse", () => {
    const code = stripComments(read(ACCESS));
    expect(code.match(/\bcatch\b/g)).toHaveLength(3);
    expect(code.match(/return refuseOnFailure\(err\)/g)).toHaveLength(3);
    expect(code).toMatch(/function refuseOnFailure\(err: unknown\): never/);
  });

  it("nothing else in the reminder files catches, apart from the flag read", () => {
    for (const f of REMINDER_FILES) {
      if (f === ACCESS || f.endsWith("/flag.ts")) continue;
      expect(stripComments(read(f)), f).not.toMatch(/\bcatch\b/);
    }
  });

  it("every gated reminder procedure runs inside sanitizeErrors, behind the flag", () => {
    const code = stripComments(read("src/server/api/routers/reminder.ts"));
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(/,
    );
    expect(code).toMatch(/await assertRemindersEnabled\(ctx\.db\)/);
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(7);
    expect(code.match(/^ {2}\w+: protectedProcedure/gm)).toHaveLength(1);
    expect(code).toMatch(
      /entry: identifiedProcedure\s*\.use\(sanitizeErrors\)/,
    );
    // The sender and the CCA are never read from the client, only named to check.
    expect(code).not.toMatch(/input\.(createdBy|userID|sender)/);
  });

  it("send checks every CCA with the strict guard before the budget and the write, and again inside the transaction", () => {
    const code = stripComments(read(WRITE));
    const start = code.indexOf("export async function sendBroadcast");
    const body = code.slice(start, code.indexOf("\n}\n", start));
    const guard = body.indexOf(
      "await assertDirectsAll(db, userID, input.ccaIDs)",
    );
    const limit = body.indexOf('await assertWithinLimit("send"');
    const tx = body.indexOf("db.$transaction(");
    const again = body.indexOf(
      "await assertDirectsAll(tx, userID, input.ccaIDs)",
    );
    expect(guard).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(guard);
    expect(tx).toBeGreaterThan(limit);
    expect(again).toBeGreaterThan(tx);
    // Rows and notices share one transaction client; targets go in one write.
    expect(body).toMatch(/notify\(tx,/);
    expect(body).not.toMatch(/notify\(db,/);
    expect(body.match(/reminderTarget\.createMany\(/g)).toHaveLength(1);
    expect(body).toMatch(/headsOfOrRefuse\(tx,/);
  });

  it("cancel and mark-done read the guard before they look the row up, and spend budget only after", () => {
    const code = stripComments(read(WRITE));
    for (const [fn, guardCall, lookupCall] of [
      [
        "cancelBroadcast",
        "await directedOrRefuse(db, userID)",
        "reminderTarget.findMany",
      ],
      [
        "markDone",
        "await headedOrRefuse(db, userID)",
        "reminderTarget.findUnique",
      ],
    ] as const) {
      const start = code.indexOf(`export async function ${fn}`);
      const body = code.slice(start, code.indexOf("\n}\n", start));
      const guard = body.indexOf(guardCall);
      const lookup = body.indexOf(lookupCall);
      const limit = body.indexOf("await assertWithinLimit(");
      expect(guard, fn).toBeGreaterThan(-1);
      expect(lookup, fn).toBeGreaterThan(guard);
      expect(limit, fn).toBeGreaterThan(lookup);
    }
  });

  it("the due kinds read their flag strictly and write only through the runner", () => {
    for (const f of [
      "src/server/api/services/dueCheck/collectionDigest.ts",
      "src/server/api/services/dueCheck/broadcastNudge.ts",
    ]) {
      const code = stripComments(read(f));
      expect(code, f).toMatch(/db\.systemFlag\.findUnique/);
      expect(code, f).not.toMatch(
        /isDisposablesEnabled|isRemindersEnabled|notify\(|\.create\(|\.update|\.delete/,
      );
    }
  });
});

describe("milestone evidence follows the same rules, and never touches the public store", () => {
  const ACCESS = "src/server/api/services/milestones/access.ts";
  const BLOB = "src/server/api/services/milestoneBlob.ts";
  const PANEL = "src/app/cca/_components/EvidencePanel.tsx";
  const GUARDED = SRC_FILES.filter(
    (f) =>
      f.startsWith("src/server/api/services/milestones/") ||
      f === "src/server/api/routers/milestoneEvidence.ts" ||
      f === "src/server/api/routers/milestone.ts" ||
      f === "src/server/api/services/dueCheck/milestoneReminders.ts",
  );
  const EVIDENCE_FILES = SRC_FILES.filter(
    (f) =>
      GUARDED.includes(f) ||
      f.startsWith("src/app/api/milestone-evidence/") ||
      f === BLOB ||
      f === PANEL ||
      f === "src/app/cca/_lib/evidenceErrors.ts" ||
      f === "src/lib/schemas/milestoneEvidence.ts" ||
      f === "src/lib/boundedStream.ts",
  );
  const valueImportsOfBlobSdk = (code: string) =>
    code
      .split("\n")
      .filter(
        (line) =>
          /\bfrom\s+["']@vercel\/blob(\/client)?["']/.test(line) &&
          !/^\s*import\s+type\b/.test(line),
      );

  it("finds the evidence files", () => {
    expect(GUARDED).toContain(ACCESS);
    expect(GUARDED.length).toBeGreaterThanOrEqual(6);
    expect(EVIDENCE_FILES).toContain(BLOB);
    expect(EVIDENCE_FILES).toContain(PANEL);
    expect(
      EVIDENCE_FILES.filter((f) =>
        f.startsWith("src/app/api/milestone-evidence/"),
      ),
    ).toHaveLength(2);
  });

  it("no evidence service uses a forgiving role read or the session's roles", () => {
    for (const f of GUARDED) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/getUserRoles|assertHeadsCca|ccaScope/);
      expect(code, f).not.toMatch(/myPositionCcas|overseesAll/);
      expect(code, f).not.toMatch(/session\.user\.roles/);
      expect(code, f).not.toMatch(/\bgetServerAuthSession|\bauth\(/);
    }
  });

  it("access.ts catches only around a whole decision, and only to refuse", () => {
    const code = stripComments(read(ACCESS));
    expect(code.match(/\bcatch\b/g)).toHaveLength(3);
    expect(code.match(/return refuseOnFailure\(err\)/g)).toHaveLength(3);
    expect(code).toMatch(/function refuseOnFailure\(err: unknown\): never/);
  });

  it("nothing else in the evidence services catches, apart from the flag read", () => {
    for (const f of GUARDED) {
      if (f === ACCESS) continue;
      const catches = stripComments(read(f)).match(/\bcatch\b/g) ?? [];
      expect(catches, f).toHaveLength(f.endsWith("/flag.ts") ? 1 : 0);
    }
  });

  it("every gated evidence procedure runs inside sanitizeErrors, behind the flag", () => {
    const code = stripComments(
      read("src/server/api/routers/milestoneEvidence.ts"),
    );
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(/,
    );
    expect(code).toMatch(/await assertMilestonesEnabled\(ctx\.db\)/);
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(3);
    expect(code.match(/^ {2}\w+: protectedProcedure/gm)).toHaveLength(1);
    // The CCA is only ever named to be checked; the uploader is the session's.
    expect(code).not.toMatch(/input\.(uploadedBy|userID)/);
  });

  it("the milestone router is gated, maps its races, and takes no person from the body", () => {
    const code = stripComments(read("src/server/api/routers/milestone.ts"));
    expect(code).toMatch(
      /const gated = identifiedProcedure\s*\.use\(sanitizeErrors\)\s*\.use\(mapUniqueViolation\("milestone_submission_key"[^)]*\)\)\s*\.use\(mapWriteConflict\(/,
    );
    expect(code).toMatch(/await assertMilestonesEnabled\(ctx\.db\)/);
    expect(code.match(/^ {2}\w+: gated/gm)).toHaveLength(7);
    expect(code.match(/^ {2}\w+: protectedProcedure/gm)).toHaveLength(1);
    expect(code).not.toMatch(/input\.(uploadedBy|userID|headBy|assessedBy)\b/);
  });

  it("the reminder kind reads the flag strictly and writes nothing itself", () => {
    const code = stripComments(
      read("src/server/api/services/dueCheck/milestoneReminders.ts"),
    );
    expect(code).not.toMatch(/\bcatch\b/);
    expect(code).not.toMatch(/\.(create|update|upsert|delete)\w*\(/);
    expect(code).not.toMatch(/isMilestonesEnabled/);
    expect(code).toContain("due.milestones:" + "$" + "{dayKey}");
  });

  it("the serving route checks the session, then the access service, then reads the store", () => {
    const code = stripComments(
      read("src/app/api/milestone-evidence/[id]/route.ts"),
    );
    const session = code.indexOf("await auth()");
    const access = code.indexOf("await authorizeEvidenceRead(");
    const store = code.indexOf("evidenceStorage.read(");
    expect(session).toBeGreaterThan(-1);
    expect(access).toBeGreaterThan(session);
    expect(store).toBeGreaterThan(access);
    // Bytes are proxied: no redirect, no store address in a response.
    expect(code).not.toMatch(/redirect|NextResponse\.next|\.url\b|Location/);
    expect(code).toMatch(/private, no-store/);
    expect(code).toMatch(/X-Content-Type-Options/);
  });

  it("the upload route checks the session before it looks at the store", () => {
    const code = stripComments(
      read("src/app/api/milestone-evidence/upload/route.ts"),
    );
    expect(code.indexOf("await auth()")).toBeGreaterThan(-1);
    expect(code.indexOf("await auth()")).toBeLessThan(
      code.indexOf("handleEvidenceUpload("),
    );
    expect(code).toMatch(/authorizeEvidenceUpload\(/);
    expect(code).not.toMatch(/onUploadCompleted/);
  });

  it("evidence code never calls the public event, CCA or proposal upload paths", () => {
    for (const f of EVIDENCE_FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(
        /api\/(event|cca|proposal)\/upload|proposalPosterBlob|uploadEventImage/,
      );
      expect(code, f).not.toMatch(/access:\s*["']public["']/);
      expect(code, f).not.toMatch(/\bput\(/);
    }
  });

  it("only the one storage module and the uploader component use the Blob SDK", () => {
    const users = EVIDENCE_FILES.filter(
      (f) => valueImportsOfBlobSdk(stripComments(read(f))).length > 0,
    );
    expect(users.sort()).toEqual([BLOB, PANEL].sort());
  });

  it("no file outside the evidence code imports the private storage module", () => {
    const importers = SRC_FILES.filter((f) =>
      /milestoneBlob["']/.test(stripComments(read(f))),
    );
    for (const f of importers) expect(EVIDENCE_FILES, f).toContain(f);
    expect(importers.length).toBeGreaterThanOrEqual(3);
  });

  it("the public store's token is named once, to compare, and never passed to the SDK", () => {
    const publicToken = /(?<![A-Z_])BLOB_READ_WRITE_TOKEN/g;
    for (const f of EVIDENCE_FILES) {
      if (f === BLOB) continue;
      expect(stripComments(read(f)), f).not.toMatch(publicToken);
    }
    const code = stripComments(read(BLOB));
    expect(code.match(publicToken)).toHaveLength(1);
    expect(code).toMatch(/const publicToken = env\.BLOB_READ_WRITE_TOKEN/);
    // Every SDK call names the private token, and none can omit it.
    expect(code.match(/\btoken:\s+(?!string\b)/g)).toHaveLength(5);
    expect(code.match(/\btoken: evidenceToken\(\)/g)).toHaveLength(5);
    expect(code).toMatch(/get\(pathname,\s*\{\s*access: "private",/);
    expect(code).not.toMatch(/access:\s*["']public["']/);
  });

  it("head and del are given the full address, never a bare pathname", () => {
    const code = stripComments(read(BLOB));
    expect(code).toMatch(/head\(blobAddress\(pathname\),/);
    expect(code).toMatch(/del\(blobAddress\(pathname\),/);
    expect(code).not.toMatch(/\bawait (head|del)\(pathname/);
  });

  it("the upload token is short-lived, and the serving route sends no length header", () => {
    const upload = stripComments(
      read("src/app/api/milestone-evidence/upload/route.ts"),
    );
    expect(upload).toMatch(
      /validUntil: Date\.now\(\) \+ EVIDENCE_TOKEN_VALID_MS/,
    );
    const serve = stripComments(
      read("src/app/api/milestone-evidence/[id]/route.ts"),
    );
    expect(serve).not.toMatch(/Content-Length/i);
  });

  it("a full CCA never deletes the file it refused, and no log names an error by its bare name", () => {
    const write = stripComments(
      read("src/server/api/services/milestones/write.ts"),
    );
    // Stale rows, files with no row, a bad file, an explicit removal: no others.
    expect(write.match(/storage\.remove\(/g)).toHaveLength(4);
    // The cap check in recordEvidence is the last one, just before the create.
    const capStart = write.lastIndexOf(
      "if (held >= EVIDENCE_MAX_UNATTACHED) {",
    );
    const capEnd = write.indexOf("db.milestoneEvidence.create", capStart);
    expect(capStart).toBeGreaterThan(-1);
    expect(capEnd).toBeGreaterThan(capStart);
    expect(write.slice(capStart, capEnd)).not.toMatch(/remove/);
    for (const f of EVIDENCE_FILES) {
      if (f.endsWith("/access.ts") || f === BLOB) continue;
      expect(stripComments(read(f)), f).not.toMatch(/\.name : typeof/);
    }
  });

  it("the uploader sends to the private store only", () => {
    const code = stripComments(read(PANEL));
    expect(code).toMatch(/access:\s*"private"/);
    expect(code).toMatch(
      /handleUploadUrl:\s*"\/api\/milestone-evidence\/upload"/,
    );
    expect(code).not.toMatch(/["']public["']/);
    // Thumbnails are the app's own route; no store address is ever rendered.
    expect(code).toMatch(/\/api\/milestone-evidence\/\$\{p\.id\}/);
    expect(code).not.toMatch(/blob\.vercel-storage|\.url\}/);
  });
});
