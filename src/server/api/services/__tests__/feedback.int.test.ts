import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the feedback form against the LOCAL development
 * database (skipped unless DATABASE_URL is the local dev database; run
 * `npm run test:db`). The tests own every row they touch: users E99902xx,
 * their rate-limit keys, and every `feedback.submitted` notice. The two flag
 * rows are restored to what they were.
 */

const U = "E9990201";
const V = "E9990202";
const ADMIN_A = "E9990291";
const ADMIN_B = "E9990292";
const LEGACY = "E9990293";
const MIXED = "E9990294";
const IDS = [U, V, ADMIN_A, ADMIN_B, LEGACY, MIXED];
const FEEDBACK_FLAG = "feedback.enabled";
const NOTIF_FLAG = "notifications.enabled";

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "feedback (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;

    const as = (
      userID: string,
      roles: string[] = ["resident"],
      client: PrismaClient = db,
    ) =>
      createCaller({
        db: client as never,
        session: {
          user: {
            userID,
            roles,
            eligible: true,
            hasMatric: true,
            credentialsStale: false,
          },
          expires: new Date(Date.now() + 3600_000).toISOString(),
        } as never,
        headers: new Headers({
          "x-forwarded-for": `203.0.113.${(ipCounter += 1)}`,
        }),
      }).feedback;

    const setFlag = async (key: string, value: string | null) => {
      if (value === null) {
        await db.systemFlag.deleteMany({ where: { key } });
      } else {
        await db.systemFlag.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
      const { resetFeedbackFlagCache } = await import(
        "~/server/api/services/feedback"
      );
      resetFeedbackFlagCache();
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
      await db.feedback.deleteMany({ where: { userID: { in: IDS } } });
      await db.notification.deleteMany({
        where: {
          OR: [{ userID: { in: IDS } }, { kind: "feedback.submitted" }],
        },
      });
      await db.userRole.deleteMany({
        where: { userID: { in: [ADMIN_A, ADMIN_B, LEGACY, MIXED] } },
      });
      await db.rateLimit.deleteMany({
        where: { key: { in: IDS.map((i) => `feedback:${i}`) } },
      });
      await db.user.deleteMany({ where: { email: { startsWith: "e99902" } } });
    };

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      for (const key of [FEEDBACK_FLAG, NOTIF_FLAG]) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
      const { resetNotificationsFlagCache } = await import(
        "~/server/api/services/notifications"
      );
      resetNotificationsFlagCache();
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await setFlag(FEEDBACK_FLAG, "on");
      await setFlag(NOTIF_FLAG, "on");
      await db.userRole.createMany({
        data: [
          { userID: ADMIN_A, roles: ["admin"] },
          { userID: ADMIN_B, roles: ["resident", "admin"] },
        ],
      });
    });

    afterAll(async () => {
      await clean();
      for (const [key, value] of Object.entries(original)) {
        await setFlag(key, value);
      }
    });

    it("refuses submit and list while the flag is off or absent, and saves nothing", async () => {
      for (const value of ["off", null] as const) {
        await setFlag(FEEDBACK_FLAG, value);
        expect(
          await errorOf(as(U).submit({ category: "bug", message: "hi" })),
        ).toBe("FORBIDDEN:FEEDBACK_DISABLED");
        expect(await errorOf(as(ADMIN_A, ["admin"]).list())).toBe(
          "FORBIDDEN:FEEDBACK_DISABLED",
        );
        expect(await as(U).enabled()).toEqual({ enabled: false });
      }
      expect(await db.feedback.count({ where: { userID: U } })).toBe(0);
    });

    it("saves the report and tells every admin, and only admins, without copying the text", async () => {
      const message = 'SECRET-TEXT-<b>&"x"';
      await as(U).submit({ category: "bug", message });

      const rows = await db.feedback.findMany({ where: { userID: U } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.message).toBe(message);

      const notices = await db.notification.findMany({
        where: { kind: "feedback.submitted" },
      });
      const recipients = notices.map((n) => n.userID);
      expect(recipients).toContain(ADMIN_A);
      expect(recipients).toContain(ADMIN_B);
      expect(recipients).not.toContain(U);
      expect(recipients).not.toContain(V);
      for (const n of notices) {
        expect(JSON.stringify(n)).not.toContain("SECRET-TEXT");
        expect(JSON.stringify(n)).not.toContain(U);
        expect(n.href).toBe("/admin/feedback");
        expect(n.readAt).toBeNull();
      }
    });

    it("does not tell a user whose legacy role says admin while roles says otherwise", async () => {
      await db.userRole.createMany({
        data: [
          { userID: LEGACY, roles: [], role: "admin" },
          { userID: MIXED, roles: ["resident"], role: "admin" },
        ],
      });
      await as(U).submit({ category: "bug", message: "who is told" });
      const recipients = (
        await db.notification.findMany({
          where: { kind: "feedback.submitted" },
        })
      ).map((n) => n.userID);
      expect(recipients).toContain(ADMIN_A);
      expect(recipients).toContain(LEGACY);
      expect(recipients).not.toContain(MIXED);
    });

    it("still saves the report when notifications are off, with no notice", async () => {
      await setFlag(NOTIF_FLAG, "off");
      const { resetNotificationsFlagCache } = await import(
        "~/server/api/services/notifications"
      );
      resetNotificationsFlagCache();

      await as(U).submit({ category: "other", message: "still saved" });

      expect(await db.feedback.count({ where: { userID: U } })).toBe(1);
      expect(
        await db.notification.count({ where: { kind: "feedback.submitted" } }),
      ).toBe(0);
    });

    it("rolls the report back when the notice cannot be written", async () => {
      const broken = db.$extends({
        query: {
          notification: {
            createMany() {
              return Promise.reject(new Error("notice write failed"));
            },
          },
        },
      }) as unknown as PrismaClient;

      expect(
        await errorOf(
          as(U, ["resident"], broken).submit({
            category: "bug",
            message: "must not survive",
          }),
        ),
      ).not.toBe("ok");

      expect(await db.feedback.count({ where: { userID: U } })).toBe(0);
      expect(
        await db.notification.count({ where: { kind: "feedback.submitted" } }),
      ).toBe(0);
    });

    it("rate limits a user's writes, per user", async () => {
      for (let i = 0; i < 5; i += 1) {
        await as(U).submit({ category: "bug", message: `report ${i}` });
      }
      expect(
        await errorOf(as(U).submit({ category: "bug", message: "one more" })),
      ).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
      expect(await db.feedback.count({ where: { userID: U } })).toBe(5);

      await as(V).submit({ category: "bug", message: "someone else is fine" });
      expect(await db.feedback.count({ where: { userID: V } })).toBe(1);
    });

    it("lets only an admin read, newest first, in bounded pages, with text verbatim", async () => {
      const message = `<script>alert("x")</script> Fish & Chips`;
      for (let i = 0; i < 3; i += 1) {
        await db.feedback.create({
          data: { userID: U, category: "bug", message: `${message} ${i}` },
        });
      }

      for (const roles of [["resident"], ["jcrc"], ["scrc"]]) {
        expect(await errorOf(as(U, roles).list())).toBe(
          "FORBIDDEN:ADMIN_REQUIRED",
        );
      }
      const admin = as(ADMIN_A, ["admin"]);
      expect(await errorOf(admin.list({ limit: 51 }))).toMatch(/^BAD_REQUEST/);

      const first = await admin.list({ limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = await admin.list({ limit: 2, cursor: first.nextCursor! });
      const mine = [...first.items, ...second.items].filter(
        (i) => i.userID === U,
      );
      expect(new Set(mine.map((i) => i.id)).size).toBe(3);
      expect(mine.map((i) => i.message)).toEqual(
        [2, 1, 0].map((i) => `${message} ${i}`),
      );
    });

    it("deletes a user's feedback with their account, and no one else's", async () => {
      const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
        "~/server/api/services/userAdmin"
      );
      const user = await db.user.create({
        data: { email: "e9990201@u.nus.edu", userID: U },
      });
      await db.feedback.createMany({
        data: [
          { userID: U, category: "bug", message: "mine 1" },
          { userID: U, category: "bug", message: "mine 2" },
          { userID: V, category: "bug", message: "someone else" },
        ],
      });

      const target = await loadAdminUserTarget(db, user.id);
      const result = await deleteUserAccountCascade(db, target, ADMIN_A);

      expect(result.deleted.feedback).toBe(2);
      expect(await db.feedback.count({ where: { userID: U } })).toBe(0);
      expect(await db.feedback.count({ where: { userID: V } })).toBe(1);
    });
  },
);
