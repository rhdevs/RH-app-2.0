import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type { notify as Notify } from "~/server/api/services/notifications";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { isLocalDevDatabase } from "../transcript/__tests__/localDbGate";
import { resetEventsFlagCache } from "../events";
import { resetEventReviewFlagCache } from "../eventPublish";
import { resetNotificationsFlagCache } from "../notifications";

/**
 * INTEGRATION TESTS of the inbox notices the Event router sends after it
 * changes a published event, against the LOCAL development database (skipped
 * unless DATABASE_URL is the local dev database; run `npm run test:db`).
 *
 * The tests own every row they touch: users E99930xx, events 99930xx, and the
 * three flags (whose previous values are restored afterwards). The seed's CCA
 * 9001 is read, never written.
 */

// `notify` is wrapped so a test can make it throw; otherwise it is the real one.
const forced = vi.hoisted(() => ({ fail: false }));
vi.mock("~/server/api/services/notifications", async (importOriginal) => {
  const actual = await importOriginal<{ notify: typeof Notify }>();
  return {
    ...actual,
    notify: (...args: Parameters<typeof actual.notify>) => {
      if (forced.fail) throw new Error("forced notify failure");
      return actual.notify(...args);
    },
  };
});

const USERS = {
  head: "E9993001",
  jcrc: "E9993002",
  resident: "E9993003",
  second: "E9993004",
  bystander: "E9993005",
};
const ALL_IDS = Object.values(USERS);
const CCA = 9001;
const FLAGS = [
  "events.enabled",
  "events.review.required",
  "notifications.enabled",
];
const T = 2_000_000_000;
const HOUR = 3600;
const TRICKY_TITLE = 'Quiz <night> & "friends"';
let nextEventID = 9993001;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "Event change notices (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let ipCounter = 0;
    let savedFlags: { key: string; value: string }[] = [];
    const ops: string[] = [];
    const race: { beforeCancelWrite: (() => Promise<void>) | null } = {
      beforeCancelWrite: null,
    };

    const as = (userID: string, roles: string[]) =>
      createCaller({
        // Every Prisma operation goes through here, so a test can list them.
        db: db.$extends({
          query: {
            $allModels: {
              async $allOperations({ model, operation, args, query }) {
                ops.push(`${model}.${operation}`);
                const hook = race.beforeCancelWrite;
                if (
                  hook &&
                  model === "Event" &&
                  operation === "updateMany" &&
                  (args as { data?: { status?: string } }).data?.status ===
                    "canceled"
                ) {
                  race.beforeCancelWrite = null;
                  await hook();
                }
                return query(args);
              },
            },
          },
        }) as never,
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
          "x-forwarded-for": `203.0.113.${(ipCounter += 1) % 250}`,
        }),
      }).event;

    const HEAD = ["resident"];
    const JCRC = ["resident", "jcrc"];

    const eventIDs = () =>
      Array.from({ length: nextEventID - 9993001 }, (_, i) => 9993001 + i);

    const clean = async () => {
      const ids = eventIDs();
      await db.eventSignup.deleteMany({
        where: { OR: [{ eventID: { in: ids } }, { userID: { in: ALL_IDS } }] },
      });
      await db.event.deleteMany({
        where: {
          OR: [{ eventID: { in: ids } }, { createdBy: { in: ALL_IDS } }],
        },
      });
      await db.notification.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.ccaHead.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.userRole.deleteMany({ where: { userID: { in: ALL_IDS } } });
      await db.roleAuditLog.deleteMany({
        where: { actorUserID: { in: ALL_IDS } },
      });
    };

    const setFlag = async (key: string, value: string) => {
      await db.systemFlag.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
      resetEventsFlagCache();
      resetEventReviewFlagCache();
      resetNotificationsFlagCache();
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: {
          userID,
          roles,
          role: "",
          updatedAt: new Date(),
          updatedBy: "test",
        },
      });

    /** A complete event with two residents signed up; published by default. */
    const makeEvent = async (over: Record<string, unknown> = {}) => {
      const eventID = nextEventID++;
      await db.event.create({
        data: {
          eventID,
          ccaID: CCA,
          createdBy: USERS.head,
          title: TRICKY_TITLE,
          description: "Internal description",
          startTime: T,
          endTime: T + 2 * HOUR,
          location: "Somewhere",
          facilityID: null,
          capacity: null,
          status: "published",
          publishedAt: new Date(),
          publicDescription: "Come along",
          bannerUrl: `https://example.public.blob.vercel-storage.com/event/${eventID}/banner-x.webp`,
          photoUrls: [],
          scannerUserIDs: [],
          attendanceOpensAt: null,
          attendanceClosesAt: null,
          answersPurgedAt: null,
          createdAt: new Date(),
          ...over,
        },
      });
      await db.eventSignup.createMany({
        data: [
          { eventID, userID: USERS.resident },
          { eventID, userID: USERS.second },
        ],
      });
      return eventID;
    };

    const eventRow = (eventID: number) =>
      db.event.findUniqueOrThrow({ where: { eventID } });
    const inbox = (userID: string) =>
      db.notification.findMany({ where: { userID } });
    const totalRows = () =>
      db.notification.count({ where: { userID: { in: ALL_IDS } } });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      savedFlags = await db.systemFlag.findMany({
        where: { key: { in: FLAGS } },
        select: { key: true, value: true },
      });
    }, 120_000);

    beforeEach(async () => {
      forced.fail = false;
      ops.length = 0;
      await clean();
      await setFlag("events.enabled", "on");
      await setFlag("events.review.required", "off");
      await setFlag("notifications.enabled", "on");
      await setRoles(USERS.head, HEAD);
      await setRoles(USERS.jcrc, JCRC);
      await db.ccaHead.create({ data: { userID: USERS.head, ccaID: CCA } });
    });

    afterAll(async () => {
      if (!db) return;
      await clean();
      await db.systemFlag.deleteMany({ where: { key: { in: FLAGS } } });
      for (const f of savedFlags) {
        await db.systemFlag.create({ data: f });
      }
      resetEventsFlagCache();
      resetEventReviewFlagCache();
      resetNotificationsFlagCache();
      await db.$disconnect();
    });

    /* ---------------------------------------------------------------- */
    /* The notices                                                       */
    /* ---------------------------------------------------------------- */

    it("tells the signed-up residents, and only them, of a time change", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).update({
        eventID: id,
        startTime: T + 5 * HOUR,
        endTime: T + 6 * HOUR,
      });
      expect((await eventRow(id)).startTime).toBe(T + 5 * HOUR);
      for (const who of [USERS.resident, USERS.second]) {
        const rows = await inbox(who);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: "event.changed",
          // A4: stored exactly, never escaped.
          title: `Changed: ${TRICKY_TITLE}`,
          href: `/events/${id}`,
          readAt: null,
        });
      }
      expect(await inbox(USERS.bystander)).toHaveLength(0);
      expect(await inbox(USERS.head)).toHaveLength(0);
    });

    it("tells the signed-up residents of a cancellation, with the reason", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).cancelEvent({
        eventID: id,
        reason: 'Too <wet> & "cold"',
      });
      expect((await eventRow(id)).status).toBe("canceled");
      const rows = await inbox(USERS.resident);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "event.canceled",
        title: `Canceled: ${TRICKY_TITLE}`,
        body: 'Too <wet> & "cold"',
      });
      expect(await inbox(USERS.second)).toHaveLength(1);
    });

    it("still tells the residents when a review publishes the event between the cancel's read and its write", async () => {
      const id = await makeEvent({ status: "submitted", publishedAt: null });
      race.beforeCancelWrite = async () => {
        await db.event.update({
          where: { eventID: id },
          data: { status: "published", publishedAt: new Date() },
        });
      };
      await as(USERS.head, HEAD).cancelEvent({ eventID: id, reason: "Rain" });
      expect(race.beforeCancelWrite).toBeNull();
      expect((await eventRow(id)).status).toBe("canceled");
      expect(await inbox(USERS.resident)).toHaveLength(1);
      expect(await inbox(USERS.second)).toHaveLength(1);
    });

    it("tells nobody when a draft that was never published is canceled", async () => {
      const id = await makeEvent({ status: "draft", publishedAt: null });
      await as(USERS.head, HEAD).cancelEvent({ eventID: id });
      expect((await eventRow(id)).status).toBe("canceled");
      expect(await totalRows()).toBe(0);
    });

    it("tells the signed-up residents when the JCRC cancels", async () => {
      const id = await makeEvent();
      await as(USERS.jcrc, JCRC).reviewerCancel({
        eventID: id,
        reason: "Safety",
      });
      expect((await eventRow(id)).status).toBe("canceled");
      expect(await inbox(USERS.resident)).toHaveLength(1);
    });

    it("tells the CCA's heads of a JCRC decision", async () => {
      await setFlag("events.review.required", "on");
      const id = await makeEvent({ status: "submitted", publishedAt: null });
      await as(USERS.jcrc, JCRC).decide({
        eventID: id,
        decision: "request_changes",
        reason: "Add a budget",
      });
      const rows = await inbox(USERS.head);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "event.decided",
        title: `Changes requested: ${TRICKY_TITLE}`,
        body: "Add a budget",
        href: `/cca/${CCA}/events/${id}`,
      });
      // The signed-up residents are not told of a review decision.
      expect(await inbox(USERS.resident)).toHaveLength(0);
    });

    it("sends nothing for an edit that changes neither time nor place", async () => {
      const id = await makeEvent();
      await as(USERS.head, HEAD).update({
        eventID: id,
        startTime: T,
        endTime: T + 2 * HOUR,
        location: "Somewhere",
        capacity: 40,
      });
      expect((await eventRow(id)).capacity).toBe(40);
      expect(await totalRows()).toBe(0);
    });

    /* ---------------------------------------------------------------- */
    /* Flag off                                                          */
    /* ---------------------------------------------------------------- */

    it("writes no rows and looks up no recipients with the flag off", async () => {
      await setFlag("notifications.enabled", "off");
      const edited = await makeEvent();
      const canceled = await makeEvent();
      await as(USERS.head, HEAD).update({
        eventID: edited,
        startTime: T + 5 * HOUR,
        endTime: T + 6 * HOUR,
      });
      await as(USERS.head, HEAD).cancelEvent({
        eventID: canceled,
        reason: "Rain",
      });
      expect((await eventRow(edited)).startTime).toBe(T + 5 * HOUR);
      expect((await eventRow(canceled)).status).toBe("canceled");
      expect(await totalRows()).toBe(0);
      expect(ops.filter((o) => o.startsWith("Notification."))).toEqual([]);
      expect(ops).not.toContain("EventSignup.findMany");
    });

    /* ---------------------------------------------------------------- */
    /* A failed notice never undoes the Event change (R4)                */
    /* ---------------------------------------------------------------- */

    it("keeps a live edit when notify throws", async () => {
      forced.fail = true;
      const id = await makeEvent();
      await expect(
        as(USERS.head, HEAD).update({
          eventID: id,
          startTime: T + 5 * HOUR,
          endTime: T + 6 * HOUR,
        }),
      ).resolves.toEqual({ ok: true });
      expect((await eventRow(id)).startTime).toBe(T + 5 * HOUR);
      expect(await totalRows()).toBe(0);
    });

    it("keeps a head's cancel when notify throws", async () => {
      forced.fail = true;
      const id = await makeEvent();
      await expect(
        as(USERS.head, HEAD).cancelEvent({ eventID: id, reason: "Rain" }),
      ).resolves.toEqual({ status: "canceled" });
      expect((await eventRow(id)).status).toBe("canceled");
      expect(await totalRows()).toBe(0);
    });

    it("keeps a JCRC cancel when notify throws", async () => {
      forced.fail = true;
      const id = await makeEvent();
      await expect(
        as(USERS.jcrc, JCRC).reviewerCancel({ eventID: id, reason: "Safety" }),
      ).resolves.toEqual({ status: "canceled" });
      expect((await eventRow(id)).status).toBe("canceled");
      expect(await totalRows()).toBe(0);
    });

    it("keeps a JCRC decision when notify throws", async () => {
      forced.fail = true;
      await setFlag("events.review.required", "on");
      const id = await makeEvent({ status: "submitted", publishedAt: null });
      await expect(
        as(USERS.jcrc, JCRC).decide({ eventID: id, decision: "approve" }),
      ).resolves.toMatchObject({ status: "published" });
      const row = await eventRow(id);
      expect(row.status).toBe("published");
      expect(row.decidedBy).toBe(USERS.jcrc);
      expect(await totalRows()).toBe(0);
    });
  },
);
