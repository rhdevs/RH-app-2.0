import { beforeEach, describe, expect, it, vi } from "vitest";

// Same mocking style as ccaPoints.test.ts: no NextAuth, no real Prisma.
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/routers/admin", () => ({ writeAudit: vi.fn() }));
vi.mock("~/server/api/services/access", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "~/server/api/services/access",
  )),
  getUserRoles: vi.fn(),
}));
vi.mock("~/server/api/services/ccaScope", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "~/server/api/services/ccaScope",
  )),
  assertCcaManagementEnabled: vi.fn(),
}));

import { ccaAdminRouter } from "~/server/api/routers/ccaAdmin";
import { writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import { createCallerFactory } from "~/server/api/trpc";

const createCaller = createCallerFactory(ccaAdminRouter);
const mockedRoles = vi.mocked(getUserRoles);
const mockedAudit = vi.mocked(writeAudit);

const SPORTS = "Sports Activities";
type ConfigRow = Record<string, unknown>;

const configRow = (scope: string, patch: ConfigRow = {}): ConfigRow => ({
  scope,
  ccaID: scope.startsWith("cca:") ? Number(scope.slice(4)) : null,
  entryOpen: null,
  flatPoints: null,
  ihgResult: null,
  ihgCap: null,
  isSport: null,
  ...patch,
});
const OPEN = configRow("default", { entryOpen: true });
const CLOSED = configRow("default", { entryOpen: false });
const ihgSet = { ihgResult: "1st", ihgCap: 12 };

const TARGET_ID = 7;

/** The CCA tables create and rename touch, plus the points config they now read. */
function adminDb(
  rows: ConfigRow[],
  before = { ccaName: "Soccer", category: SPORTS },
) {
  return {
    cCA: {
      findFirst: vi.fn(async (a: { orderBy?: unknown }) =>
        a.orderBy ? { ccaID: 40 } : null,
      ),
      create: vi.fn(
        async (a: { data: { ccaID: number; ccaName: string } }) => ({
          ccaID: a.data.ccaID,
          ccaName: a.data.ccaName,
        }),
      ),
      findUnique: vi.fn(async () => before),
      update: vi.fn(
        async (a: { data: { ccaName: string; category: string } }) => ({
          ccaID: TARGET_ID,
          ...a.data,
        }),
      ),
    },
    ccaPointsConfig: {
      findUnique: vi.fn(
        async (a: { where: { scope: string } }) =>
          rows.find((r) => r.scope === a.where.scope) ?? null,
      ),
    },
  };
}

function caller(db: unknown) {
  return createCaller({
    db,
    headers: new Headers(),
    session: {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        userID: "E1234567",
        roles: ["admin"],
        eligible: true,
        credentialsStale: false,
      },
    },
  } as never);
}

type Db = ReturnType<typeof adminDb>;
type Op = {
  name: string;
  /** Rows for the CCA being changed (create has none until it exists). */
  run: (db: Db, category: string) => Promise<unknown>;
  wrote: (db: Db) => unknown;
  /** The points-config row id the helper reads, if any. */
  rowScope: string | null;
};

const create: Op = {
  name: "create",
  run: (db, category) => caller(db).create({ ccaName: "Brand New", category }),
  wrote: (db) => db.cCA.create,
  rowScope: null,
};
const rename: Op = {
  name: "rename",
  run: (db, category) =>
    caller(db).rename({ ccaID: TARGET_ID, ccaName: "Renamed", category }),
  wrote: (db) => db.cCA.update,
  rowScope: `cca:${TARGET_ID}`,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedRoles.mockResolvedValue(["admin"]);
});

const refused = { code: "PRECONDITION_FAILED", message: "ENTRY_OPEN_IHG" };

describe.each([create, rename])(
  "ccaAdmin.$name and the entry-open gate",
  (op) => {
    it("refuses a Sports Activities CCA with no IHG while entry is open", async () => {
      const db = adminDb([OPEN], {
        ccaName: "Chess",
        category: "Interest Groups",
      });
      await expect(op.run(db, SPORTS)).rejects.toMatchObject(refused);
      expect(op.wrote(db)).not.toHaveBeenCalled();
      expect(mockedAudit).not.toHaveBeenCalled();
    });

    it("refuses when the row has a result but no cap", async () => {
      const rows =
        op.rowScope === null
          ? [OPEN]
          : [OPEN, configRow(op.rowScope, { ihgResult: "1st" })];
      const db = adminDb(rows, {
        ccaName: "Chess",
        category: "Interest Groups",
      });
      await expect(op.run(db, SPORTS)).rejects.toMatchObject(refused);
      expect(op.wrote(db)).not.toHaveBeenCalled();
    });

    it("allows any change while entry is closed", async () => {
      const db = adminDb([CLOSED]);
      await expect(op.run(db, SPORTS)).resolves.toBeDefined();
      expect(op.wrote(db)).toHaveBeenCalledTimes(1);
    });

    it("allows any change when there is no default row at all (closed by default)", async () => {
      const db = adminDb([]);
      await expect(op.run(db, SPORTS)).resolves.toBeDefined();
    });

    it("allows a non-sports category while entry is open", async () => {
      const db = adminDb([OPEN]);
      await expect(op.run(db, "Performing Arts")).resolves.toBeDefined();
      expect(op.wrote(db)).toHaveBeenCalledTimes(1);
    });
  },
);

describe("ccaAdmin.rename: rows that keep the CCA out of the gate", () => {
  const scope = `cca:${TARGET_ID}`;
  const before = { ccaName: "Chess", category: "Interest Groups" };

  it("allows a CCA the JCRC ticked as not a sport", async () => {
    const db = adminDb([OPEN, configRow(scope, { isSport: false })], before);
    await expect(rename.run(db, SPORTS)).resolves.toBeDefined();
  });

  it("allows a flat sport", async () => {
    const db = adminDb([OPEN, configRow(scope, { flatPoints: 10 })], before);
    await expect(rename.run(db, SPORTS)).resolves.toBeDefined();
  });

  it("allows a sport that already has its result and cap", async () => {
    const db = adminDb([OPEN, configRow(scope, ihgSet)], before);
    await expect(rename.run(db, SPORTS)).resolves.toBeDefined();
  });

  it("allows renaming an already-complete sport", async () => {
    const db = adminDb([OPEN, configRow(scope, ihgSet)]);
    await expect(rename.run(db, SPORTS)).resolves.toBeDefined();
  });

  it("refuses a JCRC-ticked sport in a non-sports category only when incomplete", async () => {
    const incomplete = adminDb([OPEN, configRow(scope, { isSport: true })]);
    await expect(
      rename.run(incomplete, "Performing Arts"),
    ).rejects.toMatchObject(refused);
    const complete = adminDb([
      OPEN,
      configRow(scope, { isSport: true, ...ihgSet }),
    ]);
    await expect(
      rename.run(complete, "Performing Arts"),
    ).resolves.toBeDefined();
  });

  it("uses the NEW category: moving a complete-less sport out of Sports is allowed", async () => {
    const db = adminDb([OPEN]);
    await expect(rename.run(db, "Interest Groups")).resolves.toBeDefined();
  });
});
