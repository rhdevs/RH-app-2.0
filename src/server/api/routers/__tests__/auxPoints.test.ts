import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The router module pulls in NextAuth and Prisma through trpc.ts; neither is
// needed to exercise access checks, so both are replaced.
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/routers/admin", () => ({
  writeAudit: vi.fn(),
  bulkResolver: vi.fn(),
}));
vi.mock("~/server/api/services/access", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "~/server/api/services/access",
  )),
  getUserRoles: vi.fn(),
}));
vi.mock("~/server/api/services/auxPoints/writes", () => ({
  addEventAttendees: vi.fn(),
  addRecordAttendees: vi.fn(),
  createAward: vi.fn(),
  createRecord: vi.fn(),
  deleteAward: vi.fn(),
  deleteRecord: vi.fn(),
  importAwards: vi.fn(),
  removeEventAttendee: vi.fn(),
  removeRecordAttendee: vi.fn(),
  setEventAux: vi.fn(async () => ({ eventID: 7, aux: true })),
  updateAward: vi.fn(),
  updateRecord: vi.fn(),
}));
vi.mock("~/server/api/services/auxPoints/totals", () => ({
  auxDetail: vi.fn(),
  auxEventsOf: vi.fn(async () => []),
  auxTotals: vi.fn(async () => []),
  auxYears: vi.fn(async () => ["AY2026/27"]),
}));
vi.mock("~/server/api/services/auxPoints/year", () => ({
  readAuxYear: vi.fn(async () => "AY2026/27"),
  readAuxYearStartedAt: vi.fn(async () => null),
  sgtIsoDate: vi.fn(() => "2026-10-01"),
}));

import { auxRouter } from "~/server/api/routers/auxPoints";
import { getUserRoles } from "~/server/api/services/access";
import { setEventAux } from "~/server/api/services/auxPoints/writes";
import { createCallerFactory } from "~/server/api/trpc";

const createCaller = createCallerFactory(auxRouter);

const USER = "E1234567";
const ID = "0123456789abcdef01234567";
const mockedRoles = vi.mocked(getUserRoles);
const mockedFlag = vi.mocked(setEventAux);

type Caller = ReturnType<typeof createCaller>;

function caller(db: unknown, sessionRoles: string[]): Caller {
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

beforeEach(() => {
  mockedRoles.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const award = {
  amount: 1,
  reason: "Fire warden (Sem 1)",
  awardedOn: "2026-10-01",
};

const calls: [string, (c: Caller) => Promise<unknown>][] = [
  ["overview", (c) => c.overview({})],
  ["detail", (c) => c.detail({ year: "AY2026/27", userID: "E1" })],
  ["sources", (c) => c.sources({ year: "AY2026/27" })],
  ["flaggable", (c) => c.flaggable({ query: "" })],
  ["setEventAux", (c) => c.setEventAux({ eventID: 7, aux: true })],
  ["eventAttendees", (c) => c.eventAttendees({ eventID: 7 })],
  ["addEventAttendees", (c) => c.addEventAttendees({ eventID: 7, text: "E1" })],
  [
    "removeEventAttendee",
    (c) => c.removeEventAttendee({ eventID: 7, userID: "E1" }),
  ],
  [
    "createRecord",
    (c) =>
      c.createRecord({ title: "Clean-up", heldOn: "2026-10-01", text: "" }),
  ],
  [
    "updateRecord",
    (c) => c.updateRecord({ id: ID, title: "Clean-up", heldOn: "2026-10-01" }),
  ],
  ["deleteRecord", (c) => c.deleteRecord({ id: ID })],
  ["recordAttendees", (c) => c.recordAttendees({ id: ID })],
  ["addRecordAttendees", (c) => c.addRecordAttendees({ id: ID, text: "E1" })],
  [
    "removeRecordAttendee",
    (c) => c.removeRecordAttendee({ id: ID, userID: "E1" }),
  ],
  ["createAward", (c) => c.createAward({ userID: "E1", ...award })],
  [
    "importAwards",
    (c) =>
      c.importAwards({
        text: "E1,2",
        reason: award.reason,
        awardedOn: award.awardedOn,
      }),
  ],
  ["updateAward", (c) => c.updateAward({ id: ID, ...award })],
  ["deleteAward", (c) => c.deleteAward({ id: ID })],
];

describe("aux router access", () => {
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
    },
  );

  it.each(calls)("%s is FORBIDDEN to a CCA head", async (_name, call) => {
    mockedRoles.mockResolvedValue(["cca_head"]);
    await expect(call(caller(untouchedDb, ["cca_head"]))).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });

  it.each(calls)(
    "%s is FORBIDDEN when the live roles are only scrc",
    async (_name, call) => {
      mockedRoles.mockResolvedValue(["scrc"]);
      await expect(call(caller(untouchedDb, ["jcrc"]))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    },
  );

  it("never reaches a write when refused", async () => {
    mockedRoles.mockResolvedValue(["cca_head"]);
    await expect(
      caller(untouchedDb, ["jcrc"]).setEventAux({ eventID: 7, aux: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mockedFlag).not.toHaveBeenCalled();
  });

  it("lets a live JCRC member flag an event, passing who did it", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const db = {};
    await expect(
      caller(db, ["jcrc"]).setEventAux({ eventID: 7, aux: true }),
    ).resolves.toEqual({ eventID: 7, aux: true });
    expect(mockedFlag).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ userID: USER, roles: ["jcrc"] }),
      7,
      true,
    );
  });

  it("rejects an award amount that is not a whole number", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    await expect(
      caller(untouchedDb, ["jcrc"]).createAward({
        userID: "E1",
        ...award,
        amount: 1.5,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lists attendance only for an AUX event", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    const findMany = vi.fn(async () => []);
    const db = {
      event: { findUnique: vi.fn(async () => ({ auxYear: null })) },
      eventAttendance: { findMany },
    };
    await expect(
      caller(db, ["jcrc"]).eventAttendees({ eventID: 7 }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "NOT_AN_AUX_EVENT",
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed year", async () => {
    mockedRoles.mockResolvedValue(["jcrc"]);
    await expect(
      caller(untouchedDb, ["jcrc"]).sources({ year: "2026" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
