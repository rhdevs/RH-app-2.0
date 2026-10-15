import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Guards the transcript data model WITHOUT a database: it reads
 * prisma/schema.prisma as text. The guarded production collections (CCA,
 * UserCCA, User) silently reject new fields, so the invariants that matter are
 * "we added only new models" and "we changed only CcaProfile".
 */

interface Field {
  name: string;
  /** The rest of the declaration, whitespace-collapsed, e.g. "String? @default(now())". */
  decl: string;
}

function parseModels(schema: string): Map<string, Field[]> {
  const models = new Map<string, Field[]>();
  for (const m of schema
    .replace(/\r\n/g, "\n")
    .matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)) {
    const fields: Field[] = [];
    for (const raw of m[2]!.split("\n")) {
      const line = raw.replace(/\/\/.*$/, "").trim();
      if (!line || line.startsWith("@@")) continue;
      const [name, ...rest] = line.split(/\s+/);
      fields.push({ name: name!, decl: rest.join(" ") });
    }
    models.set(m[1]!, fields);
  }
  return models;
}

const current = parseModels(readFileSync("prisma/schema.prisma", "utf8"));

function upstreamSchema(): string | null {
  try {
    return execFileSync("git", ["show", "upstream/main:prisma/schema.prisma"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // no upstream remote here (for example in CI)
  }
}
const upstream = upstreamSchema();
const upstreamModels = upstream ? parseModels(upstream) : null;

const NEW_MODELS: Record<string, string[]> = {
  // model -> its KEY fields: the columns that identify the row, so required.
  TranscriptPeriod: ["academicYear"],
  TranscriptRosterEntry: ["academicYear", "userID", "ccaID"],
  VolunteerRecord: ["academicYear", "userID"],
  Award: ["academicYear", "userID"],
  JcrcService: ["academicYear", "userID"],
  TranscriptIssue: ["code", "academicYear", "userID", "activeKey"],
};

describe("schema: new transcript models", () => {
  it.each(Object.keys(NEW_MODELS))("%s exists with an ObjectId id", (name) => {
    const fields = current.get(name);

    expect(fields).toBeDefined();
    expect(fields![0]).toEqual({
      name: "id",
      decl: 'String @id @default(auto()) @map("_id") @db.ObjectId',
    });
  });

  it.each(Object.entries(NEW_MODELS))(
    "%s: every non-key scalar is optional, a list, or defaulted",
    (name, keys) => {
      const offenders = current
        .get(name)!
        .filter((f) => f.name !== "id" && !keys.includes(f.name))
        .filter((f) => !/^\S+\?|\[\]|@default\(/.test(f.decl))
        .map((f) => f.name);

      expect(offenders).toEqual([]);
    },
  );

  it.each(Object.entries(NEW_MODELS))(
    "%s: key fields are present and required",
    (name, keys) => {
      const fields = current.get(name)!;
      for (const key of keys) {
        const field = fields.find((f) => f.name === key);
        expect(field, `${name}.${key}`).toBeDefined();
        expect(
          field!.decl.startsWith("String") || field!.decl.startsWith("Int"),
        ).toBe(true);
        expect(field!.decl.split(" ")[0]).not.toMatch(/\?$/);
      }
    },
  );

  it("keys every per-resident model on the canonical userID, not on an ObjectId", () => {
    for (const name of Object.keys(NEW_MODELS).filter(
      (n) => n !== "TranscriptPeriod",
    )) {
      const userID = current.get(name)!.find((f) => f.name === "userID");
      expect(userID?.decl, name).toBe("String");
    }
  });

  it("keys a valid issue uniquely, with a required (never nullable) activeKey", () => {
    const key = current
      .get("TranscriptIssue")!
      .find((f) => f.name === "activeKey");
    expect(key!.decl).toContain('@unique(map: "issue_active_key")');
    expect(key!.decl.startsWith("String ")).toBe(true);
    expect(key!.decl).not.toContain("?");
  });

  it("indexes volunteer records by CCA and year", () => {
    expect(readFileSync("prisma/schema.prisma", "utf8")).toContain(
      '@@index([ccaID, academicYear], map: "volunteer_cca_year")',
    );
  });

  it("makes the issue code unique", () => {
    const code = current.get("TranscriptIssue")!.find((f) => f.name === "code");
    expect(code!.decl).toContain("@unique");
  });
});

describe("schema: guarded collections are untouched", () => {
  // Snapshot of the validator-guarded models as they are on upstream/main.
  const SNAPSHOT: Record<string, string[]> = {
    CCA: ["id", "category", "ccaID", "ccaName"],
    UserCCA: ["id", "ccaID", "userID"],
    User: [
      "id",
      "email",
      "userID",
      "passwordHash",
      "displayName",
      "createdAt",
      "Session",
      "Account",
      "Authenticator",
      "bio",
      "telegramHandle",
      "block",
    ],
  };

  it.each(Object.entries(SNAPSHOT))(
    "%s still has exactly its original fields",
    (name, fields) => {
      expect(current.get(name)!.map((f) => f.name)).toEqual(fields);
    },
  );

  it.each(Object.keys(SNAPSHOT))("%s is identical to upstream/main", (name) => {
    if (!upstreamModels) return; // upstream ref unavailable; the snapshot test above still guards it
    expect(current.get(name)).toEqual(upstreamModels.get(name));
  });

  it("changes only CcaProfile among the models that already existed", () => {
    if (!upstreamModels) return;
    const changed = [...upstreamModels.keys()].filter(
      (name) =>
        JSON.stringify(current.get(name)) !==
        JSON.stringify(upstreamModels.get(name)),
    );

    expect(changed).toEqual(["CcaProfile"]);
  });

  it("records who voided an award or volunteer record, and who last saved a JCRC record", () => {
    const field = (model: string, name: string) =>
      current.get(model)!.find((f) => f.name === name);

    expect(field("Award", "voidedBy")?.decl).toBe("String?");
    expect(field("VolunteerRecord", "voidedBy")?.decl).toBe("String?");
    expect(field("JcrcService", "updatedBy")?.decl).toBe("String?");
  });

  it("adds only the nullable isVolunteering flag to CcaProfile", () => {
    const names = current.get("CcaProfile")!.map((f) => f.name);

    expect(names).toEqual([
      "id",
      "ccaID",
      "description",
      "logoUrl",
      "bannerUrl",
      "updatedAt",
      "updatedBy",
      "isVolunteering",
    ]);
    expect(current.get("CcaProfile")!.at(-1)).toEqual({
      name: "isVolunteering",
      decl: "Boolean?",
    });
  });

  it("adds no model other than the six transcript ones", () => {
    if (!upstreamModels) return;
    const added = [...current.keys()]
      .filter((n) => !upstreamModels.has(n))
      .sort();

    expect(added).toEqual(Object.keys(NEW_MODELS).sort());
  });
});
