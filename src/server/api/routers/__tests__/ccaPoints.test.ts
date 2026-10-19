import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeCapabilities } from "~/server/api/services/roles";

// The router module pulls in NextAuth and Prisma through trpc.ts; neither is
// needed to exercise access checks, so both are replaced.
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/routers/admin", () => ({ writeAudit: vi.fn() }));
vi.mock("~/server/api/services/access", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "~/server/api/services/access",
  )),
  getUserRoles: vi.fn(),
}));
vi.mock("~/server/api/services/ccaDirectory", () => ({
  buildDirectoryEntries: vi.fn(),
}));
vi.mock("~/server/api/services/ccaRoster", () => ({ resolveRoster: vi.fn() }));

import { ccaPointsRouter } from "~/server/api/routers/ccaPoints";
import { writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import { buildDirectoryEntries } from "~/server/api/services/ccaDirectory";
import { resolveRoster } from "~/server/api/services/ccaRoster";
import { pointsErrorCopy } from "~/app/admin/points/_components/errorCopy";
import { DEFAULT_RANGE } from "~/lib/points/constants";
import { createCallerFactory } from "~/server/api/trpc";

const createCaller = createCallerFactory(ccaPointsRouter);

const USER = "E1234567";
const mockedRoles = vi.mocked(getUserRoles);
const mockedAudit = vi.mocked(writeAudit);
const mockedEntries = vi.mocked(buildDirectoryEntries);

function caller(db: unknown, sessionRoles: string[]) {
  return createCaller({
    db,
    headers: new Headers(),
    session: {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        userID: USER,
        roles: sessionRoles,
        eligible: true,
        credentialsStale: false,
      },
    },
  } as never);
}

/** A database that fails the test if anything reaches it. */
const untouchedDb = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`db.${String(prop)} was touched`);
    },
  },
);

