import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source scans for equipment loans (P19). They read files as text, so they hold
 * without a database:
 *  - only transition.ts moves `EquipmentLoan.status`;
 *  - the loan is created in one place and its status is left to the schema;
 *  - no equipment code uses a forgiving role read or the session's roles;
 *  - the return photo is reached only through its own routes and checks;
 *  - the digest code stays read-only.
 */

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Code only: comments removed so prose can name a symbol, while a quote, a
 * template or a regex holding a comment marker is kept as it is. A quote ends
 * at the end of its line (JSX text can hold a lone apostrophe).
 */
function stripComments(source: string): string {
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
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const under = (dir: string) => walk(path.join(ROOT, dir)).map(rel);

const SERVICES = under("src/server/api/services/equipment");
const ROUTER = "src/server/api/routers/equipment.ts";
const ROUTES = under("src/app/api/equipment-return");
const SCREENS = under("src/app/equipment");
const LIB = under("src/lib/equipment");
const SERVER_FILES = [...SERVICES, ROUTER, ...ROUTES];
const ALL = [
  ...SERVER_FILES,
  ...SCREENS,
  ...LIB,
  "src/lib/schemas/equipment.ts",
];
const TRANSITION = "src/server/api/services/equipment/transition.ts";

describe("equipment loans: where the status is written", () => {
  it("finds the code under scan", () => {
    expect(SERVICES.length).toBeGreaterThanOrEqual(10);
    expect(ROUTES).toHaveLength(2);
    expect(SCREENS.length).toBeGreaterThanOrEqual(8);
  });

  it("only transition.ts writes to an existing loan", () => {
    const writers = ALL.filter((f) =>
      /\bequipmentLoan\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/.test(
        stripComments(read(f)),
      ),
    );
    expect(writers).toEqual([TRANSITION]);
  });

  it("transition.ts moves the status in one compare-and-set on the status, version and CCA seen", () => {
    const code = stripComments(read(TRANSITION));
    expect(code.match(/\.equipmentLoan\.updateMany\(/g)).toHaveLength(1);
    expect(code).toMatch(/status:\s*input\.from/);
    expect(code).toMatch(/version:\s*input\.expectedVersion/);
    expect(code).toMatch(/ccaID:\s*input\.expectedCcaID/);
  });

  it("no other file names a status in a write, and creating a loan leaves it to the schema", () => {
    const create = stripComments(
      read("src/server/api/services/equipment/write.ts"),
    );
    const data =
      /equipmentLoan\.create\(\{[\s\S]*?\n {2}\}\)/.exec(create)?.[0] ?? "";
    expect(data).not.toBe("");
    expect(data).not.toMatch(/\bstatus\b\s*:/);
    expect(read("prisma/schema.prisma")).toMatch(
      /model EquipmentLoan \{[\s\S]*?\n\s*status\s+String\s+@default\("requested"\)/,
    );
    const offenders = SERVER_FILES.filter((f) => f !== TRANSITION).filter((f) =>
      /\bdata\s*:\s*\{[^}]*\bstatus\s*:/.test(stripComments(read(f))),
    );
    expect(offenders).toEqual([]);
  });

  it("only the item code and the approval guard write an item", () => {
    const writers = ALL.filter((f) =>
      /\bequipmentItem\s*\.\s*(create|update|updateMany|upsert|delete|deleteMany)\b/.test(
        stripComments(read(f)),
      ),
    ).sort();
    expect(writers).toEqual([
      "src/server/api/services/equipment/decide.ts",
      "src/server/api/services/equipment/items.ts",
    ]);
  });

  it("the approval guard bumps the version of every item the loan names", () => {
    const code = stripComments(
      read("src/server/api/services/equipment/decide.ts"),
    );
    expect(code).toMatch(/equipmentItem\.updateMany\(/);
    expect(code).toMatch(/version:\s*\{\s*increment:\s*1\s*\}/);
  });
});

describe("equipment loans: strict reads", () => {
  it("no server file uses a forgiving role read or the session's roles", () => {
    for (const f of SERVER_FILES) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/getUserRoles|assertHeadsCca|ccaScope/);
      expect(code, f).not.toMatch(/myPositionCcas|overseesAll/);
      expect(code, f).not.toMatch(
        /session\.user\.roles|ctx\.session\.user\.roles/,
      );
      expect(code, f).not.toMatch(/\bassertAdmin\b|\bsuperAdmin\b/);
    }
  });

  it("the director power is the strict Social director guard, not the CCA-head guard", () => {
    const code = stripComments(
      read("src/server/api/services/equipment/access.ts"),
    );
    expect(code).toMatch(/assertSocialDirector|isSocialDirector/);
    expect(code).not.toMatch(/assertHeadsCca/);
  });

  it("no equipment file names a position collection or flag; the guard module does", () => {
    for (const f of [...SERVER_FILES, ...SCREENS]) {
      expect(stripComments(read(f)), f).not.toMatch(
        /\b(jcrcPosition(Cca|Holder)?|vetsProposals|handlesDisposables)\b/,
      );
    }
  });

  it("every procedure but the two entry reads asserts the flag first", () => {
    const code = stripComments(read(ROUTER));
    expect(code).toMatch(/assertEquipmentEnabled|isEquipmentEnabled/);
  });
});

describe("equipment loans: the return photo", () => {
  it("is never given a public store, a put, or a stored address", () => {
    for (const f of [...SERVER_FILES, ...SCREENS]) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/access:\s*["']public["']/);
      expect(code, f).not.toMatch(/\bput\(/);
      expect(code, f).not.toMatch(/BLOB_READ_WRITE_TOKEN/);
    }
    const schema = read("prisma/schema.prisma");
    const model = /model EquipmentLoan \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model).toMatch(/returnPhoto\s+String\?/);
    expect(model).not.toMatch(/returnPhotoUrl|photoUrl/i);
  });

  it("is shown only through the access-checked route, never by a stored address", () => {
    for (const f of SCREENS) {
      const code = stripComments(read(f));
      expect(code, f).not.toMatch(/blob\.vercel-storage|returnPhoto\b/);
    }
    const panel = stripComments(
      read("src/app/equipment/_components/LoanScreen.tsx"),
    );
    expect(panel).toMatch(/\/api\/equipment-return\//);
  });

  it("notices never carry a pathname, a store address or the photo route", () => {
    const code = stripComments(
      read("src/server/api/services/equipment/notices.ts"),
    );
    expect(code).not.toMatch(
      /returnPhoto|pathname|equipment-return|blob\.vercel|\burl\b/,
    );
    expect(code).toMatch(/equipmentLoanHref/);
  });

  it("only the uploader panel imports the Blob SDK by value, and no server file does", () => {
    const users = [...SERVER_FILES, ...SCREENS, ...LIB].filter((f) =>
      stripComments(read(f))
        .split("\n")
        .some(
          (line) =>
            /\bfrom\s+["']@vercel\/blob(\/client)?["']/.test(line) &&
            !/^\s*import\s+type\b/.test(line),
        ),
    );
    expect(users).toEqual(["src/app/equipment/_components/ReturnPanel.tsx"]);
  });

  it("no Telegram code is part of this change", () => {
    for (const f of ALL) {
      expect(stripComments(read(f)), f).not.toMatch(/telegram/i);
    }
  });
});

describe("equipment loans: the digest stays read-only", () => {
  it("the overdue read has no write and no notice call", () => {
    const code = stripComments(
      read("src/server/api/services/equipment/overdue.ts"),
    );
    expect(code).not.toMatch(
      /\.(create|update|updateMany|delete|deleteMany|upsert)\(|\bnotify\(/,
    );
    expect(code).not.toMatch(/\bcatch\b/);
  });
});

describe("equipment loans: review fixes", () => {
  it("the director note after a return is the same compare-and-set, keeping the status", () => {
    const code = stripComments(read(TRANSITION));
    expect(code.match(/\.equipmentLoan\.updateMany\(/g)).toHaveLength(1);
    expect(code).toMatch(/input\.amend/);
    // The return fields are written only when it is a real return.
    expect(code).toMatch(/input\.to === "returned" && !input\.amend/);
  });

  it("a director cancel is written to its own fields, never to the decision fields", () => {
    const code = stripComments(read(TRANSITION));
    expect(code).toMatch(
      /input\.decision && input\.to === "canceled"[\s\S]*?data\.canceledBy[\s\S]*?data\.canceledAt[\s\S]*?data\.cancelReason[\s\S]*?else if \(input\.decision\)/,
    );
    const create = stripComments(
      read("src/server/api/services/equipment/write.ts"),
    );
    for (const field of ["canceledBy", "canceledAt", "cancelReason"]) {
      expect(create).toContain(`${field}: null`);
    }
  });

  it("no read after a commit sits outside the best-effort notice path", () => {
    const decide = stripComments(
      read("src/server/api/services/equipment/decide.ts"),
    );
    expect(decide).not.toMatch(/titleOf|\bdb\.event\b/);
    const notices = stripComments(
      read("src/server/api/services/equipment/notices.ts"),
    );
    // The title is read at the "title" stage inside the one try/catch in send().
    expect(notices.match(/\bcatch\b/g)).toHaveLength(1);
    expect(notices).toMatch(
      /stage = "title";\s*const \{ title, body \} = n\.compose\(await n\.eventTitle\(\)\)/,
    );
  });

  it("the preview has its own rate limit, and the form waits 400 ms before asking", () => {
    const write = stripComments(
      read("src/server/api/services/equipment/write.ts"),
    );
    expect(write).toMatch(/assertWithinLimit\("check"/);
    const form = stripComments(
      read("src/app/equipment/_components/LoanForm.tsx"),
    );
    expect(form).toMatch(/CHECK_DEBOUNCE_MS\s*=\s*400/);
    expect(form).toMatch(
      /useDebounceValue\(candidateKey,\s*CHECK_DEBOUNCE_MS\)/,
    );
  });

  it("the photo read re-checks the loan folder, and the collect door checks the event", () => {
    const read_ = stripComments(
      read("src/server/api/services/equipment/read.ts"),
    );
    expect(read_).toMatch(
      /returnPhoto\.startsWith\(equipmentPhotoFolder\(id\)\)/,
    );
    const decide = stripComments(
      read("src/server/api/services/equipment/decide.ts"),
    );
    expect(decide).toMatch(/\{\s*guard:\s*collectGuard\s*\}/);
  });
});
