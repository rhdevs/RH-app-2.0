import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans that keep positions out of the old guards (A36), keep the
 * director guard strict (A48, A64) and keep the flags readable from one place.
 * They read files as text, so they hold without a database.
 */

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Code only: block and line comments removed, so prose can name a symbol.
 * A small scanner, not a regex, so that a string literal, a template literal
 * or a regex literal holding `/*` or `//` cannot hide the code after it: those
 * are kept as they are and only real comments go. A quote ends at the end of
 * its line (JSX text can hold a lone apostrophe).
 */
export function stripComments(source: string): string {
  const n = source.length;
  let i = 0;
  let out = "";

  const copyEscaped = () => {
    out += source[i++];
    if (i < n) out += source[i++];
  };
  const scanQuoted = (quote: string) => {
    out += source[i++];
    while (i < n && source[i] !== "\n") {
      if (source[i] === "\\") {
        copyEscaped();
        continue;
      }
      const c = source[i++];
      out += c;
      if (c === quote) return;
    }
  };
  const scanTemplate = () => {
    out += source[i++];
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        copyEscaped();
      } else if (c === "`") {
        out += source[i++];
        return;
      } else if (c === "$" && source[i + 1] === "{") {
        out += "${";
        i += 2;
        scanCode(true);
      } else {
        out += source[i++];
      }
    }
  };
  const scanRegex = () => {
    out += source[i++];
    let inClass = false;
    while (i < n && source[i] !== "\n") {
      const c = source[i];
      if (c === "\\") {
        copyEscaped();
        continue;
      }
      out += c;
      i++;
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) return;
    }
  };
  /** Whether a `/` here starts a regex literal rather than dividing. */
  const startsRegex = () => {
    const before = out.trimEnd();
    if (before === "") return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(before[before.length - 1]!)) {
      return true;
    }
    return /\b(return|typeof|case|in|of|void|delete|throw)$/.test(before);
  };
  function scanCode(inTemplateExpression: boolean) {
    let depth = 0;
    while (i < n) {
      const c = source[i]!;
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        while (i < n && source[i] !== "\n") i++;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        out += " ";
      } else if (c === '"' || c === "'") {
        scanQuoted(c);
      } else if (c === "`") {
        scanTemplate();
      } else if (c === "/" && startsRegex()) {
        scanRegex();
      } else {
        if (inTemplateExpression && c === "{") depth++;
        if (inTemplateExpression && c === "}") {
          if (depth === 0) {
            out += source[i++];
            return;
          }
          depth--;
        }
        out += source[i++];
      }
    }
  }
  scanCode(false);
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

/** The symbols the old guards must never touch. */
const NAMED = [
  "vetsProposals",
  "handlesDisposables",
  "JcrcPosition",
  "JcrcPositionCca",
  "JcrcPositionHolder",
  "myPositionCcas",
];

/**
 * The names the guard and the lock export, read from their source so a new
 * export is covered without editing this list.
 */
function exportedNames(rel: string): string[] {
  const code = stripComments(read(rel));
  return [
    ...code.matchAll(
      /export\s+(?:async\s+)?(?:function|const|type)\s+([A-Za-z_$][\w$]*)/g,
    ),
  ].map((m) => m[1]!);
}
const GUARD_EXPORTS = exportedNames("src/server/api/services/directorGuard.ts");
const LOCK_EXPORTS = exportedNames(
  "src/server/api/services/jcrcPositionLock.ts",
);

/**
 * The module names, wherever they appear: a static `from`, a dynamic
 * `import()`, a `require()`, or the bare name in any string.
 */