/** The only tables getEntryContext reads, with CcaHead rows for the given pairs. */
function headDb(heads: { userID: string; ccaID: number }[]) {
  return {
    ccaHead: {
      findUnique: vi.fn(
        async (args: {
          where: { userID_ccaID: { userID: string; ccaID: number } };
        }) => {
          const k = args.where.userID_ccaID;
          return heads.some((h) => h.userID === k.userID && h.ccaID === k.ccaID)
            ? { id: "row" }
            : null;
        },
      ),
    },
    ccaPointsConfig: { findUnique: vi.fn(async () => null) },
    cCA: { findFirst: vi.fn(async () => null) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ccaPoints.getEntryContext", () => {
  it("returns the context to a head of that CCA", async () => {
    const db = headDb([{ userID: USER, ccaID: 9005 }]);
    const result = await caller(db, ["cca_head"]).getEntryContext({
      ccaID: 9005,
    });
    expect(result).toMatchObject({
      entryOpen: false,
      isWaived: false,
      flatPoints: null,
    });
  });

  it("refuses a JCRC member who holds no CcaHead row for that CCA", async () => {
    const db = headDb([]);
    await expect(
      caller(db, ["jcrc"]).getEntryContext({ ccaID: 9005 }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_A_HEAD_OF_THIS_CCA",
    });
  });

  it("refuses a head of a different CCA", async () => {
    const db = headDb([{ userID: USER, ccaID: 9006 }]);
    await expect(
      caller(db, ["cca_head"]).getEntryContext({ ccaID: 9005 }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_A_HEAD_OF_THIS_CCA",
    });
  });
});

describe("JCRC procedures re-check the LIVE roles", () => {
  const calls: [string, (c: ReturnType<typeof caller>) => Promise<unknown>][] =
    [
      ["getConfig", (c) => c.getConfig()],
      ["setEntryOpen", (c) => c.setEntryOpen({ open: true })],
      [
        "setDefault",
        (c) => c.setDefault({ meanMin: 10, meanMax: 14, sdMin: 2, sdMax: 5 }),
      ],
      [
        "setOverride",
        (c) => c.setOverride({ ccaID: 1, meanMin: 12, note: "Test waiver" }),
      ],
      ["clearOverride", (c) => c.clearOverride({ ccaID: 1 })],
      ["setFlat", (c) => c.setFlat({ ccaID: 1, flatPoints: 10 })],
      ["clearFlat", (c) => c.clearFlat({ ccaID: 1 })],
      ["setType", (c) => c.setType({ ccaID: 1, type: "1x" })],
      ["setIhg", (c) => c.setIhg({ ccaID: 1, result: "1st", cap: 12 })],
      ["setSport", (c) => c.setSport({ ccaID: 1, isSport: true })],
      ["startNewPointsYear", (c) => c.startNewPointsYear()],
      ["bundleExportData", (c) => c.bundleExportData()],
    ];

  it.each(calls)(
    "%s is FORBIDDEN when the session claims jcrc but the live roles do not",
    async (_name, call) => {
      mockedRoles.mockResolvedValue([]);
      await expect(
        call(caller(untouchedDb, ["admin", "jcrc"])),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "CAPABILITY_REQUIRED:manageCcaPointsRanges",
      });
      expect(mockedAudit).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    "%s is FORBIDDEN when the live roles are only scrc",
    async (_name, call) => {
      mockedRoles.mockResolvedValue(["scrc"]);
      await expect(call(caller(untouchedDb, ["jcrc"]))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    },
  );

  it("refuses a session that has no manager role at all", async () => {
    await expect(
      caller(untouchedDb, ["resident"]).getConfig(),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "INSUFFICIENT_ROLE",
    });
  });
});

describe("ccaPoints.bundleExportData", () => {
  const row = (scope: string, patch: Record<string, unknown>) => ({
    scope,
    ccaID: Number(scope.slice(4)),
    flatPoints: null,
    meanMin: null,
    meanMax: null,
    sdMin: null,
    sdMax: null,
    note: null,
    ccaType: null,
    ihgResult: null,
    ihgCap: null,
    isSport: null,
    updatedAt: new Date(),
    updatedBy: null,
    ...patch,
  });

  function bundleDb(
    rows: Record<string, unknown>[],
    ccas: unknown[],
    defaultRow: Record<string, unknown> | null = null,
  ) {
    return {
      ccaPointsConfig: {
        findUnique: vi.fn(async () => defaultRow),
        findMany: vi.fn(async () => rows),
      },
      cCA: { findMany: vi.fn(async () => ccas) },
    };
  }

  function mockChoirRoster() {
    mockedEntries.mockResolvedValue({
      cca: { ccaID: 5, ccaName: "Test Choir", category: null },
      entries: [
        {
          rowKey: "u:1",
          resolved: true,
          role: "Member",
          name: "Test Member 1",
          email: "test1@u.nus.edu",
          userID: "E0000001",
          matric: "A9900001Z",
          block: 3,
          telegramHandle: "@test1",
          bio: "private bio",
          membershipRecords: 1,
          joinedAt: null,
          note: null,
        },
        {
          rowKey: "k:E0000002",
          resolved: false,
          role: "Member",
          name: null,
          email: null,
          userID: "E0000002",
          matric: null,
          block: null,
          telegramHandle: null,
          bio: null,
          membershipRecords: 0,
          joinedAt: null,
          note: "Unmatched record — no account matches this membership key.",
        },
      ],
    } as never);
  }

  it("returns config, every CCA and the flat rosters, and audits once with counts only", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const db = bundleDb(
      [
        row("cca:9101", { meanMin: 12, note: "Small CCA", ccaType: "1x" }),
        row("cca:5", { flatPoints: 7.5 }),
        row("cca:7", { ccaType: "0.5x", ihgResult: "1st", ihgCap: 12 }),
      ].sort((a, b) => a.ccaID - b.ccaID),
      [
        { ccaID: 5, ccaName: "Test Choir", category: "Performing Arts" },
        { ccaID: 7, ccaName: "Test Dance", category: "Sports Activities" },
        { ccaID: 9101, ccaName: "Test Drama", category: "Performing Arts" },
      ],
    );
    mockChoirRoster();

    const result = await caller(db, ["jcrc"]).bundleExportData();

    expect(db.cCA.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { ccaID: true, ccaName: true, category: true },
        orderBy: { ccaID: "asc" },
      }),
    );
    expect(result.ccas).toEqual([
      {
        ccaID: 5,
        ccaName: "Test Choir",
        flatPoints: 7.5,
        type: null,
        isSport: false,
        ihgResult: null,
        ihgCap: null,
      },
      {
        ccaID: 7,
        ccaName: "Test Dance",
        flatPoints: null,
        type: "0.5x",
        isSport: true,
        ihgResult: "1st",
        ihgCap: 12,
      },
      {
        ccaID: 9101,
        ccaName: "Test Drama",
        flatPoints: null,
        type: "1x",
        isSport: false,
        ihgResult: null,
        ihgCap: null,
      },
    ]);
    expect(result.waivers).toEqual([
      {
        ccaID: 9101,
        ccaName: "Test Drama",
        meanMin: 12,
        meanMax: null,
        sdMin: null,
        sdMax: null,
        note: "Small CCA",
      },
    ]);
    expect(result.effectiveDefault).toEqual(DEFAULT_RANGE);
    expect(result.flat).toEqual([
      {
        ccaID: 5,
        ccaName: "Test Choir",
        flatPoints: 7.5,
        members: [
          {
            rowKey: "u:1",
            matric: "A9900001Z",
            name: "Test Member 1",
            resolved: true,
          },
          { rowKey: "k:E0000002", matric: null, name: null, resolved: false },
        ],
      },
    ]);
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const entry = mockedAudit.mock.calls[0]?.[1];
    expect(entry).toMatchObject({
      action: "ccaPoints.bundle.export",
      actorUserID: USER,
      reason: "3 CCA(s), 1 flat CCA(s), 2 member(s)",
    });
    expect(JSON.stringify(entry)).not.toContain("A9900001Z");
    expect(JSON.stringify(entry)).not.toContain("Test Member 1");
  });

  it("reports a stored default row as effectiveDefault and a note-only waiver with null ranges", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const db = bundleDb(
      [row("cca:9101", { note: "Just a note" })],
      [{ ccaID: 9101, ccaName: "Test Drama", category: "Performing Arts" }],
      {
        ...row("default", {}),
        scope: "default",
        ccaID: null,
        meanMin: 11,
        meanMax: 15,
        sdMin: 1,
        sdMax: 4,
      },
    );

    const result = await caller(db, ["jcrc"]).bundleExportData();

    expect(result.effectiveDefault).toEqual({
      meanMin: 11,
      meanMax: 15,
      sdMin: 1,
      sdMax: 4,
    });
    expect(result.waivers).toEqual([
      {
        ccaID: 9101,
        ccaName: "Test Drama",
        meanMin: null,
        meanMax: null,
        sdMin: null,
        sdMax: null,
        note: "Just a note",
      },
    ]);
  });

  it("treats a Performing Arts CCA ticked as a sport as a sport", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const db = bundleDb(
      [row("cca:3", { isSport: true, ihgResult: "2nd", ihgCap: 8 })],
      [{ ccaID: 3, ccaName: "Test Fencing", category: "Performing Arts" }],
    );

    const result = await caller(db, ["jcrc"]).bundleExportData();

    expect(result.ccas).toEqual([
      {
        ccaID: 3,
        ccaName: "Test Fencing",
        flatPoints: null,
        type: null,
        isSport: true,
        ihgResult: "2nd",
        ihgCap: 8,
      },
    ]);
  });

  it("treats a Sports Activities CCA ticked off as not a sport, hiding stored IHG values", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const db = bundleDb(
      [row("cca:4", { isSport: false, ihgResult: "1st", ihgCap: 10 })],
      [{ ccaID: 4, ccaName: "Test Chess", category: "Sports Activities" }],
    );

    const result = await caller(db, ["jcrc"]).bundleExportData();

    expect(result.ccas).toEqual([
      {
        ccaID: 4,
        ccaName: "Test Chess",
        flatPoints: null,
        type: null,
        isSport: false,
        ihgResult: null,
        ihgCap: null,
      },
    ]);
  });
});

