import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type { notify as Notify } from "~/server/api/services/notifications";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the in-app inbox against the LOCAL development database
 * (skipped unless DATABASE_URL is the local dev database; run
 * `npm run test:db`). The tests own every row they touch: users E99901xx and
 * SystemFlag keys "test.notif.*", all removed before and after each test. The
 * `notifications.enabled` row is restored to what it was.
 */

const A = "E9990101";
const B = "E9990102";
const ADMIN = "E9990199";
const IDS = [A, B];
const FLAG = "notifications.enabled";
const TEST_FLAG_PREFIX = "test.notif.";

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "in-app notifications (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let notify: typeof Notify;
    let resetCache: () => void;
    let originalFlag: string | null = null;
    let ipCounter = 0;
    const ops: string[] = [];

    const as = (userID: string) =>
      createCaller({
        // Every Prisma operation goes through here, so a test can list them.
        db: db.$extends({
          query: {
            $allModels: {
              async $allOperations({ model, operation, args, query }) {
                ops.push(`${model}.${operation}`);
                return query(args);
              },
            },
          },
        }) as never,
        session: {
          user: {
            userID,
            roles: ["resident"],
            eligible: true,
            hasMatric: true,
            credentialsStale: false,
          },
          expires: new Date(Date.now() + 3600_000).toISOString(),
        } as never,
        headers: new Headers({
          "x-forwarded-for": `203.0.113.${(ipCounter += 1)}`,
        }),
      }).notifications;

    const setFlag = async (value: string | null) => {
      if (value === null) {
        await db.systemFlag.deleteMany({ where: { key: FLAG } });
      } else {
        await db.systemFlag.upsert({
          where: { key: FLAG },
          create: { key: FLAG, value },
          update: { value },
        });
      }
      resetCache();
    };

    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}:${e.message}`;
      }
      return "ok";
    };

    const clean = async () => {
      await db.notification.deleteMany({ where: { userID: { in: IDS } } });
      await db.systemFlag.deleteMany({
        where: { key: { startsWith: TEST_FLAG_PREFIX } },
      });
      await db.user.deleteMany({
        where: { email: { startsWith: "e99901" } },
      });
    };

    const seed = (userID: string, title: string, over: object = {}) =>
      notify(db, { recipients: [userID], kind: "test.seed", title, ...over });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ notify } = await import("~/server/api/services/notifications"));
      const { resetNotificationsFlagCache } = await import(
        "~/server/api/services/notifications"
      );
      resetCache = resetNotificationsFlagCache;
      originalFlag =
        (await db.systemFlag.findUnique({ where: { key: FLAG } }))?.value ??
        null;
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setFlag("on");
      ops.length = 0;
    });

    afterAll(async () => {
      await clean();
      await setFlag(originalFlag);
    });

    it("refuses every procedure while the flag is off or absent, and notify writes nothing", async () => {
      await seed(A, "before");
      for (const value of ["off", null] as const) {
        await setFlag(value);
        const me = as(A);

        expect(await errorOf(me.unreadCount())).toBe(
          "FORBIDDEN:NOTIFICATIONS_DISABLED",
        );
        expect(await errorOf(me.list())).toBe(
          "FORBIDDEN:NOTIFICATIONS_DISABLED",
        );
        expect(await errorOf(me.markAllRead())).toBe(
          "FORBIDDEN:NOTIFICATIONS_DISABLED",
        );
        expect(await me.enabled()).toEqual({ enabled: false });
        expect(await seed(A, "while off")).toEqual({ written: 0 });
      }

      expect(await db.notification.count({ where: { userID: A } })).toBe(1);
    });

    it("lets a user see and change only their own rows", async () => {
      await seed(A, "for A");
      await seed(B, "for B");
      const aRow = await db.notification.findFirstOrThrow({
        where: { userID: A },
      });

      const mineA = await as(A).list();
      const mineB = await as(B).list();
      expect(mineA.items.map((i) => i.title)).toEqual(["for A"]);
      expect(mineB.items.map((i) => i.title)).toEqual(["for B"]);

      // B names A's row: nothing changes and nothing is revealed.
      expect(await as(B).markRead({ ids: [aRow.id] })).toEqual({ updated: 0 });
      expect(await as(B).markAllRead()).toEqual({ updated: 1 });
      const after = await db.notification.findMany({ where: { userID: A } });
      expect(after.map((r) => r.readAt)).toEqual([null]);
      expect((await as(A).unreadCount()).count).toBe(1);
      expect((await as(B).unreadCount()).count).toBe(0);

      expect(await as(A).markRead({ ids: [aRow.id] })).toEqual({ updated: 1 });
      expect((await as(A).unreadCount()).count).toBe(0);
    });

    it("counts unread without writing anything", async () => {
      await seed(A, "one");
      await seed(A, "two");
      const before = await db.notification.findMany({
        where: { userID: A },
        orderBy: { id: "asc" },
      });
      ops.length = 0;

      const res = await as(A).unreadCount();
      const again = await as(A).unreadCount();

      expect(res).toEqual({ count: 2 });
      expect(again).toEqual({ count: 2 });
      expect(ops).toContain("Notification.count");
      expect(ops.filter((o) => !/\.(count|findUnique)$/.test(o))).toEqual([]);
      expect(
        await db.notification.findMany({
          where: { userID: A },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
    });

    it("commits the rows with the caller's change, and rolls both back together", async () => {
      const key = `${TEST_FLAG_PREFIX}rollback`;

      await expect(
        db.$transaction(async (tx) => {
          await tx.systemFlag.create({ data: { key, value: "x" } });
          const res = await notify(tx, {
            recipients: [A, B],
            kind: "test.rollback",
            title: "never seen",
          });
          expect(res.written).toBe(2);
          throw new Error("caller failed after notifying");
        }),
      ).rejects.toThrow("caller failed after notifying");

      expect(await db.systemFlag.findUnique({ where: { key } })).toBeNull();
      expect(
        await db.notification.count({ where: { userID: { in: IDS } } }),
      ).toBe(0);

      await db.$transaction(async (tx) => {
        await tx.systemFlag.create({ data: { key, value: "x" } });
        await notify(tx, {
          recipients: [A, B],
          kind: "test.commit",
          title: "seen",
        });
      });

      expect(await db.systemFlag.findUnique({ where: { key } })).not.toBeNull();
      expect(
        await db.notification.count({ where: { userID: { in: IDS } } }),
      ).toBe(2);
    });

    it("rolls the caller's change back when a notice cannot be written", async () => {
      const key = `${TEST_FLAG_PREFIX}badnotice`;

      await expect(
        db.$transaction(async (tx) => {
          await tx.systemFlag.create({ data: { key, value: "x" } });
          await notify(tx, {
            recipients: [A],
            kind: "test.bad",
            title: "x".repeat(500),
          });
        }),
      ).rejects.toThrow(/notify:/);

      expect(await db.systemFlag.findUnique({ where: { key } })).toBeNull();
    });

    it("rolls the caller's change back when the flag read fails", async () => {
      const key = `${TEST_FLAG_PREFIX}flagreadfail`;

      await expect(
        db.$transaction(async (tx) => {
          await tx.systemFlag.create({ data: { key, value: "x" } });
          const broken = {
            notification: tx.notification,
            systemFlag: {
              findUnique: () => Promise.reject(new Error("flag read failed")),
            },
          } as unknown as Parameters<typeof notify>[0];
          await notify(broken, {
            recipients: [A],
            kind: "test.flagfail",
            title: "never seen",
          });
        }),
      ).rejects.toThrow("flag read failed");

      expect(await db.systemFlag.findUnique({ where: { key } })).toBeNull();
      expect(
        await db.notification.count({ where: { userID: { in: IDS } } }),
      ).toBe(0);
    });

    it('stores and returns a title with < & and " exactly as given', async () => {
      const title = `<script>alert("x")</script> Fish & Chips`;
      const body = `a < b && "c"`;
      await seed(A, title, { body });

      const { items } = await as(A).list();

      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe(title);
      expect(items[0]!.body).toBe(body);
    });

    it("never returns more than one bounded page, and pages do not overlap", async () => {
      await notify(db, {
        recipients: [A],
        kind: "test.bulk",
        title: "bulk",
      });
      for (let i = 0; i < 54; i += 1) await seed(A, `n${i}`);

      expect(await errorOf(as(A).list({ limit: 51 }))).toMatch(/^BAD_REQUEST/);
      const first = await as(A).list({ limit: 50 });
      expect(first.items).toHaveLength(50);
      expect(first.nextCursor).not.toBeNull();
      const second = await as(A).list({ limit: 50, cursor: first.nextCursor! });
      expect(second.items).toHaveLength(5);
      expect(second.nextCursor).toBeNull();

      const ids = [...first.items, ...second.items].map((i) => i.id);
      expect(new Set(ids).size).toBe(55);
    });

    it("deletes a user's inbox with their account, and no one else's", async () => {
      const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
        "~/server/api/services/userAdmin"
      );
      const user = await db.user.create({
        data: { email: "e9990101@u.nus.edu", userID: A },
      });
      await seed(A, "mine 1");
      await seed(A, "mine 2");
      await seed(B, "someone else");

      const target = await loadAdminUserTarget(db, user.id);
      const result = await deleteUserAccountCascade(db, target, ADMIN);

      expect(target.canonicalUserID).toBe(A);
      expect(result.deleted.notification).toBe(2);
      expect(await db.notification.count({ where: { userID: A } })).toBe(0);
      expect(await db.notification.count({ where: { userID: B } })).toBe(1);
    });
  },
);
