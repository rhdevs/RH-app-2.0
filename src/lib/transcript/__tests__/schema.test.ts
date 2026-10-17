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
  Award: ["academicYear", "userID"],
  JcrcService: ["academicYear", "userID"],
  TranscriptAccess: ["academicYear", "userID"],
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

  it("freezes a CCA once per year, with an unfreeze that keeps the document", () => {
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    expect(raw).toContain(
      '@@unique([academicYear, ccaID], map: "freeze_year_cca")',
    );
    const fields = current.get("CcaYearFreeze")!.map((f) => f.name);
    for (const f of [
      "academicYear",
      "ccaID",
      "reason",
      "frozenAt",
      "frozenBy",
    ]) {
      const decl = current
        .get("CcaYearFreeze")!
        .find((x) => x.name === f)!.decl;
      expect(decl.endsWith("?"), f).toBe(false);
    }
    for (const f of [
      "unfrozenAt",
      "unfrozenBy",
      "unfreezeReason",
      "memberCount",
    ]) {
      expect(fields).toContain(f);
    }
    const unfrozen = current
      .get("CcaYearFreeze")!
      .find((f) => f.name === "unfrozenAt");
    expect(unfrozen!.decl).toBe("DateTime?");
  });

  it("stores CCA activities and their participants, indexed and unique", () => {
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    expect(raw).toContain(
      '@@index([academicYear, ccaID], map: "activity_year_cca")',
    );
    expect(raw).toContain(
      '@@unique([activityID, userID], map: "participant_activity_user")',
    );
    expect(raw).toContain(
      '@@index([academicYear, userID], map: "participant_year_user")',
    );
    const activity = current.get("CcaActivity")!.map((f) => f.name);
    for (const f of [
      "academicYear",
      "ccaID",
      "title",
      "description",
      "period",
      "removedAt",
      "removedBy",
      "createdBy",
      "updatedBy",
    ]) {
      expect(activity, f).toContain(f);
    }
    const part = current.get("CcaActivityParticipant")!;
    for (const f of [
      "activityID",
      "academicYear",
      "ccaID",
      "userID",
      "role",
      "description",
      "removedAt",
      "removedBy",
      "addedBy",
    ]) {
      expect(
        part.map((x) => x.name),
        f,
      ).toContain(f);
    }
    expect(part.find((f) => f.name === "activityID")!.decl).toContain(
      "@db.ObjectId",
    );
  });

  it("has no Semester 2 start date: semester labels are chosen by hand", () => {
    const names = current.get("TranscriptPeriod")!.map((f) => f.name);
    expect(names).not.toContain("sem2Start");
    expect(names).toContain("downloadBy");
  });

  it("records only who opened a year: no close, reopen or back-to-collecting stamps", () => {
    const names = current.get("TranscriptPeriod")!.map((f) => f.name);
    expect(names).toContain("publishedAt");
    expect(names).toContain("publishedBy");
    for (const f of [
      "closedAt",
      "closedBy",
      "reopenedAt",
      "reopenedBy",
      "backToCollectingAt",
      "backToCollectingBy",
    ]) {
      expect(names, f).not.toContain(f);
    }
  });

  it("has no issue or verification model any more", () => {
    expect(current.has("TranscriptIssue")).toBe(false);
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    for (const word of ["verificationCode", "supersededBy", "revokedAt"]) {
      expect(raw).not.toContain(word);
    }
  });

  it("records first and last open once per resident and year", () => {
    expect(readFileSync("prisma/schema.prisma", "utf8")).toContain(
      '@@unique([academicYear, userID], map: "access_year_user")',
    );
    const first = current
      .get("TranscriptAccess")!
      .find((f) => f.name === "firstOpenedAt");
    expect(first!.decl).toContain("DateTime?");
  });

  it("stores JCRC contributions as a list of structured rows", () => {
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    expect(raw).toMatch(
      /type JcrcContribution \{\s+activity\s+String\s+role\s+String\?\s+description\s+String\?\s+\}/,
    );
    const field = current
      .get("JcrcService")!
      .find((f) => f.name === "contributions");
    expect(field!.decl).toBe("JcrcContribution[]");
  });

  it("lets a year carry an optional download-by date", () => {
    const field = current
      .get("TranscriptPeriod")!
      .find((f) => f.name === "downloadBy");
    expect(field!.decl).toBe("DateTime?");
  });

  it("stores volunteer activities, sessions, people and attendance, indexed and unique", () => {
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    for (const decl of [
      '@@index([academicYear, ccaID], map: "vact_year_cca")',
      '@@index([activityID], map: "vsession_activity")',
      '@@unique([activityID, userID], map: "vperson_activity_user")',
      '@@index([academicYear, userID], map: "vperson_year_user")',
      '@@unique([sessionID, userID], map: "vattend_session_user")',
      '@@index([academicYear, userID], map: "vattend_year_user")',
    ]) {
      expect(raw, decl).toContain(decl);
    }
    const names = (model: string) => current.get(model)!.map((f) => f.name);
    // Every child repeats the year and the CCA so a year can be purged.
    for (const model of [
      "VolunteerActivity",
      "VolunteerSession",
      "VolunteerPerson",
      "VolunteerAttendance",
    ]) {
      expect(names(model), model).toEqual(
        expect.arrayContaining(["academicYear", "ccaID"]),
      );
    }
    for (const f of ["kind", "defaultHours", "removedAt", "removedBy"]) {
      expect(names("VolunteerActivity"), f).toContain(f);
    }
    expect(names("VolunteerAttendance")).toEqual(
      expect.arrayContaining(["hoursOverride", "markedBy", "markedAt"]),
    );
    for (const [model, field] of [
      ["VolunteerSession", "activityID"],
      ["VolunteerPerson", "activityID"],
      ["VolunteerAttendance", "sessionID"],
      ["VolunteerAttendance", "activityID"],
    ] as const) {
      expect(
        current.get(model)!.find((f) => f.name === field)!.decl,
        `${model}.${field}`,
      ).toContain("@db.ObjectId");
    }
  });

  it("stores the award catalogue (unique by normalised name) and import batches", () => {
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    for (const decl of [
      '@@unique([normalizedName], map: "award_type_name")',
      '@@index([academicYear, awardTypeID], map: "award_year_type")',
      '@@index([academicYear], map: "award_batch_year")',
    ]) {
      expect(raw, decl).toContain(decl);
    }
    const names = (model: string) => current.get(model)!.map((f) => f.name);
    expect(names("Award")).toEqual(
      expect.arrayContaining([
        "awardTypeID",
        "importBatchID",
        "updatedBy",
        "updatedAt",
      ]),
    );
    expect(names("AwardType")).toEqual(
      expect.arrayContaining([
        "name",
        "normalizedName",
        "defaultCitation",
        "archivedAt",
        "archivedBy",
      ]),
    );
    expect(names("AwardType")).not.toContain("academicYear");
    expect(names("AwardImportBatch")).toEqual(
      expect.arrayContaining([
        "academicYear",
        "fileName",
        "rowCount",
        "importedCount",
        "skippedCount",
        "undoneAt",
        "undoneBy",
      ]),
    );
    for (const f of ["awardTypeID", "importBatchID"]) {
      expect(current.get("Award")!.find((x) => x.name === f)!.decl).toContain(
        "@db.ObjectId",
      );
    }
  });

  it("stores per-resident unlocks, withholds, manual memberships and events, keyed by year", () => {
    const raw = readFileSync("prisma/schema.prisma", "utf8");
    for (const decl of [
      '@@index([academicYear, userID], map: "unlock_year_user")',
      '@@index([academicYear, userID], map: "withhold_year_user")',
      '@@unique([academicYear, userID, ccaID], map: "manual_year_user_cca")',
      '@@index([academicYear, userID], map: "revent_year_user")',
      '@unique(map: "unlock_active_key")',
      '@unique(map: "withhold_active_key")',
      '@@index([activityID], map: "vattend_activity")',
      '@@index([importBatchID], map: "award_batch")',
      '@@index([awardTypeID], map: "award_type")',
      '@@index([ccaID], map: "freeze_cca")',
    ]) {
      expect(raw, decl).toContain(decl);
    }
    const names = (model: string) => current.get(model)!.map((f) => f.name);
    expect(names("ResidentUnlock")).toEqual(
      expect.arrayContaining([
        "academicYear",
        "userID",
        "reason",
        "unlockedBy",
        "unlockedAt",
        "relockedBy",
        "relockedAt",
      ]),
    );
    expect(names("ResidentWithhold")).toEqual(
      expect.arrayContaining([
        "reason",
        "withheldBy",
        "withheldAt",
        "releasedBy",
        "releasedAt",
        "releaseNote",
      ]),
    );
    expect(names("ManualMembership")).toEqual(
      expect.arrayContaining([
        "ccaID",
        "duration",
        "roleLabel",
        "roleDuration",
        "extraContribution",
        "removedAt",
        "removedBy",
      ]),
    );
    expect(names("ResidentEvent")).toEqual(
      expect.arrayContaining(["action", "reason", "summary", "actor", "at"]),
    );
  });

  it("lets a JCRC record be removed (soft) with who and when", () => {
    const names = current.get("JcrcService")!.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["removedAt", "removedBy"]));
  });

  it("no longer has the single-record VolunteerRecord model", () => {
    expect(current.has("VolunteerRecord")).toBe(false);
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

  it("records who voided an award, and who last saved a JCRC record", () => {
    const field = (model: string, name: string) =>
      current.get(model)!.find((f) => f.name === name);

    expect(field("Award", "voidedBy")?.decl).toBe("String?");
    expect(field("JcrcService", "updatedBy")?.decl).toBe("String?");
  });

  it("keeps one active unlock or hold per resident and year, and records partial uploads", () => {
    const field = (model: string, name: string) =>
      current.get(model)!.find((f) => f.name === name);
    expect(field("ResidentUnlock", "activeKey")?.decl).toContain(
      "String @unique",
    );
    expect(field("ResidentWithhold", "activeKey")?.decl).toContain(
      "String @unique",
    );
    expect(field("AwardImportBatch", "status")?.decl).toContain("String");
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

  it("adds no model other than the transcript ones", () => {
    if (!upstreamModels) return;
    const added = [...current.keys()]
      .filter((n) => !upstreamModels.has(n))
      .sort();

    expect(added).toEqual(
      [
        ...Object.keys(NEW_MODELS),
        "CcaYearFreeze",
        "CcaActivity",
        "CcaActivityParticipant",
        "VolunteerActivity",
        "VolunteerSession",
        "VolunteerPerson",
        "VolunteerAttendance",
        "AwardType",
        "AwardImportBatch",
        "ResidentUnlock",
        "ResidentWithhold",
        "ManualMembership",
        "ResidentEvent",
      ].sort(),
    );
  });
});