describe("computeCapabilities: manageCcaPointsRanges", () => {
  it.each([
    [["admin"], true],
    [["jcrc"], true],
    [["scrc"], false],
    [["cca_head"], false],
    [["resident"], false],
    [[], false],
  ])("for roles %j is %s", (roles, expected) => {
    expect(computeCapabilities(roles).manageCcaPointsRanges).toBe(expected);
  });
});

/* ------------------- fixtures for the new JCRC procedures ------------------ */

const SPORTS = "Sports Activities";
type CcaRow = { ccaID: number; ccaName: string; category: string | null };
type ConfigRow = Record<string, unknown>;

/** A full CcaPointsConfig row, every config field blank unless patched. */
const configRow = (scope: string, patch: ConfigRow = {}): ConfigRow => ({
  scope,
  ccaID: scope.startsWith("cca:") ? Number(scope.slice(4)) : null,
  meanMin: null,
  meanMax: null,
  sdMin: null,
  sdMax: null,
  entryOpen: null,
  note: null,
  flatPoints: null,
  ccaType: null,
  ihgResult: null,
  ihgCap: null,
  isSport: null,
  updatedAt: new Date("2027-01-01T00:00:00.000Z"),
  updatedBy: null,
  ...patch,
});

const OPEN = configRow("default", { entryOpen: true });
const CLOSED = configRow("default", { entryOpen: false });

/** The tables the points procedures read and write, backed by fixed rows. */
function pointsDb(
  init: {
    ccas?: CcaRow[];
    rows?: ConfigRow[];
    updateCount?: number;
    deleteCount?: number;
  } = {},
) {
  const ccas = init.ccas ?? [];
  const rows = init.rows ?? [];
  return {
    cCA: {
      findFirst: vi.fn(
        async (a: { where: { ccaID: number } }) =>
          ccas.find((c) => c.ccaID === a.where.ccaID) ?? null,
      ),
      findMany: vi.fn(async (a?: { orderBy?: { ccaName?: string } }) =>
        a?.orderBy?.ccaName === "asc"
          ? [...ccas].sort((x, y) => x.ccaName.localeCompare(y.ccaName))
          : [...ccas],
      ),
    },
    ccaPointsConfig: {
      findUnique: vi.fn(
        async (a: { where: { scope: string } }) =>
          rows.find((r) => r.scope === a.where.scope) ?? null,
      ),
      findMany: vi.fn(async () =>
        rows
          .filter((r) => String(r.scope).startsWith("cca:"))
          .sort((x, y) => Number(x.ccaID) - Number(y.ccaID)),
      ),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: init.deleteCount ?? 0 })),
      updateMany: vi.fn(async () => ({ count: init.updateCount ?? 0 })),
    },
  };
}

const soccer: CcaRow = { ccaID: 7, ccaName: "Soccer", category: SPORTS };
const choir: CcaRow = {
  ccaID: 8,
  ccaName: "Choir",
  category: "Performing Arts",
};
const ihgSet = { ihgResult: "1st", ihgCap: 12 };

beforeEach(() => {
  mockedRoles.mockResolvedValue(["jcrc"]);
});

