import { beforeEach, describe, expect, it, vi } from "vitest";

// The router module pulls in NextAuth and Prisma through trpc.ts; neither is
// needed to exercise the checks, so both are replaced.
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));

import { proposalRouter } from "~/server/api/routers/proposal";
import { resetProposalsFlagCache } from "~/server/api/services/proposals/flag";
import { createCallerFactory } from "~/server/api/trpc";

const createCaller = createCallerFactory(proposalRouter);

// The flag read is cached per lambda: every test starts with it empty.
beforeEach(() => {
  resetProposalsFlagCache();
});

const ME = "E1000001";
const ID = "0123456789abcdef01234567";

type FlagState = "on" | "off" | "absent" | "throws";

/** A db that records every call, so "nothing was touched" can be asserted. */
function fakeDb(flag: FlagState) {
  const calls: string[] = [];
  const touch = (name: string) =>
    vi.fn((args?: unknown) => {
      calls.push(name);
      void args;
      return Promise.resolve(null);
    });
  const table = (name: string) => ({
    findUnique: touch(`${name}.findUnique`),
    findFirst: touch(`${name}.findFirst`),
    findMany: touch(`${name}.findMany`),
    create: touch(`${name}.create`),
    update: touch(`${name}.update`),
    updateMany: touch(`${name}.updateMany`),
    createMany: touch(`${name}.createMany`),
  });
  const db = {
    systemFlag: {
      findUnique: vi.fn(({ where }: { where: { key: string } }) => {
        calls.push(`systemFlag.${where.key}`);
        if (where.key !== "proposals.enabled") return Promise.resolve(null);
        if (flag === "throws") return Promise.reject(new Error("db down"));
        if (flag === "absent") return Promise.resolve(null);
        return Promise.resolve({ key: where.key, value: flag });
      }),
    },
    proposal: table("proposal"),
    proposalStatusHistory: table("history"),
    ccaHead: table("ccaHead"),
    userRole: table("userRole"),
    notification: table("notification"),
    roleAuditLog: table("audit"),
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
      calls.push("$transaction");
      return fn(db);
    }),
  };
  return { db, calls };
}

function caller(
  db: unknown,
  opts: { userID?: string | null; signedIn?: boolean } = {},
) {
  const { userID = ME, signedIn = true } = opts;
  return createCaller({
    db,
    headers: new Headers(),
    session: signedIn
      ? {
          user: { userID, roles: ["admin", "jcrc"], eligible: true },
          expires: new Date(Date.now() + 3_600_000).toISOString(),
        }
      : null,
  } as never);
}

const NEW = { ccaID: 7, category: "pubs" as const, title: "Pub night" };

/** Every gated procedure with a valid input. */
const CALLS: Array<
  [string, (c: ReturnType<typeof caller>) => Promise<unknown>]
> = [
  ["create", (c) => c.create(NEW)],
  ["update", (c) => c.update({ id: ID, version: 0, title: "x" })],
  ["get", (c) => c.get({ id: ID })],
  ["list", (c) => c.list({ ccaID: 7 })],
  ["submit", (c) => c.submit({ id: ID, version: 0 })],
  ["approve", (c) => c.approve({ id: ID, version: 1 })],
  ["return", (c) => c.return({ id: ID, version: 1, reason: "Fix the date" })],
  ["finish", (c) => c.finish({ id: ID, version: 2 })],
  ["directorHome", (c) => c.directorHome()],
  ["directorQueue", (c) => c.directorQueue({})],
];

