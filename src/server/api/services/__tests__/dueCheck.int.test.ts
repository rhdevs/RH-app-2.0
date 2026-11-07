import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type { runDueCheck as RunDueCheck } from "~/server/api/services/dueCheck/runner";
import type { DueKind } from "~/server/api/services/dueCheck/types";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";

/**
 * INTEGRATION TESTS of the due check (4.4, A49, A50, A51) against the LOCAL
 * development database (skipped unless DATABASE_URL is the local dev database;
 * run `npm run test:db`). Run this file on its own. It needs the proposal
 * index script to have run (create-proposal-indexes.mjs --commit), for the
 * partial unique index on Notification.noticeKey that settles two writers.
 *
 * The tests own every row they touch: users E99910xx, CCAs 9031 and 9032
 * (rows written and removed), positions named "TEST ...", and those users'
 * notices. The flag rows are put back as they were. Other CCAs in the
 * database make notices of their own, so assertions look at this file's CCAs
 * only.
 */

const U = {
  admin: "E9991001",
  scrc: "E9991002",
  hall: "E9991003",
  member: "E9991004", // resident only
  jcrc: "E9991005", // jcrc, no staff role
  dir: "E9991006", // director of 9032
  other: "E9991007", // a second admin, to show runs stay with their person
};
const NO_ROLE_ROW = "E9991099";
const IDS = [...Object.values(U), NO_ROLE_ROW];
const CCA_VACANT = 9031;
const CCA_COVERED = 9032;
const CCAS = [CCA_VACANT, CCA_COVERED];
const FLAGS = [
  "proposals.enabled",
  "directors.enabled",
  "notifications.enabled",
];
const KEY_PREFIX = "due.cca_no_director:";
const DAY_MS = 86_400_000;
// 11:00 in Singapore on 2 Nov 2026.
const NOW = new Date("2026-11-02T03:00:00Z");

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "due check (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let runDueCheck: typeof RunDueCheck;
    let resetCache: () => void;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;
    const ops: string[] = [];

    const as = (userID: string, client: PrismaClient = db) =>
      createCaller({
        db: client as never,
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
          "x-forwarded-for": `192.0.2.${(ipCounter += 1)}`,
        }),
      }).notifications;

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
      if (key === "notifications.enabled") resetCache();
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
      await db.rateLimit.deleteMany({
        where: { key: { in: IDS.map((i) => `notifications.dueCheck:${i}`) } },
      });
      await db.notification.deleteMany({ where: { userID: { in: IDS } } });
      const positions = await db.jcrcPosition.findMany({
        where: { name: { startsWith: "TEST " } },
        select: { id: true },
      });
      const pids = positions.map((p) => p.id);
      await db.jcrcPositionCca.deleteMany({
        where: { positionID: { in: pids } },
      });
      await db.jcrcPositionHolder.deleteMany({
        where: { OR: [{ positionID: { in: pids } }, { userID: { in: IDS } }] },
      });
      await db.jcrcPosition.deleteMany({ where: { id: { in: pids } } });
      await db.jcrcTerm.deleteMany({ where: { userID: { in: IDS } } });
      await db.userRole.deleteMany({ where: { userID: { in: IDS } } });
      await db.cCA.deleteMany({ where: { ccaID: { in: CCAS } } });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.upsert({
        where: { userID },
        create: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
        update: { roles },
      });

    /** A vetting position over CCA_COVERED, held by a jcrc member. */
    const seedDirector = async () => {
      await setRoles(U.dir, ["resident", "jcrc"]);
      const p = await db.jcrcPosition.create({
        data: { name: "TEST director", createdBy: "test", vetsProposals: true },
      });
      await db.jcrcPositionCca.create({
        data: { positionID: p.id, ccaID: CCA_COVERED, addedBy: "test" },
      });
      await db.jcrcPositionHolder.create({
        data: {
          positionID: p.id,
          userID: U.dir,
          assignedBy: U.admin,
          endsAt: null,
        },
      });
    };

    /** This person's no-director notice keys: one per Singapore day. */
    const keysOf = async (userID: string) =>
      (
        await db.notification.findMany({
          where: { userID, noticeKey: { startsWith: KEY_PREFIX } },
          select: { noticeKey: true },
        })
      )
        .map((n) => n.noticeKey!)
        .sort();

    const keyFor = (userID: string, day = "2026-11-02") =>
      `${KEY_PREFIX}${day}|${userID}`;

    /** The number of CCAs the person's latest notice says have no director. */
    const vacantCount = async (userID: string) => {
      const row = await db.notification.findFirst({
        where: { userID, kind: "cca.no_director" },
        orderBy: { createdAt: "desc" },
      });
      return row ? Number(/^([0-9]+) CCA/.exec(row.title)![1]) : 0;
    };

    const countOf = (userID: string, kind?: string) =>
      db.notification.count({ where: { userID, ...(kind && { kind }) } });

    const proxied = (
      target: PrismaClient,
      patch: (prop: string | symbol) => unknown,
    ) =>
      new Proxy(target, {
        get: (_t, prop) => {
          const patched = patch(prop);
          if (patched !== undefined) return patched;
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function"
            ? (v as (...a: unknown[]) => unknown).bind(target)
            : v;
        },
      });

    /** A database where one table's reads fail. */
    const withFailingReads = (table: string): PrismaClient => {
      const boom = () => Promise.reject(new Error("db down"));
      return proxied(db, (prop) =>
        prop === table
          ? { findFirst: boom, findMany: boom, findUnique: boom }
          : undefined,
      );
    };

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      ({ resetNotificationsFlagCache: resetCache } = await import(
        "~/server/api/services/notifications"
      ));
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, "on");
      await db.cCA.createMany({
        data: CCAS.map((ccaID) => ({
          ccaID,
          ccaName: `Test CCA ${ccaID}`,
          category: "Test",
        })),
      });
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.other, ["resident", "admin"]);
      await setRoles(U.scrc, ["resident", "scrc"]);
      await setRoles(U.hall, ["resident", "hall_office"]);
      await setRoles(U.member, ["resident"]);
      await setRoles(U.jcrc, ["resident", "jcrc"]);
      await seedDirector();
      ops.length = 0;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, original[key] ?? null);
    });

    describe("the CCA with no director (A49)", () => {
      it("tells an admin, an RF and Hall Office, once per CCA and person", async () => {
        for (const id of [U.admin, U.scrc, U.hall]) {
          const res = await runDueCheck(db, id, { now: NOW });
          expect(res.failedKinds).toEqual([]);
        }

        for (const id of [U.admin, U.scrc, U.hall]) {
          expect(await keysOf(id)).toEqual([keyFor(id)]);
          // 9031 has no director, so the count is at least 1.
          expect(await vacantCount(id)).toBeGreaterThanOrEqual(1);
        }
        const row = await db.notification.findFirstOrThrow({
          where: { userID: U.admin, kind: "cca.no_director" },
        });
        expect(row.title).toMatch(/^[0-9]+ CCAs? ha(s|ve) no director/);
        expect(row.title).not.toContain("Test CCA");
        expect(row.body ?? "").not.toContain(U.dir);
        expect(row.href).toBe("/scrc");
        expect(row.readAt).toBeNull();
      });

      it("gives a plain member, a JCRC member who is not staff, and a stranger nothing", async () => {
        for (const id of [U.member, U.jcrc, U.dir, NO_ROLE_ROW]) {
          await runDueCheck(db, id, { now: NOW });
        }
        expect(
          await db.notification.count({
            where: { userID: { in: [U.member, U.jcrc, U.dir, NO_ROLE_ROW] } },
          }),
        ).toBe(0);
      });

      it("writes once per Singapore day: a repeat is silent, the next day writes again", async () => {
        await runDueCheck(db, U.admin, { now: NOW });
        await runDueCheck(db, U.admin, {
          now: new Date(NOW.getTime() + 60_000),
        });
        expect(await keysOf(U.admin)).toHaveLength(1);

        // 15:59 UTC is still the same Singapore day; 16:00 UTC is the next.
        await runDueCheck(db, U.admin, {
          now: new Date("2026-11-02T15:59:59Z"),
        });
        expect(await keysOf(U.admin)).toHaveLength(1);
        await runDueCheck(db, U.admin, {
          now: new Date("2026-11-02T16:00:00Z"),
        });
        expect(await keysOf(U.admin)).toEqual([
          keyFor(U.admin),
          keyFor(U.admin, "2026-11-03"),
        ]);
      });

      it("counts one fewer once a director is set", async () => {
        await runDueCheck(db, U.admin, { now: NOW });
        const before = await vacantCount(U.admin);
        expect(before).toBeGreaterThanOrEqual(1);

        const p = await db.jcrcPosition.create({
          data: { name: "TEST new", createdBy: "test", vetsProposals: true },
        });
        await db.jcrcPositionCca.create({
          data: { positionID: p.id, ccaID: CCA_VACANT, addedBy: "test" },
        });
        await db.jcrcPositionHolder.create({
          data: {
            positionID: p.id,
            userID: U.dir,
            assignedBy: U.admin,
            endsAt: null,
          },
        });
        await db.notification.deleteMany({ where: { userID: U.admin } });
        await runDueCheck(db, U.admin, { now: NOW });
        expect(await vacantCount(U.admin)).toBe(before - 1);
      });

      it("treats an ended holder, or one who lost jcrc, as no director", async () => {
        await runDueCheck(db, U.admin, { now: NOW });
        const before = await vacantCount(U.admin);

        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dir },
          data: { endsAt: new Date(NOW.getTime() - DAY_MS) },
        });
        await db.notification.deleteMany({ where: { userID: U.admin } });
        await runDueCheck(db, U.admin, { now: NOW });
        expect(await vacantCount(U.admin)).toBe(before + 1);

        await db.notification.deleteMany({ where: { userID: U.admin } });
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dir },
          data: { endsAt: null },
        });
        await setRoles(U.dir, ["resident"]);
        await runDueCheck(db, U.admin, { now: NOW });
        expect(await vacantCount(U.admin)).toBe(before + 1);
      });

      it("is one notice however many CCAs have no director", async () => {
        const extra = Array.from({ length: 5 }, (_, i) => 9040 + i);
        await db.cCA.createMany({
          data: extra.map((ccaID) => ({
            ccaID,
            ccaName: `Test CCA ${ccaID}`,
            category: "Test",
          })),
        });
        try {
          await runDueCheck(db, U.admin, { now: NOW });
          expect(await keysOf(U.admin)).toEqual([keyFor(U.admin)]);
          expect(await countOf(U.admin)).toBe(1);
          expect(await vacantCount(U.admin)).toBeGreaterThanOrEqual(6);
        } finally {
          await db.cCA.deleteMany({ where: { ccaID: { in: extra } } });
        }
      });

      it("says nothing while directors.enabled is off, absent or odd", async () => {
        for (const value of ["off", null, "yes"]) {
          await setFlag("directors.enabled", value);
          await runDueCheck(db, U.admin, { now: NOW });
          expect(await keysOf(U.admin)).toEqual([]);
        }
      });

      it.each(["proposals.enabled", "directors.enabled"])(
        "writes nothing and logs when the %s read fails",
        async (key) => {
          const log = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
          const real = db.systemFlag.findUnique.bind(db.systemFlag);
          const flaky = proxied(db, (prop) =>
            prop === "systemFlag"
              ? {
                  findUnique: (args: { where: { key: string } }) =>
                    args.where.key === key
                      ? Promise.reject(new Error("db down"))
                      : real(args as never),
                }
              : undefined,
          );

          const res = await runDueCheck(flaky, U.admin, { now: NOW });

          expect(res).toEqual({ written: 0, failedKinds: ["cca_no_director"] });
          expect(await keysOf(U.admin)).toEqual([]);
          const logged = log.mock.calls.map((c) => String(c[0])).join(" ");
          expect(logged).toContain("due_check_kind_failed");
          expect(logged).not.toContain("db down");
        },
      );

      it.each([
        ["off", "off"],
        ["absent", null],
        ["something else", "yes"],
      ])(
        "writes nothing while proposals.enabled is %s",
        async (_name, value) => {
          await setFlag("proposals.enabled", value);
          await runDueCheck(db, U.admin, { now: NOW });
          expect(await keysOf(U.admin)).toEqual([]);
        },
      );

      it("writes nothing while notifications.enabled is off", async () => {
        await setFlag("notifications.enabled", "off");
        const res = await runDueCheck(db, U.admin, { now: NOW });
        expect(res.written).toBe(0);
        expect(await countOf(U.admin)).toBe(0);
      });

      it.each([
        ["the person's role", "userRole"],
        ["the term table", "jcrcTerm"],
        ["the holder table", "jcrcPositionHolder"],
        ["the position links", "jcrcPositionCca"],
        ["the CCA list", "cCA"],
      ])(
        "writes nothing and logs the error name when %s cannot be read",
        async (_name, table) => {
          const log = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);

          const res = await runDueCheck(withFailingReads(table), U.admin, {
            now: NOW,
          });

          expect(res).toEqual({
            written: 0,
            failedKinds: ["cca_no_director"],
          });
          expect(await keysOf(U.admin)).toEqual([]);
          const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
          expect(logged).toContain("due_check_kind_failed");
          expect(logged).toContain('"error":"Error"');
          expect(logged).not.toContain("db down");
        },
      );
    });

    describe("two runs at once, and repeat calls (A51)", () => {
      it("writes each notice once when many runs start together", async () => {
        await Promise.all(
          Array.from({ length: 8 }, () =>
            runDueCheck(db, U.admin, { now: NOW }),
          ),
        );
        expect(await keysOf(U.admin)).toEqual([keyFor(U.admin)]);
      });

      it("writes once through the mutation from three tabs at once, then a fourth call", async () => {
        await Promise.all([
          as(U.scrc).runDueCheck(),
          as(U.scrc).runDueCheck(),
          as(U.scrc).runDueCheck(),
        ]);
        await as(U.scrc).runDueCheck();
        expect(await keysOf(U.scrc)).toHaveLength(1);
      });

      it("writes a fake kind's notice once under simultaneous runs, and nothing for a person with nothing due", async () => {
        const kind: DueKind = {
          name: "fake",
          noticeKind: "test.due",
          catchUp: "all",
          due: async ({ userID, dayKey }) =>
            userID === U.admin
              ? [{ key: `test.due:${dayKey}`, title: "Fake" }]
              : [],
        };
        await Promise.all(
          Array.from({ length: 6 }, () =>
            runDueCheck(db, U.admin, { kinds: [kind], now: NOW }),
          ),
        );
        await runDueCheck(db, U.member, { kinds: [kind], now: NOW });

        expect(await countOf(U.admin, "test.due")).toBe(1);
        expect(await countOf(U.member)).toBe(0);
      });

      it("works only for the person it is given", async () => {
        await runDueCheck(db, U.admin, { now: NOW });
        expect(await countOf(U.other)).toBe(0);
        expect(await countOf(U.scrc)).toBe(0);
      });
    });

    describe("kinds run on their own", () => {
      it("lets a kind that throws leave the others to run", async () => {
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        const bad: DueKind = {
          name: "bad",
          noticeKind: "test.bad",
          catchUp: "all",
          due: () => Promise.reject(new TypeError("oops")),
        };
        const good: DueKind = {
          name: "good",
          noticeKind: "test.due",
          catchUp: "all",
          due: async () => [{ key: "test.due:good", title: "Good" }],
        };

        const res = await runDueCheck(db, U.admin, {
          kinds: [bad, good],
          now: NOW,
        });

        expect(res).toEqual({ written: 1, failedKinds: ["bad"] });
        expect(await countOf(U.admin, "test.due")).toBe(1);
        expect(log.mock.calls.map((c) => String(c[0])).join()).toContain(
          "TypeError",
        );
      });

      it("writes only the most urgent missed reminder of a kind that asks for it", async () => {
        const late: DueKind = {
          name: "late",
          noticeKind: "test.due",
          catchUp: "mostUrgent",
          due: async () => [
            { key: "test.due:week1", title: "Week 1", urgency: 1 },
            { key: "test.due:week3", title: "Week 3", urgency: 3 },
            { key: "test.due:week2", title: "Week 2", urgency: 2 },
          ],
        };
        await runDueCheck(db, U.admin, { kinds: [late], now: NOW });
        const rows = await db.notification.findMany({
          where: { userID: U.admin, kind: "test.due" },
        });
        expect(rows.map((r) => r.title)).toEqual(["Week 3"]);
      });
    });

    describe("the mutation", () => {
      it("writes to the caller only", async () => {
        const res = await as(U.admin).runDueCheck();
        expect(res.failedKinds).toEqual([]);
        expect(await keysOf(U.admin)).toHaveLength(1);
        expect(await countOf(U.other)).toBe(0);
      });

      it.each([
        ["off", "off"],
        ["absent", null],
      ])(
        "is refused, and writes nothing, while notifications.enabled is %s",
        async (_name, value) => {
          await setFlag("notifications.enabled", value);
          expect(await errorOf(as(U.admin).runDueCheck())).toBe(
            "FORBIDDEN:NOTIFICATIONS_DISABLED",
          );
          expect(await countOf(U.admin)).toBe(0);
        },
      );

      it("is refused when the flag cannot be read", async () => {
        const unreadable = proxied(db, (prop) =>
          prop === "systemFlag"
            ? { findUnique: () => Promise.reject(new Error("db down")) }
            : undefined,
        );
        resetCache();
        expect(await errorOf(as(U.admin, unreadable).runDueCheck())).toBe(
          "FORBIDDEN:NOTIFICATIONS_DISABLED",
        );
        expect(await countOf(U.admin)).toBe(0);
      });

      it("is rate limited per person", async () => {
        for (let i = 0; i < 30; i += 1) await as(U.member).runDueCheck();
        expect(await errorOf(as(U.member).runDueCheck())).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/,
        );
        // Another person has their own budget.
        expect(await errorOf(as(U.jcrc).runDueCheck())).toBe("ok");
      });
    });

    describe("the guard's batch form", () => {
      it("answers the same as the single form, for many CCAs in one go", async () => {
        const { currentDirectorIDs, currentDirectorIDsByCca } = await import(
          "~/server/api/services/directorGuard"
        );
        const ids = [CCA_VACANT, CCA_COVERED, 9_999_999];
        const batch = await currentDirectorIDsByCca(db, ids, NOW);
        expect(batch.get(CCA_VACANT)).toEqual([]);
        expect(batch.get(CCA_COVERED)).toEqual([U.dir]);
        expect(batch.get(9_999_999)).toEqual([]);
        for (const id of ids) {
          expect(await currentDirectorIDs(db, id, NOW)).toEqual(batch.get(id));
        }
      });

      it("is empty while directors.enabled is off, and rejects when a read fails", async () => {
        const { currentDirectorIDsByCca } = await import(
          "~/server/api/services/directorGuard"
        );
        await setFlag("directors.enabled", "off");
        expect(
          (await currentDirectorIDsByCca(db, [CCA_COVERED], NOW)).get(
            CCA_COVERED,
          ),
        ).toEqual([]);
        await setFlag("directors.enabled", "on");
        await expect(
          currentDirectorIDsByCca(withFailingReads("jcrcPositionHolder"), [
            CCA_COVERED,
          ]),
        ).rejects.toThrow("db down");
      });
    });

    describe("the unread count stays a pure read (A50)", () => {
      it("issues one count and no write, even when notices are due", async () => {
        const spying = db.$extends({
          query: {
            $allModels: {
              async $allOperations({ model, operation, args, query }) {
                ops.push(`${model}.${operation}`);
                return query(args);
              },
            },
          },
        }) as unknown as PrismaClient;

        const res = await as(U.admin, spying).unreadCount();

        expect(res.count).toBe(0);
        // The switch is read, then the count. Nothing is written.
        expect(ops).toEqual(["SystemFlag.findUnique", "Notification.count"]);
        expect(ops.filter((o) => !/.(find|count|aggregate)/.test(o))).toEqual(
          [],
        );
        expect(await countOf(U.admin)).toBe(0);
      });
    });
  },
);