/** The one audit entry a procedure wrote. */
const auditOf = (): unknown => mockedAudit.mock.calls[0]?.[1];

describe("ccaPoints.setType", () => {
  it("writes the type and audits once with the type only", async () => {
    const db = pointsDb({ ccas: [soccer] });
    const result = await caller(db, ["jcrc"]).setType({
      ccaID: 7,
      type: "0.5x",
    });
    expect(result).toMatchObject({ ccaID: 7, type: "0.5x" });
    expect(db.ccaPointsConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: "cca:7" },
        create: expect.objectContaining({ ccaID: 7, ccaType: "0.5x" }),
        update: expect.objectContaining({ ccaType: "0.5x" }),
      }),
    );
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    expect(auditOf()).toMatchObject({
      action: "ccaPoints.type.set",
      targetCcaID: 7,
      reason: "type 0.5x",
    });
  });

  it("clears a type with null and audits it as blank", async () => {
    const db = pointsDb({ ccas: [soccer] });
    await caller(db, ["jcrc"]).setType({ ccaID: 7, type: null });
    expect(db.ccaPointsConfig.deleteMany).toHaveBeenCalled();
    expect(auditOf()).toMatchObject({ reason: "type blank" });
  });

  it("refuses an unknown CCA without a write or an audit", async () => {
    const db = pointsDb();
    await expect(
      caller(db, ["jcrc"]).setType({ ccaID: 99, type: "1x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("rejects a type outside the two allowed", async () => {
    const db = pointsDb({ ccas: [soccer] });
    await expect(
      caller(db, ["jcrc"]).setType({ ccaID: 7, type: "2x" as never }),
    ).rejects.toThrow();
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
  });
});

describe("ccaPoints.setIhg", () => {
  it("writes the result and cap on a sports CCA and audits result and cap only", async () => {
    const db = pointsDb({ ccas: [soccer] });
    const result = await caller(db, ["jcrc"]).setIhg({
      ccaID: 7,
      result: "1st",
      cap: 12,
    });
    expect(result).toMatchObject({ ccaID: 7, result: "1st", cap: 12 });
    expect(db.ccaPointsConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: "cca:7" },
        update: expect.objectContaining({ ihgResult: "1st", ihgCap: 12 }),
      }),
    );
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    expect(auditOf()).toMatchObject({
      action: "ccaPoints.ihg.set",
      targetCcaID: 7,
      reason: "IHG 1st; cap 12",
    });
  });

  it("refuses a CCA that is not a sport with NOT_A_SPORT", async () => {
    const db = pointsDb({ ccas: [choir] });
    await expect(
      caller(db, ["jcrc"]).setIhg({ ccaID: 8, result: "1st", cap: 12 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "NOT_A_SPORT" });
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("accepts a non-sports category that JCRC ticked as a sport", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [configRow("cca:8", { isSport: true })],
    });
    await caller(db, ["jcrc"]).setIhg({ ccaID: 8, result: "2nd", cap: 4 });
    expect(db.ccaPointsConfig.upsert).toHaveBeenCalledTimes(1);
  });

  it("refuses a sports-category CCA that JCRC unticked", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [configRow("cca:7", { isSport: false })],
    });
    await expect(
      caller(db, ["jcrc"]).setIhg({ ccaID: 7, result: "1st", cap: 12 }),
    ).rejects.toMatchObject({ message: "NOT_A_SPORT" });
  });

  it("refuses an unknown CCA", async () => {
    const db = pointsDb();
    await expect(
      caller(db, ["jcrc"]).setIhg({ ccaID: 99, result: "1st", cap: 12 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it.each([0, 12.5, 100])("rejects the cap %s", async (cap) => {
    const db = pointsDb({ ccas: [soccer] });
    await expect(
      caller(db, ["jcrc"]).setIhg({ ccaID: 7, result: "1st", cap }),
    ).rejects.toThrow();
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
  });

  it("rejects a result outside the four allowed", async () => {
    const db = pointsDb({ ccas: [soccer] });
    await expect(
      caller(db, ["jcrc"]).setIhg({ ccaID: 7, result: "4th" as never, cap: 5 }),
    ).rejects.toThrow();
  });
});

describe("ccaPoints.setSport", () => {
  it.each([
    [true, "sport yes"],
    [false, "sport no"],
  ])("stores isSport %s and audits it as %s", async (isSport, reason) => {
    const db = pointsDb({ ccas: [choir] });
    const result = await caller(db, ["jcrc"]).setSport({ ccaID: 8, isSport });
    expect(result).toMatchObject({ ccaID: 8, isSport });
    expect(db.ccaPointsConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: "cca:8" },
        update: expect.objectContaining({ isSport }),
      }),
    );
    expect(auditOf()).toMatchObject({
      action: "ccaPoints.sport.set",
      targetCcaID: 8,
      reason,
    });
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it("null goes back to the category default and is audited as such", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [configRow("cca:8", { isSport: true })],
    });
    const result = await caller(db, ["jcrc"]).setSport({
      ccaID: 8,
      isSport: null,
    });
    expect(result).toMatchObject({ isSport: null });
    expect(db.ccaPointsConfig.deleteMany).toHaveBeenCalled();
    expect(auditOf()).toMatchObject({ reason: "sport default" });
  });

  it("refuses an unknown CCA", async () => {
    const db = pointsDb();
    await expect(
      caller(db, ["jcrc"]).setSport({ ccaID: 99, isSport: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
    expect(mockedAudit).not.toHaveBeenCalled();
  });
});

describe("ccaPoints.startNewPointsYear", () => {
  it("clears the results, closes entry and audits the count with no matric", async () => {
    const db = pointsDb({ updateCount: 3 });
    const result = await caller(db, ["jcrc"]).startNewPointsYear();
    expect(result).toEqual({ cleared: 3, entryOpen: false });
    expect(db.ccaPointsConfig.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          scope: { startsWith: "cca:" },
          ihgResult: { not: null },
        },
        data: expect.objectContaining({ ihgResult: null }),
      }),
    );
    expect(db.ccaPointsConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: "default" },
        update: expect.objectContaining({ entryOpen: false }),
      }),
    );
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    const entry = auditOf();
    expect(entry).toMatchObject({
      action: "ccaPoints.year.start",
      rolesAfter: ["closed"],
      reason: "3 IHG result(s) cleared; entry closed",
    });
    expect(entry).toEqual({
      actorUserID: USER,
      actorRoles: ["jcrc"],
      action: "ccaPoints.year.start",
      rolesAfter: ["closed"],
      reason: "3 IHG result(s) cleared; entry closed",
    });
    expect(entry).not.toHaveProperty("targetCcaID");
  });

  it("audits one 'failed partway' row and rethrows when the service throws", async () => {
    const db = pointsDb();
    const boom = new Error("db down");
    db.ccaPointsConfig.updateMany.mockRejectedValueOnce(boom);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      caller(db, ["jcrc"]).startNewPointsYear(),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      cause: { cause: boom },
    });
    log.mockRestore();
    expect(mockedAudit).toHaveBeenCalledTimes(1);
    expect(auditOf()).toEqual({
      actorUserID: USER,
      actorRoles: ["jcrc"],
      action: "ccaPoints.year.start",
      rolesAfter: ["closed"],
      reason:
        "failed partway: entry closed first; IHG results may not be cleared",
    });
  });
});

