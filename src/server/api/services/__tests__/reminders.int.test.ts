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
 * INTEGRATION TESTS of deadline broadcasts (F22), the collection digest (F19)
 * and the manual disposable nudge, against the LOCAL development database
 * (skipped unless DATABASE_URL is the local dev database; run
 * `npm run test:db`). Run this file on its own. It needs the index script
 * (create-disposable-reminder-indexes.mjs --commit) to have run.
 *
 * The tests own every row they touch: users E99914xx, CCAs 9803, 9804 and
 * 9805 (heads and broadcasts only; the CCA rows are never written), positions
 * named "TEST ...", and every `reminder.*`, `disposable.digest` and
 * `disposable.nudge` notice. The flag rows are put back as they were.
 */

const U = {
  dirAB: "E9991401", // director of 9803 and 9804
  dirA: "E9991402", // director of 9803 only
  dirC: "E9991403", // director of 9805 only
  dirAC: "E9991404", // director of 9803 and 9805
  headA: "E9991405", // heads 9803
  headA2: "E9991406", // heads 9803
  headB: "E9991407", // heads 9804
  headAB: "E9991408", // heads 9803 and 9804
  headC: "E9991409", // heads 9805
  social: "E9991410", // the Social director
  jcrc: "E9991411",
  admin: "E9991412",
  scrc: "E9991413",
  resident: "E9991414",
  newHead: "E9991415", // replaces headA
  social2: "E9991416", // second flagged position when a test adds one
};
const IDS = Object.values(U);
const A = 9803;
const B = 9804;
const C = 9805;
const CCAS = [A, B, C];
const FLAGS = [
  "reminders.enabled",
  "disposables.enabled",
  "directors.enabled",
  "notifications.enabled",
];
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const NOT_FOUND = "NOT_FOUND:REMINDER_NOT_FOUND";
const NOT_DIRECTOR = "FORBIDDEN:NOT_DIRECTOR";
const CHECK_FAILED = "FORBIDDEN:DIRECTOR_CHECK_FAILED";
const DISABLED = "FORBIDDEN:REMINDERS_DISABLED";
const DEADLINE = "2026-11-10";
const SENT_AT = new Date("2026-11-01T04:00:00Z");
// Noon in Singapore on the given day.
const at = (day: string) => new Date(`${day}T04:00:00Z`);

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "broadcasts, digest and nudges (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let runDueCheck: typeof RunDueCheck;
    let nudgeKind: DueKind;
    let digestKind: DueKind;
    let resetCache: () => void;
    let resetRemindersCache: () => void;
    let resetDisposablesCache: () => void;
    let sgtDayKey: (d: Date) => string;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;
    const ops: string[] = [];

    const caller = (
      userID: string,
      roles: string[] = EVERYTHING,
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
      });
    const as = (u: string, roles?: string[], client?: PrismaClient) =>
      caller(u, roles, client).reminder;
    const asDisposable = (u: string, client?: PrismaClient) =>
      caller(u, EVERYTHING, client).disposable;

    const setFlag = async (key: string, value: string | null) => {
      if (value === null) await db.systemFlag.deleteMany({ where: { key } });
      else {
        await db.systemFlag.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
      resetCache();
      // reminders.enabled and disposables.enabled are cached as well.
      resetRemindersCache();
      resetDisposablesCache();
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
      const actions = ["send", "cancel", "markDone"];
      await db.rateLimit.deleteMany({
        where: {
          key: {
            in: [
              ...actions.flatMap((a) => IDS.map((i) => `reminder.${a}:${i}`)),
              ...IDS.map((i) => `disposable.nudge:${i}`),
            ],
          },
        },
      });
      const targets = await db.reminderTarget.findMany({
        where: { ccaID: { in: CCAS } },
        select: { broadcastID: true },
      });
      const ids = [...new Set(targets.map((t) => t.broadcastID))];
      await db.reminderTarget.deleteMany({ where: { ccaID: { in: CCAS } } });
      await db.reminderBroadcast.deleteMany({
        where: {
          OR: [{ id: { in: ids } }, { title: { startsWith: "TEST " } }],
        },
      });
      await db.disposableRequest.deleteMany({
        where: { OR: [{ ccaID: { in: CCAS } }, { createdBy: { in: IDS } }] },
      });
      await db.ccaHead.deleteMany({ where: { userID: { in: IDS } } });
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
      await db.notification.deleteMany({
        where: {
          OR: [
            { userID: { in: IDS } },
            { kind: { startsWith: "reminder." } },
            { kind: { in: ["disposable.digest", "disposable.nudge"] } },
          ],
        },
      });
      await db.user.deleteMany({ where: { email: { startsWith: "e99914" } } });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
      });

    const makePosition = async (
      name: string,
      holder: string,
      opts: { vets?: boolean; social?: boolean; ccaIDs?: number[] } = {},
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          vetsProposals: opts.vets ?? false,
          handlesDisposables: opts.social ?? false,
        },
      });
      for (const ccaID of opts.ccaIDs ?? []) {
        await db.jcrcPositionCca.create({
          data: { positionID: p.id, ccaID, addedBy: "test" },
        });
      }
      await db.jcrcPositionHolder.create({
        data: {
          positionID: p.id,
          userID: holder,
          assignedBy: U.admin,
          endsAt: null,
        },
      });
      return p.id;
    };

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

    const failingTable = () => {
      const boom = () => Promise.reject(new Error("db down"));
      return {
        findFirst: boom,
        findMany: boom,
        findUnique: boom,
        count: boom,
      };
    };
    const withFailingRead = (table: string): PrismaClient =>
      proxied(db, (prop) => (prop === table ? failingTable() : undefined));

    /** A database whose notices cannot be written. */
    const withFailingNotices = (): PrismaClient =>
      proxied(db, (prop) =>
        prop === "$transaction"
          ? (fn: (tx: unknown) => Promise<unknown>, opts?: never) =>
              db.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, p) {
                        return p === "notification"
                          ? {
                              createMany: () =>
                                Promise.reject(new Error("boom")),
                            }
                          : (Reflect.get(t, p) as unknown);
                      },
                    }),
                  ),
                opts,
              )
          : undefined,
      );

    const send = (
      userID: string,
      ccaIDs: number[],
      over: Record<string, unknown> = {},
    ) =>
      as(userID).send({
        ccaIDs,
        title: "TEST Submit your budget",
        message: "Please send it in.",
        deadline: "2099-01-01",
        ...over,
      } as never);

    const counts = async () => ({
      broadcasts: await db.reminderBroadcast.count({
        where: { title: { startsWith: "TEST " } },
      }),
      targets: await db.reminderTarget.count({
        where: { ccaID: { in: CCAS } },
      }),
      notices: await db.notification.count({
        where: { kind: { startsWith: "reminder." } },
      }),
    });

    /** A broadcast seeded straight into the tables, with a chosen send time. */
    const seed = async (
      ccaIDs: number[],
      over: {
        deadline?: string;
        createdAt?: Date;
        status?: string;
        title?: string;
        createdBy?: string | null;
      } = {},
    ) => {
      const b = await db.reminderBroadcast.create({
        data: {
          createdBy: over.createdBy === undefined ? U.dirAB : over.createdBy,
          title: over.title ?? "TEST Seeded",
          message: "",
          deadline: over.deadline ?? DEADLINE,
          status: over.status ?? "active",
          cancelledAt: null,
          cancelledBy: null,
          createdAt: over.createdAt ?? SENT_AT,
        },
      });
      await db.reminderTarget.createMany({
        data: ccaIDs.map((ccaID) => ({
          broadcastID: b.id,
          ccaID,
          doneAt: null,
          doneBy: null,
        })),
      });
      return b.id;
    };

    const noticesFor = (userID: string, kind: string) =>
      db.notification.findMany({ where: { userID, kind } });
    const nudge = (userID: string, day: string) =>
      runDueCheck(db, userID, { kinds: [nudgeKind], now: at(day) });
    const digest = (userID: string, now: Date) =>
      runDueCheck(db, userID, { kinds: [digestKind], now });

    const today = () => sgtDayKey(new Date());
    const approvedRow = (
      over: Partial<{
        collectionDay: string;
        status: string;
        plates: number;
        collectionTime: string;
        title: string;
      }> = {},
    ) =>
      db.disposableRequest.create({
        data: {
          ccaID: A,
          createdBy: U.headA,
          title: "Hall dinner",
          description: "x",
          proposalID: null,
          plates: 10,
          cups: 0,
          bowls: 0,
          forks: 0,
          spoons: 0,
          collectionDay: today(),
          collectionTime: "18:30",
          status: "approved",
          ...over,
        },
      });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      ({ broadcastNudgeKind: nudgeKind } = await import(
        "~/server/api/services/dueCheck/broadcastNudge"
      ));
      ({ collectionDigestKind: digestKind } = await import(
        "~/server/api/services/dueCheck/collectionDigest"
      ));
      ({ resetNotificationsFlagCache: resetCache } = await import(
        "~/server/api/services/notifications"
      ));
      ({ resetRemindersFlagCache: resetRemindersCache } = await import(
        "~/server/api/services/reminders/flag"
      ));
      ({ resetDisposablesFlagCache: resetDisposablesCache } = await import(
        "~/server/api/services/disposables/flag"
      ));
      ({ sgtDayKey } = await import("~/lib/time/sgt"));
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      ops.length = 0;
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [
        U.dirAB,
        U.dirA,
        U.dirC,
        U.dirAC,
        U.social,
        U.social2,
        U.jcrc,
      ]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      for (const id of [
        U.headA,
        U.headA2,
        U.headB,
        U.headAB,
        U.headC,
        U.newHead,
      ]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.scrc, ["resident", "scrc"]);
      await setRoles(U.resident, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, A],
        [U.headA2, A],
        [U.headB, B],
        [U.headAB, A],
        [U.headAB, B],
        [U.headC, C],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Dir AB", U.dirAB, { vets: true, ccaIDs: [A, B] });
      await makePosition("Dir A", U.dirA, { vets: true, ccaIDs: [A] });
      await makePosition("Dir C", U.dirC, { vets: true, ccaIDs: [C] });
      await makePosition("Dir AC", U.dirAC, { vets: true, ccaIDs: [A, C] });
      await makePosition("Social", U.social, { social: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("the flag", () => {
      it("is off when absent, odd or unreadable, and every gated procedure refuses", async () => {
        const id = await seed([A]);
        for (const value of [null, "off", "ON", ""]) {
          await setFlag("reminders.enabled", value);
          expect((await as(U.dirAB).enabled()).enabled).toBe(false);
          expect(await errorOf(as(U.dirAB).send({} as never))).toMatch(
            /BAD_REQUEST|FORBIDDEN/,
          );
          expect(await errorOf(send(U.dirAB, [A]))).toBe(DISABLED);
          expect(await errorOf(as(U.dirAB).outbox())).toBe(DISABLED);
          expect(await errorOf(as(U.dirAB).ccaChoices())).toBe(DISABLED);
          expect(await errorOf(as(U.dirAB).get({ id }))).toBe(DISABLED);
          expect(await errorOf(as(U.dirAB).cancel({ id }))).toBe(DISABLED);
          expect(await errorOf(as(U.headA).mine())).toBe(DISABLED);
          expect(
            await errorOf(as(U.headA).markDone({ broadcastID: id, ccaID: A })),
          ).toBe(DISABLED);
          expect(await as(U.headA).entry()).toMatchObject({
            director: false,
            head: false,
            open: 0,
          });
        }
        expect((await counts()).notices).toBe(0);
      });

      it("a failed flag read counts as off", async () => {
        const down = proxied(db, (prop) =>
          prop === "systemFlag"
            ? { findUnique: () => Promise.reject(new Error("db down")) }
            : undefined,
        );
        expect((await as(U.dirAB, EVERYTHING, down).enabled()).enabled).toBe(
          false,
        );
        expect(
          await errorOf(
            as(U.dirAB, EVERYTHING, down).send({
              ccaIDs: [A],
              title: "TEST x",
              message: "",
              deadline: "2099-01-01",
            } as never),
          ),
        ).toBe(DISABLED);
      });
    });

    describe("sending", () => {
      it("a director of every chosen CCA sends; only current heads are told, one row each", async () => {
        const res = await send(U.dirAB, [A, B]);
        expect(res).toMatchObject({ targets: 2 });
        // headA, headA2, headB, and headAB (head of both, told once).
        expect(res.notified).toBe(4);
        for (const id of [U.headA, U.headA2, U.headB, U.headAB]) {
          expect(await noticesFor(id, "reminder.broadcast")).toHaveLength(1);
        }
        for (const id of [U.headC, U.dirAB, U.social, U.resident, U.admin]) {
          expect(await noticesFor(id, "reminder.broadcast")).toHaveLength(0);
        }
        const row = await db.reminderBroadcast.findUniqueOrThrow({
          where: { id: res.id },
        });
        expect(row).toMatchObject({ createdBy: U.dirAB, status: "active" });
        expect(Object.keys(row)).not.toContain("academicYear");
      });

      it("a director sends to a CCA they direct alone, and a mixed list is refused with nothing written", async () => {
        expect((await send(U.dirA, [A])).targets).toBe(1);
        const before = await counts();
        expect(await errorOf(send(U.dirA, [A, B]))).toBe(NOT_DIRECTOR);
        expect(await errorOf(send(U.dirAB, [A, C]))).toBe(NOT_DIRECTOR);
        expect(await errorOf(send(U.dirC, [C, A, B]))).toBe(NOT_DIRECTOR);
        expect(await counts()).toEqual(before);
      });

      it.each([
        ["admin", U.admin],
        ["jcrc with no position", U.jcrc],
        ["Social director", U.social],
        ["scrc", U.scrc],
        ["resident", U.resident],
        ["a head", U.headA],
      ])("%s is refused even with every role claimed", async (_n, who) => {
        expect(await errorOf(send(who, [A]))).toBe(NOT_DIRECTOR);
        expect(await counts()).toEqual({
          broadcasts: 0,
          targets: 0,
          notices: 0,
        });
      });

      it("a director of another CCA is refused, and so is any send while directors.enabled is off", async () => {
        expect(await errorOf(send(U.dirC, [A]))).toBe(NOT_DIRECTOR);
        await setFlag("directors.enabled", "off");
        expect(await errorOf(send(U.dirAB, [A]))).toBe(NOT_DIRECTOR);
        expect((await counts()).broadcasts).toBe(0);
      });

      it("a failed guard read refuses the whole send", async () => {
        const res = await errorOf(
          as(U.dirAB, EVERYTHING, withFailingRead("jcrcPositionHolder")).send({
            ccaIDs: [A],
            title: "TEST x",
            message: "",
            deadline: "2099-01-01",
          } as never),
        );
        expect(res).toBe(CHECK_FAILED);
        expect(await counts()).toEqual({
          broadcasts: 0,
          targets: 0,
          notices: 0,
        });
      });

      it("refuses a past deadline, too many CCAs, bad input and a forged sender", async () => {
        expect(
          await errorOf(send(U.dirAB, [A], { deadline: "2020-01-01" })),
        ).toBe("BAD_REQUEST:REMINDER_DEADLINE_PAST");
        expect(
          await errorOf(send(U.dirAB, [A], { deadline: "2099-02-31" })),
        ).toMatch(/^BAD_REQUEST/);
        expect(
          await errorOf(
            send(
              U.dirAB,
              Array.from({ length: 51 }, (_, i) => 10_000 + i),
            ),
          ),
        ).toMatch(/^BAD_REQUEST/);
        expect(await errorOf(send(U.dirAB, [], {}))).toMatch(/^BAD_REQUEST/);
        const forged = await send(U.dirAB, [A], { createdBy: U.admin });
        expect(
          (
            await db.reminderBroadcast.findUniqueOrThrow({
              where: { id: forged.id },
            })
          ).createdBy,
        ).toBe(U.dirAB);
      });

      it("duplicated CCA ids make one target", async () => {
        const res = await send(U.dirAB, [A, A, B]);
        expect(res.targets).toBe(2);
        expect(
          await db.reminderTarget.count({ where: { broadcastID: res.id } }),
        ).toBe(2);
      });

      it("with notifications off the broadcast still exists and nobody is told", async () => {
        await setFlag("notifications.enabled", "off");
        const res = await send(U.dirAB, [A]);
        expect(res.notified).toBe(0);
        expect((await counts()).broadcasts).toBe(1);
        expect((await counts()).notices).toBe(0);
      });

      it("the broadcast, targets and notices commit together or not at all (A45)", async () => {
        const res = await errorOf(
          as(U.dirAB, EVERYTHING, withFailingNotices()).send({
            ccaIDs: [A, B],
            title: "TEST x",
            message: "",
            deadline: "2099-01-01",
          } as never),
        );
        expect(res).not.toBe("ok");
        expect(await counts()).toEqual({
          broadcasts: 0,
          targets: 0,
          notices: 0,
        });
      });

      it("the 11th send in an hour is rate limited", async () => {
        for (let i = 0; i < 10; i += 1) await send(U.dirA, [A]);
        expect(await errorOf(send(U.dirA, [A]))).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/,
        );
      });

      it("a refused person does not spend the send budget", async () => {
        for (let i = 0; i < 12; i += 1) await errorOf(send(U.admin, [A]));
        expect(
          await db.rateLimit.count({
            where: { key: `reminder.send:${U.admin}` },
          }),
        ).toBe(0);
      });
    });

    describe("reading", () => {
      it("a director sees only the CCAs they direct", async () => {
        const id = await seed([A, C], { createdBy: U.dirAC });
        const detail = await as(U.dirA).get({ id });
        expect(detail.progress.map((p) => p.ccaID)).toEqual([A]);
        expect(detail.canCancel).toBe(false);
        const full = await as(U.dirAC).get({ id });
        expect(full.progress.map((p) => p.ccaID)).toEqual([A, C]);
        expect(full.canCancel).toBe(true);
        const box = await as(U.dirA).outbox();
        expect(box.items).toEqual([
          expect.objectContaining({ id, total: 1, done: 0 }),
        ]);
        expect((await as(U.dirC).outbox()).items[0]).toMatchObject({
          total: 1,
        });
      });

      it("get answers a stranger the same for a real id and a missing one", async () => {
        const id = await seed([A]);
        const missing = "0".repeat(24);
        for (const who of [U.dirC, U.admin, U.headA, U.resident]) {
          const a = await errorOf(as(who).get({ id }));
          const b = await errorOf(as(who).get({ id: missing }));
          expect(a).toBe(b);
          expect(a).not.toBe("ok");
        }
        expect(await errorOf(as(U.dirAB).get({ id: missing }))).toBe(NOT_FOUND);
      });

      it("ccaChoices lists only the CCAs a director directs", async () => {
        expect(
          (await as(U.dirAB).ccaChoices()).map((c) => c.ccaID).sort(),
        ).toEqual([A, B]);
        expect(await errorOf(as(U.headA).ccaChoices())).toBe(NOT_DIRECTOR);
      });

      it("a bad row is skipped and counted (A2)", async () => {
        const good = await seed([A], { title: "TEST good" });
        await seed([A], { title: "TEST bad", deadline: "not-a-day" });
        const box = await as(U.dirAB).outbox();
        expect(box.items.map((i) => i.id)).toEqual([good]);
        expect(box.skipped).toBe(1);
        const mine = await as(U.headA).mine();
        expect(mine.items.map((i) => i.broadcastID)).toEqual([good]);
      });

      it("entry shows the director, the head and the open count", async () => {
        await seed([A]);
        expect(await as(U.dirAB).entry()).toMatchObject({
          director: true,
          head: false,
        });
        expect(await as(U.headA).entry()).toMatchObject({
          head: true,
          open: 1,
        });
        expect(await as(U.headC).entry()).toMatchObject({
          head: true,
          open: 0,
        });
        expect(await as(U.resident).entry()).toMatchObject({
          director: false,
          head: false,
          open: 0,
        });
        expect((await as(U.social).entry()).social).toBe(true);
      });
    });

    describe("marking done", () => {
      it("a head marks their own CCA done; the second mark is harmless", async () => {
        const id = await seed([A, B]);
        const first = await as(U.headA).markDone({ broadcastID: id, ccaID: A });
        expect(first).toEqual({ alreadyDone: false });
        const second = await as(U.headA2).markDone({
          broadcastID: id,
          ccaID: A,
        });
        expect(second).toEqual({ alreadyDone: true });
        const rows = await db.reminderTarget.findMany({
          where: { broadcastID: id },
        });
        expect(rows.find((r) => r.ccaID === A)).toMatchObject({
          doneBy: U.headA,
        });
        expect(rows.find((r) => r.ccaID === B)?.doneAt).toBeNull();
      });

      it("a head of another CCA, a missing broadcast and a non-target CCA all get one answer, and nothing changes", async () => {
        const id = await seed([A]);
        const missing = "0".repeat(24);
        const answers = [
          await errorOf(as(U.headB).markDone({ broadcastID: id, ccaID: A })),
          await errorOf(
            as(U.headB).markDone({ broadcastID: missing, ccaID: A }),
          ),
          await errorOf(
            as(U.headA).markDone({ broadcastID: missing, ccaID: A }),
          ),
          await errorOf(as(U.headAB).markDone({ broadcastID: id, ccaID: B })),
          await errorOf(as(U.headA).markDone({ broadcastID: id, ccaID: B })),
          await errorOf(as(U.dirAB).markDone({ broadcastID: id, ccaID: A })),
          await errorOf(as(U.admin).markDone({ broadcastID: id, ccaID: A })),
        ];
        for (const a of answers) expect(a).toBe(NOT_FOUND);
        expect(
          (
            await db.reminderTarget.findFirstOrThrow({
              where: { broadcastID: id },
            })
          ).doneAt,
        ).toBeNull();
      });

      it("a failed head read refuses the same way", async () => {
        const id = await seed([A]);
        const down = withFailingRead("ccaHead");
        expect(
          await errorOf(
            as(U.headA, EVERYTHING, down).markDone({
              broadcastID: id,
              ccaID: A,
            }),
          ),
        ).toBe(
          await errorOf(
            as(U.headA, EVERYTHING, down).markDone({
              broadcastID: "0".repeat(24),
              ccaID: A,
            }),
          ),
        );
        expect(
          (
            await db.reminderTarget.findFirstOrThrow({
              where: { broadcastID: id },
            })
          ).doneAt,
        ).toBeNull();
      });

      it("a cancelled broadcast cannot be marked done and leaves the head's list", async () => {
        const id = await seed([A]);
        await as(U.dirAB).cancel({ id });
        expect(
          await errorOf(as(U.headA).markDone({ broadcastID: id, ccaID: A })),
        ).toBe("CONFLICT:REMINDER_CANCELLED");
        expect((await as(U.headA).mine()).items).toEqual([]);
      });

      it("is rate limited", async () => {
        const id = await seed([A]);
        for (let i = 0; i < 120; i += 1) {
          await as(U.headA).markDone({ broadcastID: id, ccaID: A });
        }
        expect(
          await errorOf(as(U.headA).markDone({ broadcastID: id, ccaID: A })),
        ).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
      });
    });

    describe("cancelling", () => {
      it("a director of every target CCA cancels; twice is harmless", async () => {
        const id = await seed([A, B]);
        expect(await as(U.dirAB).cancel({ id })).toEqual({
          status: "cancelled",
          changed: true,
        });
        expect(await as(U.dirAB).cancel({ id })).toEqual({
          status: "cancelled",
          changed: false,
        });
        expect(
          await db.reminderBroadcast.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          status: "cancelled",
          cancelledBy: U.dirAB,
        });
      });

      it("a director of only some targets, the admin and a stranger get the missing-row answer", async () => {
        const id = await seed([A, C], { createdBy: U.dirA });
        const missing = "0".repeat(24);
        for (const who of [U.dirA, U.dirC, U.admin, U.headA, U.social]) {
          expect(await errorOf(as(who).cancel({ id }))).toBe(NOT_FOUND);
          expect(await errorOf(as(who).cancel({ id: missing }))).toBe(
            NOT_FOUND,
          );
        }
        expect(
          (await db.reminderBroadcast.findUniqueOrThrow({ where: { id } }))
            .status,
        ).toBe("active");
        expect((await as(U.dirAC).cancel({ id })).changed).toBe(true);
      });

      it("the sender who lost the position can no longer cancel", async () => {
        const id = await seed([A], { createdBy: U.dirA });
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dirA },
          data: { endsAt: new Date("2020-01-01T00:00:00Z") },
        });
        expect(await errorOf(as(U.dirA).cancel({ id }))).toBe(NOT_FOUND);
        expect(
          (await db.reminderBroadcast.findUniqueOrThrow({ where: { id } }))
            .status,
        ).toBe("active");
      });

      it("a failed guard read refuses", async () => {
        const id = await seed([A]);
        expect(
          await errorOf(
            as(
              U.dirAB,
              EVERYTHING,
              withFailingRead("jcrcPositionHolder"),
            ).cancel({ id }),
          ),
        ).toBe(CHECK_FAILED);
        expect(
          (await db.reminderBroadcast.findUniqueOrThrow({ where: { id } }))
            .status,
        ).toBe("active");
      });
    });

    describe("automatic nudges", () => {
      it("sends 3 days and 1 day before, once each, and nothing outside the window", async () => {
        const id = await seed([A]);
        expect((await nudge(U.headA, "2026-11-06")).written).toBe(0);
        expect((await nudge(U.headA, "2026-11-07")).written).toBe(1);
        expect((await nudge(U.headA, "2026-11-07")).written).toBe(0);
        expect((await nudge(U.headA, "2026-11-08")).written).toBe(0);
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(1);
        expect((await nudge(U.headA, "2026-11-10")).written).toBe(0);
        expect((await nudge(U.headA, "2026-11-11")).written).toBe(0);
        const keys = (await noticesFor(U.headA, "reminder.nudge")).map(
          (n) => n.noticeKey,
        );
        expect(keys.sort()).toEqual([
          `nudge.broadcast:${id}:${A}:d1|${U.headA}`,
          `nudge.broadcast:${id}:${A}:d3|${U.headA}`,
        ]);
      });

      it("a head back after a long absence gets only the most urgent stage; two broadcasts give two", async () => {
        await seed([A], { title: "TEST one" });
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(1);
        await seed([A], { title: "TEST two" });
        expect((await nudge(U.headA2, "2026-11-09")).written).toBe(2);
        const rows = await noticesFor(U.headA2, "reminder.nudge");
        expect(rows.every((r) => r.noticeKey?.includes(":d1|"))).toBe(true);
      });

      it("is due on the deadline day itself", async () => {
        await seed([A], { createdAt: new Date("2026-11-08T04:00:00Z") });
        expect((await nudge(U.headA, "2026-11-10")).written).toBe(1);
      });

      it("skips a stage that starts on or before the day it was sent", async () => {
        await seed([A], { createdAt: new Date("2026-11-08T04:00:00Z") });
        expect((await nudge(U.headA, "2026-11-08")).written).toBe(0);
        await seed([A], {
          title: "TEST late",
          createdAt: new Date("2026-11-09T04:00:00Z"),
        });
        expect((await nudge(U.headB, "2026-11-09")).written).toBe(0);
        expect((await nudge(U.headA2, "2026-11-09")).written).toBe(1);
      });

      it("marking done stops the nudges, including after the first was sent", async () => {
        const id = await seed([A]);
        await nudge(U.headA, "2026-11-07");
        await as(U.headA2).markDone({ broadcastID: id, ccaID: A });
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(0);
        expect((await nudge(U.headA2, "2026-11-09")).written).toBe(0);
        expect(await noticesFor(U.headA, "reminder.nudge")).toHaveLength(1);
      });

      it("another CCA's head, a director and a resident get nothing", async () => {
        await seed([A]);
        for (const who of [U.headB, U.headC, U.dirAB, U.resident, U.admin]) {
          expect((await nudge(who, "2026-11-09")).written).toBe(0);
        }
      });

      it("a person with a nothing-due broadcast for another CCA gets nothing", async () => {
        await seed([C]);
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(0);
        expect((await nudge(U.headC, "2026-11-09")).written).toBe(1);
      });

      it("goes to the head as they are when it runs, not as they were when sent (A30)", async () => {
        await seed([A]);
        await db.ccaHead.deleteMany({ where: { userID: U.headA } });
        await db.ccaHead.create({ data: { userID: U.newHead, ccaID: A } });
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(0);
        expect((await nudge(U.newHead, "2026-11-09")).written).toBe(1);
      });

      it("a cancelled broadcast is not nudged", async () => {
        await seed([A], { status: "cancelled" });
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(0);
      });

      it("writes nothing while reminders are off, and reports an unreadable flag", async () => {
        await seed([A]);
        await setFlag("reminders.enabled", "off");
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(0);
        await setFlag("reminders.enabled", "on");
        const down = proxied(db, (prop) =>
          prop === "systemFlag"
            ? { findUnique: () => Promise.reject(new Error("db down")) }
            : undefined,
        );
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const res = await runDueCheck(down, U.headA, {
          kinds: [nudgeKind],
          now: at("2026-11-09"),
        });
        expect(res).toMatchObject({
          written: 0,
          failedKinds: ["broadcast_nudge"],
        });
        expect(await noticesFor(U.headA, "reminder.nudge")).toHaveLength(0);
      });

      it("writes nothing while notifications are off", async () => {
        await seed([A]);
        await setFlag("notifications.enabled", "off");
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(0);
        expect(await noticesFor(U.headA, "reminder.nudge")).toHaveLength(0);
      });

      it("a malformed row is skipped and counted, and the good one still goes", async () => {
        const spy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await seed([A], { title: "TEST bad", deadline: "tomorrow" });
        await seed([A], { title: "TEST good" });
        expect((await nudge(U.headA, "2026-11-09")).written).toBe(1);
        expect(
          spy.mock.calls.some((c) =>
            String(c[0]).includes("reminder_nudge_rows_skipped"),
          ),
        ).toBe(true);
      });

      it("two tabs running at once write once (A51)", async () => {
        await seed([A]);
        const runs = await Promise.all(
          Array.from({ length: 4 }, () => nudge(U.headA, "2026-11-09")),
        );
        expect(runs.reduce((n, r) => n + r.written, 0)).toBe(1);
        expect(await noticesFor(U.headA, "reminder.nudge")).toHaveLength(1);
      });

      it("a head of two addressed CCAs gets two nudges that name their CCA", async () => {
        await seed([A, B]);
        expect((await nudge(U.headAB, "2026-11-09")).written).toBe(2);
        const bodies = (await noticesFor(U.headAB, "reminder.nudge"))
          .map((n) => n.body ?? "")
          .sort();
        expect(bodies[0]).toContain(`CCA ${A}`);
        expect(bodies[1]).toContain(`CCA ${B}`);
        expect(bodies[0]).not.toBe(bodies[1]);
      });

      it("never reads the targets of cancelled or expired broadcasts, and nudges nothing for them", async () => {
        const live = await seed([A], { title: "TEST live" });
        const cancelled = await seed([A], {
          title: "TEST cancelled",
          status: "cancelled",
        });
        const expired = await seed([A], {
          title: "TEST expired",
          deadline: "2026-11-05",
          createdAt: new Date("2026-10-20T04:00:00Z"),
        });
        const asked: string[] = [];
        const spying = proxied(db, (prop) =>
          prop === "reminderTarget"
            ? {
                findMany: (args: {
                  where: { broadcastID: { in: string[] } };
                }) => {
                  asked.push(...args.where.broadcastID.in);
                  return db.reminderTarget.findMany(args as never);
                },
              }
            : undefined,
        );
        const res = await runDueCheck(spying, U.headA, {
          kinds: [nudgeKind],
          now: at("2026-11-09"),
        });
        expect(res.written).toBe(1);
        expect(asked).toEqual([live]);
        expect(asked).not.toContain(cancelled);
        expect(asked).not.toContain(expired);
      });

      it("the default kinds include the nudge and the digest", async () => {
        await seed([A]);
        const res = await runDueCheck(db, U.headA, { now: at("2026-11-09") });
        expect(res.written).toBeGreaterThanOrEqual(1);
        expect(await noticesFor(U.headA, "reminder.nudge")).toHaveLength(1);
        await approvedRow();
        await runDueCheck(db, U.social);
        expect(await noticesFor(U.social, "disposable.digest")).toHaveLength(1);
      });
    });

    describe("the collection digest", () => {
      it("the Social director sees today's approved collections", async () => {
        await approvedRow({ collectionTime: "19:00", title: "Late" });
        await approvedRow({ collectionTime: "18:00", title: "Early" });
        await approvedRow({ status: "pending" });
        await approvedRow({ status: "rejected" });
        await approvedRow({ collectionDay: "2099-01-01" });
        const res = await asDisposable(U.social).digest();
        expect(res.day).toBe(today());
        expect(res.items.map((i) => i.title)).toEqual(["Early", "Late"]);
        expect(res.skipped).toBe(0);
      });

      it.each([
        ["a head", U.headA],
        ["a director", U.dirAB],
        ["an admin", U.admin],
        ["a jcrc member", U.jcrc],
        ["a resident", U.resident],
      ])("%s is refused", async (_n, who) => {
        await approvedRow();
        expect(await errorOf(asDisposable(who).digest())).toBe(
          "FORBIDDEN:NOT_SOCIAL_DIRECTOR",
        );
      });

      it("nobody sees it with no position, two positions or an expired holder", async () => {
        await approvedRow();
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.social },
          data: { endsAt: new Date("2020-01-01T00:00:00Z") },
        });
        expect(await errorOf(asDisposable(U.social).digest())).toBe(
          "FORBIDDEN:NOT_SOCIAL_DIRECTOR",
        );
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.social },
          data: { endsAt: null },
        });
        await makePosition("Social 2", U.social2, { social: true });
        for (const who of [U.social, U.social2]) {
          expect(await errorOf(asDisposable(who).digest())).toBe(
            "FORBIDDEN:NOT_SOCIAL_DIRECTOR",
          );
        }
        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social" },
          data: { handlesDisposables: false },
        });
        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social 2" },
          data: { handlesDisposables: false },
        });
        expect(await errorOf(asDisposable(U.social).digest())).toBe(
          "FORBIDDEN:NOT_SOCIAL_DIRECTOR",
        );
      });

      it("a bad row is skipped and counted (A2)", async () => {
        await approvedRow({ title: "Good" });
        await approvedRow({ plates: 999_999, title: "Bad" });
        const res = await asDisposable(U.social).digest();
        expect(res.items.map((i) => i.title)).toEqual(["Good"]);
        expect(res.skipped).toBe(1);
      });

      it("the due kind writes one notice per day, none on an empty day", async () => {
        const now = at("2026-11-02");
        expect((await digest(U.social, now)).written).toBe(0);
        await approvedRow({ collectionDay: "2026-11-02" });
        await approvedRow({
          collectionDay: "2026-11-02",
          collectionTime: "20:00",
        });
        expect((await digest(U.social, now)).written).toBe(1);
        expect((await digest(U.social, now)).written).toBe(0);
        const rows = await noticesFor(U.social, "disposable.digest");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.title).toBe("2 disposables collections today");
        expect(rows[0]?.noticeKey).toBe(
          `due.collection_digest:2026-11-02|${U.social}`,
        );
        expect((await digest(U.social, at("2026-11-03"))).written).toBe(0);
      });

      it("logs only a count when a bad row is skipped (A2)", async () => {
        const spy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await approvedRow({ collectionDay: "2026-11-02", title: "Good" });
        await approvedRow({
          collectionDay: "2026-11-02",
          plates: 999_999,
          title: "SecretBadTitle",
        });
        expect((await digest(U.social, at("2026-11-02"))).written).toBe(1);
        const logged = spy.mock.calls.map((c) => String(c[0]));
        expect(logged).toContain(
          JSON.stringify({ evt: "collection_digest_rows_skipped", skipped: 1 }),
        );
        expect(logged.join(" ")).not.toContain("SecretBadTitle");
      });

      it("the due kind writes nothing for anyone else", async () => {
        await approvedRow({ collectionDay: "2026-11-02" });
        for (const who of [U.headA, U.dirAB, U.admin, U.jcrc]) {
          expect((await digest(who, at("2026-11-02"))).written).toBe(0);
        }
      });

      it("the due kind writes nothing with no, two or an expired holder", async () => {
        await approvedRow({ collectionDay: "2026-11-02" });
        await makePosition("Social 2", U.social2, { social: true });
        expect((await digest(U.social, at("2026-11-02"))).written).toBe(0);
        expect((await digest(U.social2, at("2026-11-02"))).written).toBe(0);
      });

      it("the due kind needs disposables on and notifications on, and reports an unreadable flag", async () => {
        await approvedRow({ collectionDay: "2026-11-02" });
        await setFlag("disposables.enabled", "off");
        expect((await digest(U.social, at("2026-11-02"))).written).toBe(0);
        await setFlag("disposables.enabled", "on");
        await setFlag("notifications.enabled", "off");
        expect((await digest(U.social, at("2026-11-02"))).written).toBe(0);
        await setFlag("notifications.enabled", "on");
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const down = proxied(db, (prop) =>
          prop === "systemFlag"
            ? { findUnique: () => Promise.reject(new Error("db down")) }
            : undefined,
        );
        const res = await runDueCheck(down, U.social, {
          kinds: [digestKind],
          now: at("2026-11-02"),
        });
        expect(res).toMatchObject({
          written: 0,
          failedKinds: ["collection_digest"],
        });
      });

      it("does not depend on the reminders flag", async () => {
        await setFlag("reminders.enabled", "off");
        await approvedRow({ collectionDay: "2026-11-02" });
        expect((await digest(U.social, at("2026-11-02"))).written).toBe(1);
        expect((await asDisposable(U.social).digest()).day).toBe(today());
      });
    });

    describe("the manual disposable nudge", () => {
      const pending = (over: Record<string, unknown> = {}) =>
        approvedRow({ status: "pending", ...over });

      it("a head of the request's CCA nudges the Social director once a day", async () => {
        const row = await pending();
        const first = await asDisposable(U.headA).nudge({ id: row.id });
        expect(first).toMatchObject({ status: "sent", sent: 1 });
        const second = await asDisposable(U.headA2).nudge({ id: row.id });
        expect(second).toMatchObject({ status: "already_sent", sent: 0 });
        const rows = await noticesFor(U.social, "disposable.nudge");
        expect(rows).toHaveLength(1);
        expect(rows[0]?.noticeKey).toBe(
          `request.nudge:${row.id}:${today()}|${U.social}`,
        );
      });

      it("the head's list row carries can.nudge, the Social director's does not, and the button's call works", async () => {
        const row = await pending();
        const headRow = (await asDisposable(U.headA).list({})).items.find(
          (i) => i.id === row.id,
        );
        expect(headRow?.can).toMatchObject({ nudge: true, edit: false });
        const otherHead = (await asDisposable(U.headB).list({})).items.find(
          (i) => i.id === row.id,
        );
        expect(otherHead).toBeUndefined();
        const socialRow = (await asDisposable(U.social).list({})).items.find(
          (i) => i.id === row.id,
        );
        expect(socialRow?.can.nudge).toBe(false);
        expect(await asDisposable(U.headA).nudge({ id: row.id })).toMatchObject(
          {
            status: "sent",
          },
        );
        await asDisposable(U.social).approve({
          id: row.id,
          version: 0,
          note: null,
        });
        const after = (await asDisposable(U.headA).list({})).items.find(
          (i) => i.id === row.id,
        );
        expect(after?.can.nudge).toBe(false);
      });

      it("anyone who does not head the CCA gets the missing-row answer", async () => {
        const row = await pending();
        const missing = "0".repeat(24);
        for (const who of [U.headB, U.social, U.admin, U.jcrc, U.resident]) {
          const a = await errorOf(asDisposable(who).nudge({ id: row.id }));
          const b = await errorOf(asDisposable(who).nudge({ id: missing }));
          expect(a).toBe(b);
          expect(a).toMatch(/^NOT_FOUND/);
        }
      });

      it("only a pending request can be nudged", async () => {
        const row = await approvedRow();
        expect(await errorOf(asDisposable(U.headA).nudge({ id: row.id }))).toBe(
          "CONFLICT:DISPOSABLE_NOT_PENDING",
        );
      });

      it("says so when there is no Social director, and when notifications are off", async () => {
        const row = await pending();
        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social" },
          data: { handlesDisposables: false },
        });
        expect(await asDisposable(U.headA).nudge({ id: row.id })).toMatchObject(
          {
            status: "no_director",
          },
        );
        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social" },
          data: { handlesDisposables: true },
        });
        await setFlag("notifications.enabled", "off");
        expect(await errorOf(asDisposable(U.headA).nudge({ id: row.id }))).toBe(
          "FORBIDDEN:NOTIFICATIONS_DISABLED",
        );
      });

      it("is rate limited", async () => {
        const row = await pending();
        for (let i = 0; i < 30; i += 1) {
          await asDisposable(U.headA).nudge({ id: row.id });
        }
        expect(
          await errorOf(asDisposable(U.headA).nudge({ id: row.id })),
        ).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
      });
    });

    describe("the unread count stays a pure read (A50)", () => {
      it("issues one flag read and one count and no write, with broadcasts due", async () => {
        await seed([A], { createdAt: new Date("2026-11-01T04:00:00Z") });
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
        const res = await caller(
          U.headA,
          EVERYTHING,
          spying,
        ).notifications.unreadCount();
        expect(res.count).toBe(0);
        expect(ops).toEqual(["SystemFlag.findUnique", "Notification.count"]);
      });
    });

    describe("account deletion", () => {
      it("keeps the broadcast and targets and clears the references", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "../userAdmin"
        );
        const sender = await db.user.create({
          data: { email: "e9991401@u.nus.edu", userID: U.dirAB },
        });
        const head = await db.user.create({
          data: { email: "e9991405@u.nus.edu", userID: U.headA },
        });
        const res = await send(U.dirAB, [A, B]);
        await as(U.headA).markDone({ broadcastID: res.id, ccaID: A });
        await as(U.dirAB).cancel({ id: res.id });

        const first = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, sender.id),
          U.admin,
        );
        expect(first.deleted).toMatchObject({
          reminderSenderCleared: 1,
          reminderCancellerCleared: 1,
        });
        const second = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, head.id),
          U.admin,
        );
        expect(second.deleted).toMatchObject({ reminderDoneByCleared: 1 });

        expect(
          await db.reminderBroadcast.findUniqueOrThrow({
            where: { id: res.id },
          }),
        ).toMatchObject({
          createdBy: null,
          cancelledBy: null,
          status: "cancelled",
        });
        const targets = await db.reminderTarget.findMany({
          where: { broadcastID: res.id },
        });
        expect(targets).toHaveLength(2);
        expect(targets.find((t) => t.ccaID === A)).toMatchObject({
          doneBy: null,
        });
        expect(targets.find((t) => t.ccaID === A)?.doneAt).not.toBeNull();
      });
    });
  },
);