describe("proposals.enabled gates every procedure but `enabled`", () => {
  for (const state of ["off", "absent", "throws"] as const) {
    describe(`flag ${state}`, () => {
      it.each(CALLS)("%s is refused and touches nothing", async (_n, run) => {
        const { db, calls } = fakeDb(state);

        await expect(run(caller(db))).rejects.toMatchObject({
          code: "FORBIDDEN",
          message: "PROPOSALS_DISABLED",
        });

        // Only the flag read happened: no proposal, role or head table.
        expect(calls).toEqual(["systemFlag.proposals.enabled"]);
      });

      it("`enabled` answers false instead of throwing", async () => {
        const { db } = fakeDb(state);
        await expect(caller(db).enabled()).resolves.toEqual({
          enabled: false,
        });
      });
    });
  }

  it("a value other than exactly on is off", async () => {
    const { db } = fakeDb("on");
    db.systemFlag.findUnique.mockResolvedValueOnce({
      key: "proposals.enabled",
      value: "ON ",
    } as never);
    await expect(caller(db).list({ ccaID: 7 })).rejects.toMatchObject({
      message: "PROPOSALS_DISABLED",
    });
  });

  it("`enabled` is true only for on", async () => {
    const { db } = fakeDb("on");
    await expect(caller(db).enabled()).resolves.toEqual({ enabled: true });
  });

  it("needs a signed-in user", async () => {
    const { db } = fakeDb("on");
    await expect(
      caller(db, { signedIn: false }).list({ ccaID: 7 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a session with no canonical identity", async () => {
    const { db } = fakeDb("on");
    await expect(
      caller(db, { userID: null }).list({ ccaID: 7 }),
    ).rejects.toMatchObject({ message: "NO_CANONICAL_IDENTITY" });
  });
});

describe("input a browser could send", () => {
  it("cannot set a status: an unknown key is dropped before the service sees it", async () => {
    const { db } = fakeDb("on");
    // Not a head, so the call is refused, but only after the input parsed.
    await expect(
      caller(db).create({ ...NEW, status: "cleared" } as never),
    ).rejects.toMatchObject({ message: "NOT_CCA_HEAD" });
    expect(db.proposal.create).not.toHaveBeenCalled();
  });

  it("rejects an id that is not an ObjectId and a bad cca id", async () => {
    const { db } = fakeDb("on");
    await expect(caller(db).get({ id: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller(db).list({ ccaID: -1 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("an admin who heads no CCA is refused on create and list", async () => {
    const { db } = fakeDb("on");
    await expect(caller(db).create(NEW)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_CCA_HEAD",
    });
    await expect(caller(db).list({ ccaID: 7 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(db.proposal.create).not.toHaveBeenCalled();
  });

  it("a failed head read refuses and never reads it as a yes", async () => {
    const { db } = fakeDb("on");
    db.ccaHead.findFirst.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(caller(db).create(NEW)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "PROPOSAL_ACCESS_CHECK_FAILED",
    });

    expect(db.proposal.create).not.toHaveBeenCalled();
    // The log names the error, never its message.
    expect(String(spy.mock.calls[0]?.[0])).toContain('"error":"Error"');
    expect(String(spy.mock.calls[0]?.[0])).not.toContain("db down");
    spy.mockRestore();
  });
});

describe("error hygiene: no raw database message reaches the caller", () => {
  const RAW =
    "Invalid `prisma.proposal.findUnique()` invocation: field secretCol";

  it.each([
    ["get", (c: ReturnType<typeof caller>) => c.get({ id: ID })],
    [
      "update",
      (c: ReturnType<typeof caller>) =>
        c.update({ id: ID, version: 0, title: "x" }),
    ],
    [
      "submit",
      (c: ReturnType<typeof caller>) => c.submit({ id: ID, version: 0 }),
    ],
  ])("%s turns an unexpected failure into a fixed message", async (_n, run) => {
    const { db } = fakeDb("on");
    db.proposal.findUnique.mockRejectedValueOnce(new Error(RAW));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const error = await run(caller(db)).then(
      () => null,
      (e: unknown) => e as { code: string; message: string },
    );

    expect(error?.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error?.message).toBe("Something went wrong.");
    expect(error?.message).not.toContain("secretCol");
    // The operator still gets the detail.
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "secretCol",
    );
    spy.mockRestore();
  });

  it("deliberate refusals still pass through with their own message", async () => {
    const { db } = fakeDb("on");
    await expect(caller(db).create(NEW)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NOT_CCA_HEAD",
    });
  });
});

describe("the director's procedures", () => {
  it("approve, return and finish refuse a missing proposal before any guard or write", async () => {
    const { db, calls } = fakeDb("on");
    for (const run of [
      (c: ReturnType<typeof caller>) => c.approve({ id: ID, version: 1 }),
      (c: ReturnType<typeof caller>) =>
        c.return({ id: ID, version: 1, reason: "no" }),
      (c: ReturnType<typeof caller>) => c.finish({ id: ID, version: 2 }),
    ]) {
      await expect(run(caller(db))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    // The session says admin and jcrc; that grants nothing, and nothing wrote.
    expect(calls.filter((c) => /create|update|$transaction/.test(c))).toEqual(
      [],
    );
    expect(calls).not.toContain("userRole.findMany");
  });

  it("a return needs a reason and an approval note has a ceiling", async () => {
    const { db } = fakeDb("on");
    await expect(
      caller(db).return({ id: ID, version: 1, reason: "   " }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller(db).approve({ id: ID, version: 1, note: "x".repeat(501) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("cannot be told a CCA, a position, a status or a self-approved flag", async () => {
    const { db } = fakeDb("on");
    // Unknown keys are dropped; the proposal is not found, so nothing is asked.
    await expect(
      caller(db).approve({
        id: ID,
        version: 1,
        ccaID: 7,
        status: "cleared",
        selfApproved: false,
        approverID: "E9",
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(db.proposalStatusHistory.create).not.toHaveBeenCalled();
  });

  describe("directorEntry", () => {
    it("is a plain false while proposals are off, and logs nothing", async () => {
      const { db, calls } = fakeDb("off");
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      await expect(caller(db).directorEntry()).resolves.toEqual({
        show: false,
      });
      expect(calls).toEqual(["systemFlag.proposals.enabled"]);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("is a plain false for someone who directs nothing", async () => {
      const { db } = fakeDb("on");
      await expect(caller(db).directorEntry()).resolves.toEqual({
        show: false,
      });
    });

    it("is an error, not a false, when a guard read fails", async () => {
      const { db } = fakeDb("on");
      db.systemFlag.findUnique.mockImplementation((({
        where,
      }: {
        where: { key: string };
      }) =>
        where.key === "proposals.enabled"
          ? Promise.resolve({ key: where.key, value: "on" })
          : Promise.reject(new Error("db down"))) as never);
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      await expect(caller(db).directorEntry()).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(String(spy.mock.calls[0]?.[0])).not.toContain("db down");
      spy.mockRestore();
    });

    it("needs a signed-in user", async () => {
      const { db } = fakeDb("on");
      await expect(
        caller(db, { signedIn: false }).directorEntry(),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });
});