/* ------------------------ D20 = C: the entry-open gate --------------------- */

describe("ccaPoints.setEntryOpen: the IHG gate", () => {
  it("refuses to open while a sport lacks its result or cap, naming it", async () => {
    const netball: CcaRow = { ccaID: 9, ccaName: "Netball", category: SPORTS };
    const db = pointsDb({
      ccas: [soccer, choir, netball],
      rows: [CLOSED, configRow("cca:9", ihgSet)],
    });
    await expect(
      caller(db, ["jcrc"]).setEntryOpen({ open: true }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "IHG_NOT_READY: Soccer",
    });
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("names every sport that is not ready, in name order", async () => {
    const db = pointsDb({
      ccas: [
        { ccaID: 1, ccaName: "Tennis", category: SPORTS },
        { ccaID: 2, ccaName: "Archery", category: SPORTS },
      ],
    });
    await expect(
      caller(db, ["jcrc"]).setEntryOpen({ open: true }),
    ).rejects.toMatchObject({ message: "IHG_NOT_READY: Archery, Tennis" });
  });

  it("opens when every sport has both a result and a cap", async () => {
    const db = pointsDb({
      ccas: [soccer, choir],
      rows: [configRow("cca:7", ihgSet)],
    });
    const result = await caller(db, ["jcrc"]).setEntryOpen({ open: true });
    expect(result.entryOpen).toBe(true);
    expect(db.ccaPointsConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { scope: "default" },
        update: expect.objectContaining({ entryOpen: true }),
      }),
    );
    expect(auditOf()).toMatchObject({
      action: "ccaPoints.entry.set",
      rolesAfter: ["open"],
    });
  });

  it("ignores flat sports, unticked sports and non-sports", async () => {
    const db = pointsDb({
      ccas: [
        { ccaID: 1, ccaName: "Tennis", category: SPORTS },
        { ccaID: 2, ccaName: "Golf", category: SPORTS },
        choir,
      ],
      rows: [
        configRow("cca:1", { flatPoints: 10 }),
        configRow("cca:2", { isSport: false }),
      ],
    });
    await expect(
      caller(db, ["jcrc"]).setEntryOpen({ open: true }),
    ).resolves.toMatchObject({ entryOpen: true });
  });

  it("counts a JCRC-ticked sport outside the sports category", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [configRow("cca:8", { isSport: true })],
    });
    await expect(
      caller(db, ["jcrc"]).setEntryOpen({ open: true }),
    ).rejects.toMatchObject({ message: "IHG_NOT_READY: Choir" });
  });

  it("always lets JCRC close entry, without reading the CCA list", async () => {
    const db = pointsDb({ ccas: [soccer] });
    await expect(
      caller(db, ["jcrc"]).setEntryOpen({ open: false }),
    ).resolves.toMatchObject({ entryOpen: false });
    expect(db.cCA.findMany).not.toHaveBeenCalled();
  });
});

