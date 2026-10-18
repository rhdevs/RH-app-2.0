import { beforeEach, describe, expect, it, vi } from "vitest";

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
      ["flatExportData", (c) => c.flatExportData()],
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

describe("ccaPoints.flatExportData", () => {
  it("audits once, with counts only, and returns only the four member fields", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const db = {
      ccaPointsConfig: {
        findMany: vi.fn(async () => [
          {
            scope: "cca:5",
            ccaID: 5,
            flatPoints: 7.5,
            meanMin: null,
            meanMax: null,
            sdMin: null,
            sdMax: null,
            note: null,
            updatedAt: new Date(),
            updatedBy: null,
          },
        ]),
      },
      cCA: {
        findMany: vi.fn(async () => [{ ccaID: 5, ccaName: "Test Choir" }]),
      },
    };
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

    const result = await caller(db, ["jcrc"]).flatExportData();

    expect(result).toEqual([
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
      action: "ccaPoints.flat.export",
      actorUserID: USER,
      reason: "1 CCA(s), 2 member(s)",
    });
    expect(JSON.stringify(entry)).not.toContain("A9900001Z");
    expect(JSON.stringify(entry)).not.toContain("Test Member 1");
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
