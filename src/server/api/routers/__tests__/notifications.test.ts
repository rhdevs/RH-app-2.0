import { beforeEach, describe, expect, it, vi } from "vitest";

// The router module pulls in NextAuth and Prisma through trpc.ts; neither is
// needed to exercise the checks, so both are replaced.
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));
const rateLimit = vi.fn();
vi.mock("~/lib/rateLimit", () => ({
  rateLimit: (...a: unknown[]) => rateLimit(...a),
}));
const runDueCheck = vi.fn();
vi.mock("~/server/api/services/dueCheck/runner", () => ({
  runDueCheck: (...a: unknown[]) => runDueCheck(...a),
}));

import { notificationsRouter } from "~/server/api/routers/notifications";
import { resetNotificationsFlagCache } from "~/server/api/services/notifications";
import { createCallerFactory } from "~/server/api/trpc";

const createCaller = createCallerFactory(notificationsRouter);

const ME = "E1000001";
const ID = "0123456789abcdef01234567";

/** Every delegate method the router could call, each recorded by name. */
function fakeDb(flag: "on" | "off" | "throws") {
  const calls: string[] = [];
  const spy = <T>(name: string, result: T) =>
    vi.fn(async (args?: unknown) => {
      calls.push(name);
      void args;
      return result;
    });
  const notification = {
    count: spy("count", 3),
    findMany: spy("findMany", [] as unknown[]),
    updateMany: spy("updateMany", { count: 1 }),
    create: spy("create", {}),
    createMany: spy("createMany", { count: 0 }),
    update: spy("update", {}),
    delete: spy("delete", {}),
    deleteMany: spy("deleteMany", { count: 0 }),
    upsert: spy("upsert", {}),
  };
  const db = {
    systemFlag: {
      findUnique: vi.fn(async () => {
        if (flag === "throws") throw new Error("db down");
        return { key: "notifications.enabled", value: flag };
      }),
    },
    notification,
  };
  return { db, calls, notification };
}

function caller(db: unknown, userID: string | null = ME) {
  return createCaller({
    db,
    headers: new Headers(),
    session: {
      user: { userID, roles: ["resident"], eligible: true },
      expires: new Date(Date.now() + 3_600_000).toISOString(),
    },
  } as never);
}

beforeEach(() => {
  resetNotificationsFlagCache();
  rateLimit.mockReset();
  rateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
  runDueCheck.mockReset();
  runDueCheck.mockResolvedValue({ written: 0, failedKinds: [] });
});

describe("the switch", () => {
  it.each(["off", "throws"] as const)(
    "refuses every inbox procedure while the flag read says %s",
    async (flag) => {
      const { db, calls } = fakeDb(flag);
      const c = caller(db);

      for (const run of [
        () => c.unreadCount(),
        () => c.list(),
        () => c.markRead({ ids: [ID] }),
        () => c.markAllRead(),
        () => c.runDueCheck(),
      ]) {
        resetNotificationsFlagCache();
        await expect(run()).rejects.toMatchObject({
          code: "FORBIDDEN",
          message: "NOTIFICATIONS_DISABLED",
        });
      }
      expect(calls).toEqual([]);
      expect(runDueCheck).not.toHaveBeenCalled();
      expect(rateLimit).not.toHaveBeenCalled();
    },
  );

  it("reports off, not an error, from enabled()", async () => {
    expect(await caller(fakeDb("off").db).enabled()).toEqual({
      enabled: false,
    });
    resetNotificationsFlagCache();
    expect(await caller(fakeDb("throws").db).enabled()).toEqual({
      enabled: false,
    });
    resetNotificationsFlagCache();
    expect(await caller(fakeDb("on").db).enabled()).toEqual({ enabled: true });
  });

  it("refuses a session with no canonical identity", async () => {
    await expect(
      caller(fakeDb("on").db, null).unreadCount(),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NO_CANONICAL_IDENTITY",
    });
  });
});

describe("the unread count is a pure read", () => {
  it("issues one count scoped to the caller and nothing else", async () => {
    const { db, calls, notification } = fakeDb("on");

    expect(await caller(db).unreadCount()).toEqual({ count: 3 });

    expect(calls).toEqual(["count"]);
    expect(notification.count).toHaveBeenCalledWith({
      where: { userID: ME, readAt: null },
    });
  });
});