describe("ENTRY_OPEN_IHG: writes refused while entry is open", () => {
  const refused = { code: "PRECONDITION_FAILED", message: "ENTRY_OPEN_IHG" };

  it.each([
    ["a null result", { result: null, cap: 12 }],
    ["a null cap", { result: "1st" as const, cap: null }],
    ["both null", { result: null, cap: null }],
  ])("setIhg with %s is refused", async (_name, input) => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", ihgSet)],
    });
    await expect(
      caller(db, ["jcrc"]).setIhg({ ccaID: 7, ...input }),
    ).rejects.toMatchObject(refused);
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
    expect(db.ccaPointsConfig.deleteMany).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("setIhg may blank a field while entry is closed", async () => {
    const db = pointsDb({ ccas: [soccer], rows: [CLOSED] });
    await caller(db, ["jcrc"]).setIhg({ ccaID: 7, result: null, cap: null });
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it("setIhg may blank a field of a FLAT sport while entry is open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { ...ihgSet, flatPoints: 10 })],
    });
    await caller(db, ["jcrc"]).setIhg({ ccaID: 7, result: null, cap: null });
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it("setIhg may still lower a cap while entry is open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", ihgSet)],
    });
    await caller(db, ["jcrc"]).setIhg({ ccaID: 7, result: "1st", cap: 3 });
    expect(auditOf()).toMatchObject({ reason: "IHG 1st; cap 3" });
  });

  it("setSport(true) on a CCA without both is refused while open", async () => {
    const db = pointsDb({ ccas: [choir], rows: [OPEN] });
    await expect(
      caller(db, ["jcrc"]).setSport({ ccaID: 8, isSport: true }),
    ).rejects.toMatchObject(refused);
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("setSport(true) on a CCA that has both is allowed while open", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [OPEN, configRow("cca:8", ihgSet)],
    });
    await caller(db, ["jcrc"]).setSport({ ccaID: 8, isSport: true });
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it("setSport(false) is allowed while open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", ihgSet)],
    });
    await caller(db, ["jcrc"]).setSport({ ccaID: 7, isSport: false });
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it("setSport(null) is refused while open when it would turn the category default back on", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { isSport: false })],
    });
    await expect(
      caller(db, ["jcrc"]).setSport({ ccaID: 7, isSport: null }),
    ).rejects.toMatchObject(refused);
  });

  it("setSport(true) is allowed while closed", async () => {
    const db = pointsDb({ ccas: [choir], rows: [CLOSED] });
    await caller(db, ["jcrc"]).setSport({ ccaID: 8, isSport: true });
    expect(mockedAudit).toHaveBeenCalledTimes(1);
  });

  it("clearFlat on a flat sport without both is refused while open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { flatPoints: 10 })],
    });
    await expect(
      caller(db, ["jcrc"]).clearFlat({ ccaID: 7 }),
    ).rejects.toMatchObject(refused);
    expect(db.ccaPointsConfig.deleteMany).not.toHaveBeenCalled();
    expect(db.ccaPointsConfig.updateMany).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("clearFlat on a flat sport that has both is allowed while open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { flatPoints: 10, ...ihgSet })],
      updateCount: 1,
    });
    await expect(caller(db, ["jcrc"]).clearFlat({ ccaID: 7 })).resolves.toEqual(
      { cleared: true },
    );
    expect(auditOf()).toMatchObject({ action: "ccaPoints.flat.clear" });
  });

  it("clearFlat on a flat non-sport is allowed while open", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [OPEN, configRow("cca:8", { flatPoints: 10 })],
      deleteCount: 1,
    });
    await expect(caller(db, ["jcrc"]).clearFlat({ ccaID: 8 })).resolves.toEqual(
      { cleared: true },
    );
  });

  it("clearFlat on a flat non-sports CCA ticked as a sport, with no IHG, is refused while open", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [OPEN, configRow("cca:8", { flatPoints: 10, isSport: true })],
    });
    await expect(
      caller(db, ["jcrc"]).clearFlat({ ccaID: 8 }),
    ).rejects.toMatchObject(refused);
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("clearFlat on a flat Sports Activities CCA unticked as a sport is allowed while open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { flatPoints: 10, isSport: false })],
      deleteCount: 1,
      updateCount: 1,
    });
    await expect(caller(db, ["jcrc"]).clearFlat({ ccaID: 7 })).resolves.toEqual(
      { cleared: true },
    );
  });

  it("clearFlat on a flat sport with a result but no cap is refused while open", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { flatPoints: 10, ihgResult: "1st" })],
    });
    await expect(
      caller(db, ["jcrc"]).clearFlat({ ccaID: 7 }),
    ).rejects.toMatchObject(refused);
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("setSport(true) and setSport(null) on a flat row are allowed while open", async () => {
    const dbTrue = pointsDb({
      ccas: [choir],
      rows: [OPEN, configRow("cca:8", { flatPoints: 10 })],
    });
    await caller(dbTrue, ["jcrc"]).setSport({ ccaID: 8, isSport: true });
    const dbNull = pointsDb({
      ccas: [soccer],
      rows: [OPEN, configRow("cca:7", { flatPoints: 10, isSport: false })],
    });
    await caller(dbNull, ["jcrc"]).setSport({ ccaID: 7, isSport: null });
    expect(mockedAudit).toHaveBeenCalledTimes(2);
  });

  it("setSport(true) on a row with a result but no cap is refused while open", async () => {
    const db = pointsDb({
      ccas: [choir],
      rows: [OPEN, configRow("cca:8", { ihgResult: "1st" })],
    });
    await expect(
      caller(db, ["jcrc"]).setSport({ ccaID: 8, isSport: true }),
    ).rejects.toMatchObject(refused);
    expect(db.ccaPointsConfig.upsert).not.toHaveBeenCalled();
  });

  it("clearFlat on a flat sport without both is allowed while closed", async () => {
    const db = pointsDb({
      ccas: [soccer],
      rows: [CLOSED, configRow("cca:7", { flatPoints: 10 })],
      deleteCount: 1,
    });
    await expect(caller(db, ["jcrc"]).clearFlat({ ccaID: 7 })).resolves.toEqual(
      { cleared: true },
    );
  });
});