const MODULE_PATTERNS = [
  /\bjcrcPositions\b/,
  /\bjcrcPositionLock\b/,
  /\bdirectorGuard\b/,
  /\bjcrcHandover\b/,
  /\bimport\s*\(/,
  /\brequire\s*\(/,
];

export const NAMED_PATTERNS = [
  ...NAMED.map((n) => new RegExp(`\\b${n}\\b`)),
  // The Prisma delegates, spelled with a lower-case first letter.
  /\bjcrcPosition(Cca|Holder)?\b/,
  ...MODULE_PATTERNS,
  // Every function and constant the guard and the lock export.
  ...[...GUARD_EXPORTS, ...LOCK_EXPORTS].map(
    (name) => new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`),
  ),
];

/** The patterns a source file matches once its comments are removed. */
export function violations(source: string): string[] {
  const code = stripComments(source);
  return NAMED_PATTERNS.filter((p) => p.test(code)).map(String);
}

/** A36: the event, points and CCA authorization files. */
const EXISTING_GUARD_FILES = [
  // events
  "src/server/api/routers/event.ts",
  "src/server/api/services/events.ts",
  "src/server/api/services/eventPublish.ts",
  "src/server/api/services/eventLiveEdit.ts",
  "src/server/api/services/eventNotices.ts",
  "src/server/api/services/eventQr.ts",
  // points
  "src/server/api/routers/ccaPoints.ts",
  "src/server/api/routers/auxPoints.ts",
  "src/server/api/services/ccaPointsAccess.ts",
  "src/server/api/services/ccaPointsConfig.ts",
  ...readdirSync(path.join(ROOT, "src/server/api/services/auxPoints"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/server/api/services/auxPoints/${f}`),
  // CCA authorization and the role model they rest on
  "src/server/api/services/ccaScope.ts",
  "src/server/api/services/ccaMembers.ts",
  "src/server/api/services/ccaRoster.ts",
  "src/server/api/services/ccaDirectory.ts",
  "src/server/api/services/ccaApplications.ts",
  "src/server/api/services/ccaRecruitment.ts",
  "src/server/api/routers/cca.ts",
  "src/server/api/routers/ccaAdmin.ts",
  "src/server/api/routers/ccaApplications.ts",
  "src/server/api/routers/ccaApplicationsHead.ts",
  "src/server/api/routers/ccaRecruitment.ts",
  "src/server/api/services/access.ts",
  "src/server/api/services/roles.ts",
  "src/server/api/trpc.ts",
];

describe("A36: existing guards do not read positions or flags", () => {
  it("lists the files it checks, and each one exists", () => {
    expect(EXISTING_GUARD_FILES.length).toBeGreaterThan(25);
    for (const file of EXISTING_GUARD_FILES) {
      expect(() => read(file), file).not.toThrow();
    }
  });

  it.each(EXISTING_GUARD_FILES)("%s names none of the symbols", (file) => {
    expect(violations(read(file)), file).toEqual([]);
  });

  it("reads the guard's and the lock's export names from their source", () => {
    expect(GUARD_EXPORTS).toEqual(
      expect.arrayContaining([
        "isDirectorOf",
        "directedCcaIDs",
        "isSocialDirector",
        "assertDirectorOf",
        "assertSocialDirector",
        "isPositionVacant",
        "isCcaVacant",
        "isDirectorsEnabled",
      ]),
    );
    expect(LOCK_EXPORTS).toEqual(
      expect.arrayContaining(["isFlaggedPosition", "positionTransaction"]),
    );
  });
});

describe("the scan itself (self-tests)", () => {
  it("strips real comments but keeps code after a string holding /*", () => {
    const hidden = `const a = "/*"; const b = vetsProposals; /* gone */ // gone too`;
    const code = stripComments(hidden);
    expect(code).toContain("vetsProposals");
    expect(code).not.toContain("gone");
  });

  it("is not fooled by // or /* inside strings, templates and regexes", () => {
    for (const source of [
      `const u = "http://x"; isDirectorOf(1);`,
      'const t = `//${"/*"}`; isDirectorOf(1);',
      `const r = /\\/\\*/; isDirectorOf(1);`,
      `const r = /["'/*]/; isDirectorOf(1);`,
      `const s = '/*'; const d = 1 / 2; isDirectorOf(1);`,
    ]) {
      expect(stripComments(source), source).toContain("isDirectorOf(1)");
    }
  });

  it("ends a lone apostrophe at the end of its line", () => {
    const code = stripComments(`<p>Can't</p>\nisDirectorOf(1); // note`);
    expect(code).toContain("isDirectorOf(1)");
    expect(code).not.toContain("note");
  });

  it("does not match a name that only a comment mentions", () => {
    expect(
      violations(`// uses vetsProposals\n/* directorGuard */\nconst x = 1;`),
    ).toEqual([]);
  });

  it.each([
    ["a static import", `import { a } from "../services/jcrcPositions";`],
    [
      "a dynamic import()",
      `const m = await import("../services/jcrcPositionLock");`,
    ],
    ["a dynamic import() of an unrelated path", `await import(path);`],
    ["a require()", `const m = require("./directorGuard");`],
    ["a bare module name in a string", `const n = "directorGuard";`],
    ["an exported guard function", `await isSocialDirector(db, id);`],
    ["an exported guard constant", `if (x === DIRECTOR_CHECK_FAILED) {}`],
    ["an exported lock function", `assertMayEditFlaggedPosition(roles);`],
    ["a flag behind a string that holds /*", `const a = "/*"; vetsProposals;`],
    ["a Prisma delegate", `db.jcrcPositionHolder.findMany();`],
  ])("catches %s", (_name, source) => {
    expect(violations(source).length).toBeGreaterThan(0);
  });
});

/** Files that may read positions: the positions files and the two modules. */
const MAY_READ_POSITIONS = [
  "src/server/api/routers/jcrcPositions.ts",
  "src/server/api/services/jcrcPositions.ts",
  "src/server/api/services/jcrcHandover.ts",
  "src/server/api/services/jcrcPositionLock.ts",
  "src/server/api/services/directorGuard.ts",
  // The staff door: one shared edit path and the router that calls it.
  "src/server/api/services/jcrcPositionEdits.ts",
  "src/server/api/routers/jcrcPositionsStaff.ts",
];
const POSITION_DATA =
  /\b(jcrcPosition(Cca|Holder)?|JcrcPosition(Cca|Holder)?|vetsProposals|handlesDisposables)\b/;

describe("only the positions files and the one strict guard read positions", () => {
  const files = walk(path.join(ROOT, "src")).map((f) =>
    path.relative(ROOT, f).split(path.sep).join("/"),
  );

  it("no other file touches the position collections or the flags", () => {
    const offenders = files.filter((f) => {
      if (MAY_READ_POSITIONS.includes(f)) return false;
      // The Positions page shows the flags the router returns.
      if (f.startsWith("src/app/admin/positions/")) return false;
      return POSITION_DATA.test(stripComments(read(f)));
    });
    expect(offenders).toEqual([]);
  });

  it("the guard module is the only one outside the positions files that reads the flags", () => {
    const flagReaders = files.filter((f) =>
      /\b(vetsProposals|handlesDisposables)\b/.test(stripComments(read(f))),
    );
    expect(flagReaders.sort()).toEqual(
      [
        "src/server/api/routers/jcrcPositions.ts",
        "src/server/api/services/directorGuard.ts",
        "src/server/api/services/jcrcPositionLock.ts",
        "src/server/api/services/jcrcPositionEdits.ts",
        // endFlaggedHolderRows: ends a person's director rows when jcrc goes.
        "src/server/api/services/jcrcPositions.ts",
        "src/app/admin/positions/_components/PositionCard.tsx",
        "src/app/admin/positions/_components/DirectorFlags.tsx",
      ].sort(),
    );
  });
});

describe("the strict guard never uses a forgiving read (A48, A64)", () => {
  const code = stripComments(read("src/server/api/services/directorGuard.ts"));

  it("does not import getUserRoles, the session, access.ts or the term helper", () => {
    expect(code).not.toMatch(/getUserRoles/);
    expect(code).not.toMatch(/dropEndedJcrcRole/);
    expect(code).not.toMatch(/\bsession\b/i);
    expect(code).not.toMatch(/from\s+["'][^"']*\/access["']/);
    expect(code).not.toMatch(/from\s+["'][^"']*jcrcTerm["']/);
  });

  it("does not use myPositionCcas, scopeForView or the oversees-all switch", () => {
    expect(code).not.toMatch(/myPositionCcas/);
    expect(code).not.toMatch(/scopeForView|scopeFromPositions|inScope/);
    expect(code).not.toMatch(/overseesAll/);
  });

  it("imports only activeHolderWhere from the positions service", () => {
    const imports = [
      ...code.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["'][^"']*jcrcPositions["']/g,
      ),
    ].map((m) => m[1]!.trim());
    expect(imports).toEqual(["activeHolderWhere"]);
  });

  it("has no try/catch around a database read", () => {
    // The only catches are the forgiving display read and the one that turns
    // a failed decision into a refusal.
    const catches = code.match(/\bcatch\b/g) ?? [];
    expect(catches).toHaveLength(2);
    expect(code).toMatch(/async function refuseUnless/);
    expect(code).toMatch(/export async function isDirectorsEnabled/);
  });
});

describe("the schema", () => {
  const schema = read("prisma/schema.prisma");
  const block = (name: string) => {
    const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    expect(m, `model ${name}`).not.toBeNull();
    return m![1]!;
  };

  it("adds the two optional flags to JcrcPosition and nothing else", () => {
    const body = block("JcrcPosition");
    expect(body).toMatch(/\n\s*vetsProposals\s+Boolean\?\s*(\r?\n|$)/);
    expect(body).toMatch(/\n\s*handlesDisposables\s+Boolean\?\s*(\r?\n|$)/);
  });

  it("has no field named academicYear on any position model", () => {
    for (const model of [
      "JcrcPosition",
      "JcrcPositionCca",
      "JcrcPositionHolder",
      "JcrcTerm",
    ]) {
      expect(block(model)).not.toMatch(/\bacademicYear\b/);
    }
  });

  it("adds no role string, builder or capability for directors", () => {
    for (const file of [
      "src/server/api/services/roles.ts",
      "src/lib/roleNames.ts",
      "src/server/api/trpc.ts",
    ]) {
      expect(stripComments(read(file)), file).not.toMatch(/\bdirectors?\b/i);
    }
  });
});