describe("ownership", () => {
  it("lists only the caller's rows, newest first, one bounded page", async () => {
    const { db, notification } = fakeDb("on");

    await caller(db).list();

    const args = notification.findMany.mock.calls[0]![0] as {
      where: unknown;
      take: number;
      orderBy: unknown;
    };
    expect(args.where).toEqual({ userID: ME });
    expect(args.take).toBe(21);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("caps the page size and refuses a larger one", async () => {
    const { db, notification } = fakeDb("on");

    await expect(caller(db).list({ limit: 51 })).rejects.toThrow();
    await caller(db).list({ limit: 50 });

    expect(
      (notification.findMany.mock.calls[0]![0] as { take: number }).take,
    ).toBe(51);
  });

  it("returns a cursor only when there is another page", async () => {
    const { db, notification } = fakeDb("on");
    const row = (id: string) => ({ id });
    notification.findMany.mockResolvedValueOnce([row("a"), row("b"), row("c")]);

    const page = await caller(db).list({ limit: 2 });

    expect(page.items.map((r) => r.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("b");

    notification.findMany.mockResolvedValueOnce([row("a")]);
    expect((await caller(db).list({ limit: 2 })).nextCursor).toBeNull();
  });

  it("marks read only unread rows that belong to the caller", async () => {
    const { db, notification } = fakeDb("on");

    await caller(db).markRead({ ids: [ID] });
    await caller(db).markAllRead();

    const [one, all] = notification.updateMany.mock.calls.map(
      (c) => c[0] as { where: Record<string, unknown> },
    );
    expect(one!.where).toEqual({ id: { in: [ID] }, userID: ME, readAt: null });
    expect(all!.where).toEqual({ userID: ME, readAt: null });
  });

  it("has no procedure that creates a row or names a recipient", () => {
    expect(Object.keys(notificationsRouter._def.procedures).sort()).toEqual([
      "enabled",
      "list",
      "markAllRead",
      "markRead",
      "runDueCheck",
      "unreadCount",
    ]);
  });

  it("rejects a malformed or oversized id list", async () => {
    const { db } = fakeDb("on");

    await expect(caller(db).markRead({ ids: [] })).rejects.toThrow();
    await expect(caller(db).markRead({ ids: ["x"] })).rejects.toThrow();
    await expect(
      caller(db).markRead({ ids: Array.from({ length: 101 }, () => ID) }),
    ).rejects.toThrow();
  });
});

describe("runDueCheck", () => {
  it("runs for the signed-in user only and ignores any input naming someone else", async () => {
    const { db } = fakeDb("on");
    const c = caller(db) as unknown as {
      runDueCheck: (input?: unknown) => Promise<unknown>;
    };

    await c.runDueCheck({ userID: "E9999999", recipients: ["E9999999"] });

    expect(runDueCheck).toHaveBeenCalledTimes(1);
    expect(runDueCheck.mock.calls[0]![0]).toBe(db);
    expect(runDueCheck.mock.calls[0]![1]).toBe(ME);
    expect(runDueCheck.mock.calls[0]).toHaveLength(2);
  });

  it("is rate limited per person, and a refusal runs nothing", async () => {
    const { db } = fakeDb("on");
    rateLimit.mockResolvedValue({ allowed: false, retryAfter: 42 });

    await expect(caller(db).runDueCheck()).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "RATE_LIMITED:42",
    });

    expect(rateLimit).toHaveBeenCalledWith(
      `notifications.dueCheck:${ME}`,
      30,
      60 * 60 * 1000,
    );
    expect(runDueCheck).not.toHaveBeenCalled();
  });

  it("fails closed when the limiter itself fails", async () => {
    const { db } = fakeDb("on");
    rateLimit.mockRejectedValue(new Error("db down"));

    await expect(caller(db).runDueCheck()).rejects.toThrow();
    expect(runDueCheck).not.toHaveBeenCalled();
  });

  it("refuses a session with no canonical identity", async () => {
    await expect(
      caller(fakeDb("on").db, null).runDueCheck(),
    ).rejects.toMatchObject({ message: "NO_CANONICAL_IDENTITY" });
    expect(runDueCheck).not.toHaveBeenCalled();
  });
});