/* ------------------------------ getConfig.ccas ----------------------------- */

describe("ccaPoints.getConfig", () => {
  it("lists every CCA in name order with its type, sport, IHG, flat and waiver state", async () => {
    vi.mocked(resolveRoster).mockResolvedValue({
      heads: [{}],
      members: [{}, {}],
    } as never);
    const db = pointsDb({
      ccas: [
        { ccaID: 3, ccaName: "Zumba", category: "Performing Arts" },
        { ccaID: 1, ccaName: "Archery", category: SPORTS },
        choir,
        { ccaID: 4, ccaName: "Debate", category: "Interest Groups" },
      ],
      rows: [
        CLOSED,
        configRow("cca:1", { ccaType: "0.5x", ihgResult: "1st", ihgCap: 12 }),
        configRow("cca:8", { flatPoints: 10 }),
        configRow("cca:3", { note: "w", meanMin: 8, isSport: true }),
        configRow("cca:4", { ccaType: "2x", ihgResult: "4th", ihgCap: 0 }),
      ],
    });

    const result = await caller(db, ["jcrc"]).getConfig();

    expect(result.ccas).toEqual([
      {
        ccaID: 1,
        ccaName: "Archery",
        isSport: true,
        sportSource: "category",
        type: "0.5x",
        ihgResult: "1st",
        ihgCap: 12,
        isFlat: false,
        hasWaiver: false,
      },
      {
        ccaID: 8,
        ccaName: "Choir",
        isSport: false,
        sportSource: "category",
        type: null,
        ihgResult: null,
        ihgCap: null,
        isFlat: true,
        hasWaiver: false,
      },
      {
        ccaID: 4,
        ccaName: "Debate",
        isSport: false,
        sportSource: "category",
        type: null,
        ihgResult: null,
        ihgCap: null,
        isFlat: false,
        hasWaiver: false,
      },
      {
        ccaID: 3,
        ccaName: "Zumba",
        isSport: true,
        sportSource: "jcrc",
        type: null,
        ihgResult: null,
        ihgCap: null,
        isFlat: false,
        hasWaiver: true,
      },
    ]);
  });

  it("keeps the shapes of overrides and flatCcas", async () => {
    vi.mocked(resolveRoster).mockResolvedValue({
      heads: [{}],
      members: [{}, {}],
    } as never);
    const db = pointsDb({
      ccas: [{ ccaID: 3, ccaName: "Zumba", category: null }, choir],
      rows: [
        configRow("cca:3", { note: "w", meanMin: 8 }),
        configRow("cca:8", { flatPoints: 10 }),
      ],
    });

    const result = await caller(db, ["jcrc"]).getConfig();

    expect(result.overrides).toEqual([
      expect.objectContaining({
        ccaID: 3,
        ccaName: "Zumba",
        meanMin: 8,
        meanMax: null,
        note: "w",
      }),
    ]);
    expect(result.flatCcas).toEqual([
      expect.objectContaining({
        ccaID: 8,
        ccaName: "Choir",
        flatPoints: 10,
        memberCount: 3,
        hasWaiver: false,
      }),
    ]);
    expect(result.entryOpen).toBe(false);
  });
});

/* ------------------------ getEntryContext.ihg ------------------------------ */

