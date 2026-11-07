import { beforeEach, describe, expect, it, vi } from "vitest";

// The router module pulls in NextAuth and Prisma through trpc.ts; neither is
// needed to exercise the checks, so both are replaced. So is the rate limiter,
// which would otherwise reach for the real database.
vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));
const rateLimit = vi.fn();
vi.mock("~/lib/rateLimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimit(...args) as unknown,
}));

import { feedbackRouter } from "~/server/api/routers/feedback";
import { resetFeedbackFlagCache } from "~/server/api/services/feedback";
import { createCallerFactory } from "~/server/api/trpc";

const createCaller = createCallerFactory(feedbackRouter);

const ME = "E1000001";
const ADMIN_ID = "E1000002";
const ID = "0123456789abcdef01234567";

type Flags = { feedback: "on" | "off" | "throws"; notifications: "on" | "off" };

function fakeDb(flags: Flags) {
  const calls: string[] = [];
  const spy = <T>(name: string, result: T) =>
    vi.fn(async (args?: unknown) => {
      calls.push(name);
      void args;
      return result;
    });
  const feedback = {
    create: spy("feedback.create", { id: ID }),
    findMany: spy("feedback.findMany", [] as unknown[]),
    update: spy("feedback.update", {}),
    delete: spy("feedback.delete", {}),
  };
  const notification = {
    createMany: vi.fn(async (args?: unknown) => {
      calls.push("notification.createMany");
      void args;
      return { count: 2 };
    }),
  };
  const userRole = {
    findMany: spy("userRole.findMany", [
      { userID: ADMIN_ID, roles: ["admin"], role: null },
      { userID: "E1000003", roles: ["resident", "admin"], role: null },
    ] as Array<{ userID: string; roles: string[]; role: string | null }>),
  };
  const db = {
    systemFlag: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        if (where.key === "feedback.enabled") {
          if (flags.feedback === "throws") throw new Error("db down");
          return { key: where.key, value: flags.feedback };
        }
        return { key: where.key, value: flags.notifications };
      }),
    },
    feedback,
    notification,
    userRole,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      calls.push("$transaction");
      return fn(db);
    }),
  };
  return { db, calls, feedback, notification, userRole };
}

function caller(
  db: unknown,
  opts: { userID?: string | null; roles?: string[]; signedIn?: boolean } = {},
) {
  const { userID = ME, roles = ["resident"], signedIn = true } = opts;
  return createCaller({
    db,
    headers: new Headers(),
    session: signedIn
      ? {
          user: { userID, roles, eligible: true },
          expires: new Date(Date.now() + 3_600_000).toISOString(),
        }
      : null,
  } as never);
}

const GOOD = {
  category: "bug" as const,
  message: "The bell icon overlaps the title.",
};
const ON: Flags = { feedback: "on", notifications: "on" };

beforeEach(() => {
  resetFeedbackFlagCache();
  rateLimit.mockReset();
  rateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 });
});

describe("the switch", () => {
  it.each(["off", "throws"] as const)(
    "refuses submit and list while the flag read says %s, touching nothing",
    async (feedback) => {
      const { db, calls } = fakeDb({ feedback, notifications: "on" });
      const user = caller(db);
      const admin = caller(db, { userID: ADMIN_ID, roles: ["admin"] });

      await expect(user.submit(GOOD)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "FEEDBACK_DISABLED",
      });
      await expect(admin.list()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "FEEDBACK_DISABLED",
      });

      expect(rateLimit).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    },
  );

  it("treats an absent row as off", async () => {
    const { db } = fakeDb(ON);
    db.systemFlag.findUnique = vi.fn(async () => null) as never;
    await expect(caller(db).submit(GOOD)).rejects.toMatchObject({
      message: "FEEDBACK_DISABLED",
    });
  });

  it("reads the flag once for calls inside the 15 second cache, and again after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { db } = fakeDb(ON);
      const user = caller(db);
      await user.enabled();
      await user.enabled();
      await user.submit(GOOD);
      expect(
        db.systemFlag.findUnique.mock.calls.filter(
          ([a]) => a.where.key === "feedback.enabled",
        ),
      ).toHaveLength(1);
      vi.advanceTimersByTime(15_001);
      await user.enabled();
      expect(
        db.systemFlag.findUnique.mock.calls.filter(
          ([a]) => a.where.key === "feedback.enabled",
        ),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failed read", async () => {
    const { db } = fakeDb({ feedback: "throws", notifications: "on" });
    const user = caller(db);
    expect(await user.enabled()).toEqual({ enabled: false });
    expect(await user.enabled()).toEqual({ enabled: false });
    expect(db.systemFlag.findUnique).toHaveBeenCalledTimes(2);
  });

  it("answers `enabled` with false, never an error, when off or unreadable", async () => {
    for (const feedback of ["off", "throws"] as const) {
      resetFeedbackFlagCache();
      const { db } = fakeDb({ feedback, notifications: "on" });
      expect(await caller(db).enabled()).toEqual({ enabled: false });
    }
    resetFeedbackFlagCache();
    expect(await caller(fakeDb(ON).db).enabled()).toEqual({ enabled: true });
  });
});

describe("who may call what", () => {
  it("refuses everything to a signed-out caller", async () => {
    const { db, calls } = fakeDb(ON);
    const c = caller(db, { signedIn: false });
    for (const run of [
      () => c.enabled(),
      () => c.submit(GOOD),
      () => c.list(),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a signed-in user with no canonical identity", async () => {
    const { db, feedback } = fakeDb(ON);
    await expect(
      caller(db, { userID: null }).submit(GOOD),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "NO_CANONICAL_IDENTITY",
    });
    expect(feedback.create).not.toHaveBeenCalled();
  });

  it.each([["resident"], ["jcrc"], ["cca_head"], ["scrc"]])(
    "refuses list to a %s, who cannot read feedback",
    async (role) => {
      const { db, feedback } = fakeDb(ON);
      await expect(caller(db, { roles: [role] }).list()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "ADMIN_REQUIRED",
      });
      expect(feedback.findMany).not.toHaveBeenCalled();
    },
  );
});

describe("submit: validation", () => {
  it.each([
    ["an empty message", { ...GOOD, message: "" }],
    ["a blank message", { ...GOOD, message: " \n\t " }],
    ["a message of only control characters", { ...GOOD, message: "\u0000​" }],
    ["an over-long message", { ...GOOD, message: "x".repeat(2001) }],
    ["an unknown category", { ...GOOD, category: "rant" }],
    ["no category", { message: "hi" }],
    ["a non-string message", { ...GOOD, message: 5 }],
  ])("refuses %s before any write or rate-limit spend", async (_n, input) => {
    const { db, calls } = fakeDb(ON);
    await expect(caller(db).submit(input as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("accepts a message of exactly 2000 characters", async () => {
    const { db, feedback } = fakeDb(ON);
    await caller(db).submit({ ...GOOD, message: "x".repeat(2000) });
    expect(feedback.create).toHaveBeenCalledTimes(1);
  });

  it("takes the submitter from the session and ignores a typed user id", async () => {
    const { db, feedback } = fakeDb(ON);
    await caller(db).submit({ ...GOOD, userID: "E9999999" } as never);
    expect(feedback.create).toHaveBeenCalledWith({
      data: { userID: ME, category: "bug", message: GOOD.message },
      select: { id: true },
    });
  });

  it('stores < & and " verbatim and strips control characters', async () => {
    const { db, feedback } = fakeDb(ON);
    await caller(db).submit({
      category: "other",
      message: `  <script>alert("x")</script> Fish & Chips\u0000‮\nline 2  `,
    });
    const arg = feedback.create.mock.calls[0]![0] as {
      data: { message: string };
    };
    expect(arg.data.message).toBe(
      `<script>alert("x")</script> Fish & Chips\nline 2`,
    );
  });
});

describe("submit: rate limit", () => {
  it("spends one unit per submit, keyed on the user", async () => {
    const { db } = fakeDb(ON);
    await caller(db).submit(GOOD);
    expect(rateLimit).toHaveBeenCalledWith(`feedback:${ME}`, 5, 3_600_000);
  });

  it("refuses with TOO_MANY_REQUESTS and writes nothing when the budget is spent", async () => {
    rateLimit.mockResolvedValue({ allowed: false, retryAfter: 90 });
    const { db, calls } = fakeDb(ON);
    await expect(caller(db).submit(GOOD)).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "RATE_LIMITED:90",
    });
    expect(calls).toEqual([]);
  });

  it("fails closed when the limiter itself throws", async () => {
    rateLimit.mockRejectedValue(new Error("limiter down"));
    const { db, calls } = fakeDb(ON);
    await expect(caller(db).submit(GOOD)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("submit: the notice to admins", () => {
  it("writes the report and one notice per admin in one transaction, without the text", async () => {
    const { db, calls, notification } = fakeDb(ON);
    const res = await caller(db).submit({
      category: "bug",
      message: "SECRET-TEXT-123",
    });

    expect(res).toEqual({ id: ID });
    expect(calls[0]).toBe("$transaction");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const rows = (
      notification.createMany.mock.calls[0]![0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(rows.map((r) => r.userID).sort()).toEqual([ADMIN_ID, "E1000003"]);
    for (const r of rows) {
      expect(r.kind).toBe("feedback.submitted");
      expect(r.href).toBe("/admin/feedback");
      expect(JSON.stringify(r)).not.toContain("SECRET-TEXT-123");
      expect(JSON.stringify(r)).not.toContain(ME);
    }
  });

  it("looks admins up from user records only", async () => {
    const { db, userRole } = fakeDb(ON);
    await caller(db).submit(GOOD);
    expect(userRole.findMany).toHaveBeenCalledWith({
      where: { OR: [{ roles: { has: "admin" } }, { role: "admin" }] },
      select: { userID: true, roles: true, role: true },
    });
  });

  it("counts the legacy role as admin only when roles is empty, like getUserRoles", async () => {
    const { db, userRole, notification } = fakeDb(ON);
    userRole.findMany.mockResolvedValue([
      { userID: "E1000011", roles: ["admin"], role: null },
      { userID: "E1000012", roles: [], role: "admin" },
      { userID: "E1000013", roles: ["resident"], role: "admin" },
      { userID: "E1000014", roles: ["resident", "admin"], role: "resident" },
    ]);
    await caller(db).submit(GOOD);
    const rows = (
      notification.createMany.mock.calls[0]![0] as {
        data: Array<Record<string, unknown>>;
      }
    ).data;
    expect(rows.map((r) => r.userID).sort()).toEqual([
      "E1000011",
      "E1000012",
      "E1000014",
    ]);
  });

  it("still saves the report, with no notice, while notifications are off", async () => {
    const { db, feedback, notification } = fakeDb({
      feedback: "on",
      notifications: "off",
    });
    await expect(caller(db).submit(GOOD)).resolves.toEqual({ id: ID });
    expect(feedback.create).toHaveBeenCalledTimes(1);
    expect(notification.createMany).not.toHaveBeenCalled();
  });

  it("fails the whole submit when the notice cannot be written", async () => {
    const { db, notification } = fakeDb(ON);
    notification.createMany.mockRejectedValue(new Error("write failed"));
    await expect(caller(db).submit(GOOD)).rejects.toBeDefined();
    // Both writes ran inside the one $transaction, which is what undoes the
    // report; the real rollback is proved in feedback.int.test.ts.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("list", () => {
  it("is bounded: refuses a limit over 50 and reads one extra row to find the next page", async () => {
    const { db, feedback } = fakeDb(ON);
    const admin = caller(db, { userID: ADMIN_ID, roles: ["admin"] });

    await expect(admin.list({ limit: 51 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(admin.list({ limit: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(admin.list({ cursor: "nope" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(feedback.findMany).not.toHaveBeenCalled();

    await admin.list({ limit: 50 });
    expect(feedback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 51 }),
    );
    await admin.list();
    expect(feedback.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 21 }),
    );
  });
});