describe("ccaPoints.getEntryContext: ihg", () => {
  function headOf(ccas: CcaRow[], rows: ConfigRow[]) {
    return {
      ...pointsDb({ ccas, rows }),
      ccaHead: { findUnique: vi.fn(async () => ({ id: "row" })) },
    };
  }

  it("tells a sports CCA's head the result and cap", async () => {
    const db = headOf([soccer], [OPEN, configRow("cca:7", ihgSet)]);
    const result = await caller(db, ["cca_head"]).getEntryContext({ ccaID: 7 });
    expect(result.ihg).toEqual({ result: "1st", cap: 12 });
  });

  it("gives nulls inside ihg while JCRC has set nothing yet", async () => {
    const db = headOf([soccer], [OPEN]);
    const result = await caller(db, ["cca_head"]).getEntryContext({ ccaID: 7 });
    expect(result.ihg).toEqual({ result: null, cap: null });
  });

  it("gives null for a CCA that is not a sport", async () => {
    const db = headOf([choir], [OPEN, configRow("cca:8", ihgSet)]);
    const result = await caller(db, ["cca_head"]).getEntryContext({ ccaID: 8 });
    expect(result.ihg).toBeNull();
  });

  it("gives null for a flat sport", async () => {
    const db = headOf(
      [soccer],
      [OPEN, configRow("cca:7", { ...ihgSet, flatPoints: 10 })],
    );
    const result = await caller(db, ["cca_head"]).getEntryContext({ ccaID: 7 });
    expect(result.ihg).toBeNull();
    expect(result.flatPoints).toBe(10);
    expect(result.flatCcaName).toBe("Soccer");
  });

  it("honours JCRC's sport tick over the category, both ways", async () => {
    const ticked = headOf([choir], [configRow("cca:8", { isSport: true })]);
    expect(
      (await caller(ticked, ["cca_head"]).getEntryContext({ ccaID: 8 })).ihg,
    ).toEqual({ result: null, cap: null });
    const unticked = headOf([soccer], [configRow("cca:7", { isSport: false })]);
    expect(
      (await caller(unticked, ["cca_head"]).getEntryContext({ ccaID: 7 })).ihg,
    ).toBeNull();
  });

  it("reads an invalid stored result or cap as null", async () => {
    const db = headOf(
      [soccer],
      [configRow("cca:7", { ihgResult: "4th", ihgCap: 0 })],
    );
    const result = await caller(db, ["cca_head"]).getEntryContext({ ccaID: 7 });
    expect(result.ihg).toEqual({ result: null, cap: null });
  });
});

/* ------------------------------- error copy -------------------------------- */

describe("pointsErrorCopy for the IHG refusals", () => {
  it("says only a sports CCA has an IHG result", () => {
    expect(pointsErrorCopy("NOT_A_SPORT", "BAD_REQUEST")).toBe(
      "Only a sports CCA has an IHG result.",
    );
  });

  it("lists the sports that are not ready", () => {
    expect(
      pointsErrorCopy("IHG_NOT_READY: Archery, Tennis", "PRECONDITION_FAILED"),
    ).toBe(
      "Set the IHG result and cap for: Archery, Tennis. Then open points entry.",
    );
  });

  it("explains why a blanking write is refused while entry is open", () => {
    const copy = pointsErrorCopy("ENTRY_OPEN_IHG", "PRECONDITION_FAILED");
    expect(copy).toMatch(/^Close points entry/);
    expect(copy).not.toContain("ENTRY_OPEN_IHG");
  });
});

describe("invalid stored config values", () => {
  afterEach(() => vi.restoreAllMocks());

  const logged = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(
      (c) => JSON.parse(String(c[0])) as Record<string, unknown>,
    );
  const invalid = (ccaID: number, field: string, value: unknown) => ({
    evt: "points_config_invalid_value",
    ccaID,
    field,
    value,
  });

  it("getConfig reads them as null and logs each one", async () => {
    vi.mocked(resolveRoster).mockResolvedValue({
      heads: [],
      members: [],
    } as never);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = pointsDb({
      ccas: [{ ccaID: 4, ccaName: "Debate", category: "Interest Groups" }],
      rows: [
        CLOSED,
        configRow("cca:4", { ccaType: "2x", ihgResult: "4th", ihgCap: 0 }),
      ],
    });

    const result = await caller(db, ["jcrc"]).getConfig();

    expect(result.ccas[0]).toMatchObject({
      type: null,
      ihgResult: null,
      ihgCap: null,
    });
    expect(logged(spy)).toEqual([
      invalid(4, "ccaType", "2x"),
      invalid(4, "ihgResult", "4th"),
      invalid(4, "ihgCap", 0),
    ]);
  });

  it("getEntryContext reads an invalid result or cap as null and logs it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = {
      ...pointsDb({
        ccas: [soccer],
        rows: [OPEN, configRow("cca:7", { ihgResult: "9th", ihgCap: 500 })],
      }),
      ccaHead: { findUnique: vi.fn(async () => ({ id: "row" })) },
    };
    const result = await caller(db, ["cca_head"]).getEntryContext({ ccaID: 7 });
    expect(result.ihg).toEqual({ result: null, cap: null });
    expect(logged(spy)).toEqual([
      invalid(7, "ihgResult", "9th"),
      invalid(7, "ihgCap", 500),
    ]);
  });

  it("bundleExportData reads an invalid type as null and logs it", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = pointsDb({
      ccas: [choir],
      rows: [OPEN, configRow("cca:8", { ccaType: "3x" })],
    });
    const result = await caller(db, ["jcrc"]).bundleExportData();
    expect(result.ccas[0]?.type).toBeNull();
    expect(logged(spy)).toEqual([invalid(8, "ccaType", "3x")]);
  });
});
