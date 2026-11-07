import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type { buildFeed as BuildFeed } from "~/server/api/services/calendar/feed";
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
 * INTEGRATION TESTS of the calendar page's reads, the personal token and the
 * `.ics` feed (F20), against the LOCAL development database (skipped unless
 * DATABASE_URL is the local dev database; run `npm run test:db`). Run this
 * file on its own. It needs the calendar index script to have run
 * (create-calendar-feed-indexes.mjs --commit), for the two unique indexes.
 *
 * The tests own every row they touch: users E99909xx, CCAs 9021 and 9022
 * (proposals, heads and positions only; the CCA rows are never written),
 * Events 9909001 and up, positions named "TEST ...". The flag rows are put
 * back as they were.
 */

const U = {
  headA: "E9990901", // heads CCA 9021
  headB: "E9990902", // heads CCA 9022
  dirA: "E9990903", // director of 9021
  dirHead: "E9990904", // director of 9021 AND head of 9021
  resident: "E9990905",
  other: "E9990906", // a second ordinary resident
  admin: "E9990907",
};
const IDS = Object.values(U);
const CCA_A = 9021;
const CCA_B = 9022;
const CCAS = [CCA_A, CCA_B];
const EVENT_BASE = 9_909_000;
const FLAGS = [
  "calendar.feed.enabled",
  "events.enabled",
  "proposals.enabled",
  "directors.enabled",
];
const DAY = 86_400;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "calendar, personal token and feed (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let buildFeed: typeof BuildFeed;
    let resetEventsFlagCache: () => void;
    let resetProposalsFlagCache: () => void;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;
    const nowSec = () => Math.floor(Date.now() / 1000);

    const as = (userID: string, client: PrismaClient = db) =>
      createCaller({
        db: client as never,
        session: {
          user: {
            userID,
            roles: ["resident", "admin", "jcrc", "cca_head"],
            eligible: true,
            hasMatric: true,
            credentialsStale: false,
          },
          expires: new Date(Date.now() + 3600_000).toISOString(),
        } as never,
        headers: new Headers({
          "x-forwarded-for": `198.51.100.${(ipCounter += 1)}`,
        }),
      }).calendar;

    const setFlag = async (key: string, value: string | null) => {
      if (key === "events.enabled") resetEventsFlagCache();
      if (value === null) {
        await db.systemFlag.deleteMany({ where: { key } });
      } else {
        await db.systemFlag.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
      // proposals.enabled is cached for a few seconds.
      resetProposalsFlagCache();
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
        where: {
          key: {
            in: ["create", "rotate", "revoke"].flatMap((a) =>
              IDS.map((id) => `calendar.feed.${a}:${id}`),
            ),
          },
        },
      });
      await db.calendarFeedToken.deleteMany({ where: { userID: { in: IDS } } });
      await db.proposal.deleteMany({
        where: { OR: [{ ccaID: { in: CCAS } }, { createdBy: { in: IDS } }] },
      });
      await db.event.deleteMany({ where: { eventID: { gte: EVENT_BASE } } });
      await db.ccaHead.deleteMany({ where: { userID: { in: IDS } } });
      const positions = await db.jcrcPosition.findMany({
        where: { name: { startsWith: "TEST CAL" } },
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
      await db.roleAuditLog.deleteMany({
        where: {
          OR: [{ actorUserID: { in: IDS } }, { targetUserID: { in: IDS } }],
        },
      });
      const accounts = await db.user.findMany({
        where: { email: { startsWith: "e99909" } },
        select: { id: true },
      });
      await db.credentialRevocation.deleteMany({
        where: { userId: { in: accounts.map((a) => a.id) } },
      });
      await db.user.deleteMany({ where: { email: { startsWith: "e99909" } } });
    };

    /** A signed-up account for each test person (the feed checks it exists). */
    const makeAccounts = () =>
      db.user.createMany({
        data: IDS.map((userID) => ({
          userID,
          email: `${userID.toLowerCase()}@u.nus.edu`,
        })),
      });

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.upsert({
        where: { userID },
        create: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
        update: { roles },
      });

    const makePosition = async (
      name: string,
      ccaID: number,
      holder: string,
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST CAL ${name}`,
          createdBy: "test",
          vetsProposals: true,
        },
      });
      await db.jcrcPositionCca.create({
        data: { positionID: p.id, ccaID, addedBy: "test" },
      });
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

    let nextEvent = EVENT_BASE;
    /** An Event starting `days` from now. */
    const makeEvent = async (
      title: string,
      days: number,
      status: string | null = "published",
      ccaID: number | null = null,
    ) => {
      const eventID = (nextEvent += 1);
      await db.event.create({
        data: {
          eventID,
          ccaID,
          createdBy: U.headA,
          title,
          publicDescription: `About ${title}`,
          location: "Dining Hall",
          startTime: nowSec() + days * DAY,
          endTime: nowSec() + days * DAY + 7200,
          status,
          updatedAt: new Date(),
        },
      });
      return eventID;
    };

    /** A proposal row planned `days` from now, written directly. */
    const makeProposal = async (
      title: string,
      days: number | null,
      status: string,
      over: { ccaID?: number; eventID?: number | null } = {},
    ) =>
      (
        await db.proposal.create({
          data: {
            ccaID: over.ccaID ?? CCA_A,
            createdBy: U.headA,
            category: "pubs",
            title,
            description: "A private description",
            plannedStart: days === null ? null : nowSec() + days * DAY,
            plannedEnd: days === null ? null : nowSec() + days * DAY + 7200,
            status,
            eventID: over.eventID ?? null,
          },
        })
      ).id;

    const tokenFor = async (userID: string) =>
      (await as(userID).feedCreate()).token;
    const feedOf = async (userID: string) => {
      const res = await buildFeed(db, await tokenFor(userID));
      expect(res.status).toBe(200);
      return res.body;
    };
    const summaries = (body: string) =>
      body
        .replace(/\r\n /g, "")
        .split("\r\n")
        .filter((l) => l.startsWith("SUMMARY:"))
        .map((l) => l.slice(8));

    const proxied = (
      target: PrismaClient,
      patch: (prop: string | symbol) => unknown,
    ) => {
      const value = (prop: string | symbol) => {
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function"
          ? (v as (...a: unknown[]) => unknown).bind(target)
          : v;
      };
      return new Proxy(target, {
        get: (_t, prop) => patch(prop) ?? value(prop),
      });
    };
    const withFailingFlag = (key: string): PrismaClient => {
      resetProposalsFlagCache();
      return proxied(db, (prop) =>
        prop === "systemFlag"
          ? {
              findUnique: (args: { where: { key: string } }) =>
                args.where.key === key
                  ? Promise.reject(new Error("db down"))
                  : db.systemFlag.findUnique(args as never),
            }
          : undefined,
      );
    };
    const withFailingTable = (table: string): PrismaClient =>
      proxied(db, (prop) =>
        prop === table
          ? {
              findFirst: () => Promise.reject(new Error("db down")),
              findMany: () => Promise.reject(new Error("db down")),
              findUnique: () => Promise.reject(new Error("db down")),
            }
          : undefined,
      );

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ buildFeed } = await import("~/server/api/services/calendar/feed"));
      ({ resetEventsFlagCache } = await import("~/server/api/services/events"));
      ({ resetProposalsFlagCache } = await import(
        "~/server/api/services/proposals/flag"
      ));
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      await makeAccounts();
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.dirA, U.dirHead]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      await setRoles(U.dirHead, ["resident", "jcrc", "cca_head"]);
      for (const id of [U.headA, U.headB]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      for (const id of [U.resident, U.other]) await setRoles(id, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, CCA_A],
        [U.headB, CCA_B],
        [U.dirHead, CCA_A],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Dir A", CCA_A, U.dirA);
      await makePosition("Dir Head", CCA_A, U.dirHead);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("the token", () => {
      it("is stored only as a SHA-256 hash, and is not readable again", async () => {
        const { token } = await as(U.resident).feedCreate();

        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const row = await db.calendarFeedToken.findFirstOrThrow({
          where: { userID: U.resident },
        });
        expect(row.tokenHash).toBe(sha(token));
        expect(JSON.stringify(row)).not.toContain(token);
        const status = await as(U.resident).feedStatus();
        expect(status).toMatchObject({ enabled: true, hasToken: true });
        expect(JSON.stringify(status)).not.toContain(token);
      });

      it("refuses a second token for the same person and keeps the first", async () => {
        const { token } = await as(U.resident).feedCreate();

        expect(await errorOf(as(U.resident).feedCreate())).toBe(
          "CONFLICT:FEED_TOKEN_EXISTS",
        );
        expect(await buildFeed(db, token)).toMatchObject({ status: 200 });
      });

      it("rotating kills the old token in the same write and gives a working new one", async () => {
        const old = await tokenFor(U.resident);

        const { token } = await as(U.resident).feedRotate();

        expect(token).not.toBe(old);
        expect((await buildFeed(db, old)).status).toBe(401);
        expect((await buildFeed(db, token)).status).toBe(200);
        expect(
          await db.calendarFeedToken.count({ where: { userID: U.resident } }),
        ).toBe(1);
      });

      it("rotating with no token is NOT_FOUND and makes none", async () => {
        expect(await errorOf(as(U.resident).feedRotate())).toBe(
          "NOT_FOUND:FEED_TOKEN_MISSING",
        );
        expect(
          await db.calendarFeedToken.count({ where: { userID: U.resident } }),
        ).toBe(0);
      });

      it("revoking removes it, and revoking again is quiet", async () => {
        const token = await tokenFor(U.resident);

        await as(U.resident).feedRevoke();
        await as(U.resident).feedRevoke();

        expect((await buildFeed(db, token)).status).toBe(401);
        expect(await as(U.resident).feedStatus()).toMatchObject({
          enabled: true,
          hasToken: false,
        });
      });

      it("a person can only create, rotate and revoke their own", async () => {
        const mine = await tokenFor(U.resident);
        const theirs = await tokenFor(U.other);

        await as(U.other).feedRotate();
        await as(U.other).feedRevoke();

        // Nothing the other person did touched mine.
        expect((await buildFeed(db, mine)).status).toBe(200);
        expect((await buildFeed(db, theirs)).status).toBe(401);
      });

      it("is rate limited per person", async () => {
        for (let i = 0; i < 5; i += 1) {
          await db.calendarFeedToken.deleteMany({
            where: { userID: U.resident },
          });
          await as(U.resident).feedCreate();
        }
        await db.calendarFeedToken.deleteMany({
          where: { userID: U.resident },
        });

        expect(await errorOf(as(U.resident).feedCreate())).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:/,
        );
        // Someone else's budget is separate.
        await expect(as(U.other).feedCreate()).resolves.toHaveProperty("token");
      });

      it("deleting the account removes the person's token and only theirs", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "~/server/api/services/userAdmin"
        );
        const user = await db.user.findFirstOrThrow({
          where: { userID: U.resident },
        });
        const gone = await tokenFor(U.resident);
        const kept = await tokenFor(U.other);

        const target = await loadAdminUserTarget(db, user.id);
        const result = await deleteUserAccountCascade(db, target, U.admin);

        expect(result.deleted).toMatchObject({ calendarFeedToken: 1 });
        expect((await buildFeed(db, gone)).status).toBe(401);
        expect((await buildFeed(db, kept)).status).toBe(200);
      });
    });

    describe("the owner's standing", () => {
      it("a password reset kills a link made before it, and a link made after works", async () => {
        const before = await tokenFor(U.resident);
        const account = await db.user.findFirstOrThrow({
          where: { userID: U.resident },
        });
        // What reset-password/route.ts writes.
        await db.credentialRevocation.upsert({
          where: { userId: account.id },
          create: {
            userId: account.id,
            changedAt: new Date(Date.now() + 5000),
            reason: "password_reset",
          },
          update: { changedAt: new Date(Date.now() + 5000) },
        });

        expect((await buildFeed(db, before)).status).toBe(401);

        // A link made after the reset (the clock moved past it) works.
        await db.credentialRevocation.update({
          where: { userId: account.id },
          data: { changedAt: new Date(Date.now() - 5000) },
        });
        await as(U.resident).feedRevoke();
        expect((await buildFeed(db, await tokenFor(U.resident))).status).toBe(
          200,
        );
      });

      it("rotating before the reset does not help; rotating after does", async () => {
        const account = await db.user.findFirstOrThrow({
          where: { userID: U.resident },
        });
        await tokenFor(U.resident);
        await as(U.resident).feedRotate();
        await db.credentialRevocation.create({
          data: {
            userId: account.id,
            changedAt: new Date(Date.now() + 5000),
            reason: "password_reset",
          },
        });
        const rotatedBefore = await db.calendarFeedToken.findFirstOrThrow({
          where: { userID: U.resident },
        });
        expect(rotatedBefore.rotatedAt).not.toBeNull();
        // The rotated link was made before the reset: refused.
        await db.calendarFeedToken.update({
          where: { id: rotatedBefore.id },
          data: { tokenHash: sha("known-token") },
        });
        expect((await buildFeed(db, "known-token")).status).toBe(401);
      });

      it("a reset of one person leaves everyone else's link alone", async () => {
        const mine = await tokenFor(U.resident);
        const theirs = await tokenFor(U.other);
        const account = await db.user.findFirstOrThrow({
          where: { userID: U.resident },
        });
        await db.credentialRevocation.create({
          data: {
            userId: account.id,
            changedAt: new Date(Date.now() + 5000),
            reason: "password_reset",
          },
        });

        expect((await buildFeed(db, mine)).status).toBe(401);
        expect((await buildFeed(db, theirs)).status).toBe(200);
      });

      it("an owner with no account, or no NUS identity, gets 401", async () => {
        const token = await tokenFor(U.resident);
        const account = await db.user.findFirstOrThrow({
          where: { userID: U.resident },
        });

        await db.user.update({
          where: { id: account.id },
          data: { email: "someone@gmail.com" },
        });
        expect((await buildFeed(db, token)).status).toBe(401);

        await db.user.delete({ where: { id: account.id } });
        expect((await buildFeed(db, token)).status).toBe(401);
      });

      it("a failed account read is 503, never a served feed", async () => {
        const token = await tokenFor(U.resident);

        expect((await buildFeed(withFailingTable("user"), token)).status).toBe(
          503,
        );
        expect(
          (await buildFeed(withFailingTable("credentialRevocation"), token))
            .status,
        ).toBe(503);
      });

      it("a spent owner budget is 429 and reads no calendar", async () => {
        const token = await tokenFor(U.resident);

        const res = await buildFeed(db, token, new Date(), () =>
          Promise.resolve(false),
        );

        expect(res.status).toBe(429);
        expect(res.body.trim()).toBe("Too many requests");
      });
    });

    describe("the switch", () => {
      it("off, absent or a failed read fails every token procedure and the feed closed", async () => {
        const token = await tokenFor(U.resident);
        for (const value of ["off", "ON", null]) {
          await setFlag("calendar.feed.enabled", value);
          expect(await errorOf(as(U.resident).feedCreate())).toBe(
            "FORBIDDEN:CALENDAR_FEED_DISABLED",
          );
          expect(await errorOf(as(U.resident).feedRotate())).toBe(
            "FORBIDDEN:CALENDAR_FEED_DISABLED",
          );
          expect(await errorOf(as(U.resident).feedRevoke())).toBe(
            "FORBIDDEN:CALENDAR_FEED_DISABLED",
          );
          expect(await as(U.resident).feedStatus()).toEqual({ enabled: false });
          expect((await buildFeed(db, token)).status).toBe(503);
        }
        // Nothing was changed on the way.
        expect(
          await db.calendarFeedToken.count({ where: { userID: U.resident } }),
        ).toBe(1);
      });

      it("a failed flag read is off, for the feed and for every procedure", async () => {
        const token = await tokenFor(U.resident);
        const broken = withFailingFlag("calendar.feed.enabled");

        expect((await buildFeed(broken, token)).status).toBe(503);
        expect(await errorOf(as(U.resident, broken).feedCreate())).toBe(
          "FORBIDDEN:CALENDAR_FEED_DISABLED",
        );
        expect(await as(U.resident, broken).feedStatus()).toEqual({
          enabled: false,
        });
      });

      it("a token read that fails is 503, never an empty calendar or a 401", async () => {
        const token = await tokenFor(U.resident);

        const res = await buildFeed(
          withFailingTable("calendarFeedToken"),
          token,
        );

        expect(res.status).toBe(503);
      });

      it("the calendar page still reads with the feed switched off", async () => {
        await setFlag("calendar.feed.enabled", "off");
        await makeEvent("Open day", 3);

        const month = await as(U.resident).month(monthOf(3));

        expect(month.events.state).toBe("ok");
      });
    });

    /** The calendar month that holds an instant `days` from now, in Singapore. */
    function monthOf(days: number) {
      const at = new Date((nowSec() + days * DAY + 8 * 3600) * 1000);
      return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 };
    }

    describe("the feed holds what that person may see", () => {
      it("an unknown, malformed or oversized token is 401 and reads no calendar", async () => {
        await makeEvent("Hall Dinner", 3);
        const reads: string[] = [];
        const watched = proxied(db, (prop) =>
          prop === "event"
            ? {
                findMany: () => {
                  reads.push("event.findMany");
                  return Promise.resolve([]);
                },
              }
            : undefined,
        );

        for (const token of ["", "nope", "a".repeat(5000), "x".repeat(43)]) {
          expect(
            (await buildFeed(watched, token)).status,
            token.slice(0, 8),
          ).toBe(401);
        }
        expect(reads).toEqual([]);
      });

      it("published Events appear for everyone; unpublished ones never do", async () => {
        await makeEvent("Hall Dinner", 3);
        await makeEvent("Draft Gala", 4, "draft");
        await makeEvent("Waiting Gala", 5, "submitted");
        await makeEvent("Called Off", 6, "canceled");
        await makeEvent("No Status", 7, null);

        const body = await feedOf(U.resident);

        expect(summaries(body)).toEqual(["[Hall] Hall Dinner"]);
        expect(body).not.toContain("Gala");
        expect(body).not.toContain("Called Off");
      });

      it("an Event in another CCA's name is labelled with that CCA, and carries only public text", async () => {
        await makeEvent("Drama Night", 3, "published", CCA_A);

        const body = await feedOf(U.resident);

        expect(body).toContain("Drama Night");
        expect(body).toContain("DESCRIPTION:About Drama Night");
        expect(body).not.toContain(U.headA);
      });

      it("only the window is read: far past and far future Events are left out", async () => {
        await makeEvent("Recent", -2);
        await makeEvent("Long ago", -90);
        await makeEvent("Far away", 700);

        expect(summaries(await feedOf(U.resident))).toEqual(["[Hall] Recent"]);
      });

      it("the events switch off removes the Events from the feed", async () => {
        await makeEvent("Hall Dinner", 3);
        const token = await tokenFor(U.resident);
        await setFlag("events.enabled", "off");

        const res = await buildFeed(db, token);

        expect(res.status).toBe(200);
        expect(summaries(res.body)).toEqual([]);
      });

      it("a feed fetched twice is identical, and a UID is the same each time", async () => {
        const eventID = await makeEvent("Hall Dinner", 3);
        const token = await tokenFor(U.resident);

        const a = await buildFeed(db, token);
        const b = await buildFeed(db, token);

        expect(a).toEqual(b);
        expect(a.body).toContain(`UID:event-${eventID}@calendar.rhapp`);
      });

      it("another person's token gives that person's view, not the first person's", async () => {
        await makeEvent("Hall Dinner", 3);
        await makeProposal("Secret Pub Night", 5, "draft");

        const headFeed = await feedOf(U.headA);
        const residentFeed = await feedOf(U.resident);

        expect(
          summaries(headFeed).map((x) => x.replace(/\[.*?\] /, "")),
        ).toEqual(["Hall Dinner", "Proposal: Secret Pub Night"].map((x) => x));
        expect(residentFeed).not.toContain("Secret Pub Night");
        expect(summaries(residentFeed)).toEqual(["[Hall] Hall Dinner"]);
      });
    });

    describe("the proposal layer", () => {
      it("is off while proposals.enabled is off", async () => {
        await makeProposal("Pub Night", 5, "draft");
        const token = await tokenFor(U.headA);
        await setFlag("proposals.enabled", "off");

        const res = await buildFeed(db, token);

        expect(res.status).toBe(200);
        expect(res.body).not.toContain("Pub Night");
        expect((await as(U.headA).month(monthOf(5))).proposals).toEqual({
          state: "off",
        });
      });

      it("a head sees their CCA's draft and submitted proposals; canceled and undated ones never show", async () => {
        await makeProposal("Draft Idea", 3, "draft");
        await makeProposal("Sent Idea", 4, "in_review");
        await makeProposal("Dropped Idea", 5, "canceled");
        await makeProposal("Undated Idea", null, "in_review");
        await makeProposal("Other CCA Idea", 6, "in_review", { ccaID: CCA_B });

        const body = await feedOf(U.headA);

        expect(summaries(body).map((s) => s.replace(/\[.*?\] /, ""))).toEqual([
          "Proposal: Draft Idea",
          "Proposal: Sent Idea",
        ]);
        expect(body).toContain("STATUS:TENTATIVE");
        expect(body).toContain("CATEGORIES:Proposal");
      });

      it("a director sees submitted proposals of their CCA, and a draft stays hidden", async () => {
        await makeProposal("Draft Idea", 3, "draft");
        await makeProposal("Sent Idea", 4, "in_review");
        await makeProposal("Cleared Idea", 5, "cleared");

        const body = await feedOf(U.dirA);

        const names = summaries(body).map((s) => s.replace(/\[.*?\] /, ""));
        expect(names).toEqual([
          "Proposal: Sent Idea",
          "Proposal: Cleared Idea",
        ]);
        expect(body).not.toContain("Draft Idea");
      });

      it("a person who is both head and director is a head: drafts show", async () => {
        await makeProposal("Draft Idea", 3, "draft");

        const month = await as(U.dirHead).month(monthOf(3));

        expect(month.proposals).toMatchObject({
          state: "ok",
          items: [{ title: "Draft Idea", viewer: "head" }],
        });
      });

      it("shows nothing to a resident, an admin or a head of another CCA", async () => {
        await makeProposal("Sent Idea", 4, "in_review");

        for (const who of [U.resident, U.admin, U.headB]) {
          const body = await feedOf(who);
          expect(body, who).not.toContain("Sent Idea");
          await db.calendarFeedToken.deleteMany({ where: { userID: who } });
        }
      });

      it("is dropped on the next fetch once the head or director role is lost", async () => {
        await makeProposal("Sent Idea", 4, "in_review");
        const headToken = await tokenFor(U.headA);
        const dirToken = await tokenFor(U.dirA);
        expect((await buildFeed(db, headToken)).body).toContain("Sent Idea");
        expect((await buildFeed(db, dirToken)).body).toContain("Sent Idea");

        await db.ccaHead.deleteMany({ where: { userID: U.headA } });
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.dirA } });

        // The same links, now with less behind them.
        expect((await buildFeed(db, headToken)).body).not.toContain(
          "Sent Idea",
        );
        expect((await buildFeed(db, dirToken)).body).not.toContain("Sent Idea");
      });

      it("a proposal read that fails fails the whole feed with 503, not a partial one", async () => {
        await makeEvent("Hall Dinner", 3);
        const token = await tokenFor(U.headA);

        const res = await buildFeed(withFailingTable("ccaHead"), token);

        expect(res.status).toBe(503);
      });

      it("a failed director read is an error, never an empty layer (fail closed)", async () => {
        await makeProposal("Sent Idea", 4, "in_review");
        const broken = withFailingTable("jcrcPositionHolder");

        const month = await as(U.dirA, broken).month(monthOf(4));

        expect(month.proposals).toEqual({ state: "error" });
        expect(month.events.state).toBe("ok");
      });

      it("carries no description, note, comment or person: a title, a CCA, a status and the dates", async () => {
        await makeProposal("Sent Idea", 4, "in_review");

        const body = await feedOf(U.headA);

        expect(body).not.toContain("A private description");
        expect(body).not.toContain(U.headA);
        expect(body).toMatch(/DESCRIPTION:Proposal\\, In review/i);
      });
    });

    describe("A21: nothing is shown twice", () => {
      it("a proposal drops out once its Event is published, and the Event shows once", async () => {
        const eventID = await makeEvent("Pub Night", 5, "draft");
        await makeProposal("Pub Night", 5, "cleared", { eventID });
        const token = await tokenFor(U.headA);

        const before = summaries((await buildFeed(db, token)).body);
        expect(before.some((s) => s.startsWith("Proposal:"))).toBe(true);
        expect(
          before.some((s) => s.startsWith("[") && s.includes("Pub Night")),
        ).toBe(false);

        await db.event.update({
          where: { eventID },
          data: { status: "published" },
        });

        const after = summaries((await buildFeed(db, token)).body);
        expect(after).toHaveLength(1);
        expect(after[0]).toBe("[Hall] Pub Night");
      });

      it("hides the proposal when its Event is canceled, and shows neither", async () => {
        const eventID = await makeEvent("Pub Night", 5, "canceled");
        await makeProposal("Pub Night", 5, "cleared", { eventID });

        expect(summaries(await feedOf(U.headA))).toEqual([]);
      });

      it("still hides the proposal when the Event was moved into another month", async () => {
        const eventID = await makeEvent("Pub Night", 80, "published");
        await makeProposal("Pub Night", 5, "cleared", { eventID });

        const month = await as(U.headA).month(monthOf(5));

        expect(month.proposals).toEqual({ state: "ok", items: [] });
      });

      it("keeps the proposal when its Event was deleted", async () => {
        await makeProposal("Pub Night", 5, "cleared", {
          eventID: EVENT_BASE + 500,
        });

        expect(summaries(await feedOf(U.headA))).toHaveLength(1);
      });

      it("keeps the proposal while its Event is still a draft or waiting", async () => {
        const draft = await makeEvent("Pub Night", 5, "draft");
        await makeProposal("Pub Night", 5, "cleared", { eventID: draft });

        expect(
          summaries(await feedOf(U.headA)).filter((s) =>
            s.startsWith("Proposal:"),
          ),
        ).toHaveLength(1);
      });

      it("an edit to a proposal's date or title shows on the very next read", async () => {
        const id = await makeProposal("Old Title", 5, "in_review");
        const token = await tokenFor(U.headA);
        expect((await buildFeed(db, token)).body).toContain("Old Title");

        await db.proposal.update({
          where: { id },
          data: { title: "New Title", plannedStart: nowSec() + 9 * DAY },
        });

        const body = (await buildFeed(db, token)).body;
        expect(body).toContain("New Title");
        expect(body).not.toContain("Old Title");
        expect(body).toContain(`UID:proposal-${id}@calendar.rhapp`);
      });
    });

    describe("the calendar page", () => {
      it("returns the month's grid with published Events and no unpublished one", async () => {
        await makeEvent("Hall Dinner", 3);
        await makeEvent("Draft Gala", 3, "draft");

        const month = await as(U.resident).month(monthOf(3));

        expect(month.days.length % 7).toBe(0);
        expect(month.events).toMatchObject({
          state: "ok",
          items: [{ title: "Hall Dinner" }],
        });
        expect(month.proposals).toEqual({ state: "ok", items: [] });
      });

      it("an Event read that fails is an error on that layer; the proposals still draw", async () => {
        await makeProposal("Sent Idea", 3, "in_review");

        const month = await as(U.headA, withFailingTable("event")).month(
          monthOf(3),
        );

        expect(month.events).toEqual({ state: "error" });
        expect(month.proposals).toMatchObject({ state: "ok" });
      });

      it("events.enabled off turns the Event layer off, not into an error", async () => {
        await setFlag("events.enabled", "off");

        const month = await as(U.resident).month(monthOf(3));

        expect(month.events).toEqual({ state: "off" });
      });

      it("rejects a month outside the supported range", async () => {
        expect(
          await errorOf(as(U.resident).month({ year: 1999, month: 1 })),
        ).toMatch(/BAD_REQUEST/);
        expect(
          await errorOf(as(U.resident).month({ year: 2026, month: 13 })),
        ).toMatch(/BAD_REQUEST/);
      });

      it("the page's read writes nothing to Events or proposals", async () => {
        const eventID = await makeEvent("Hall Dinner", 3);
        const id = await makeProposal("Sent Idea", 3, "in_review");
        const before = {
          event: await db.event.findUnique({ where: { eventID } }),
          proposal: await db.proposal.findUnique({ where: { id } }),
        };

        await as(U.headA).month(monthOf(3));
        await feedOf(U.headA);

        expect(await db.event.findUnique({ where: { eventID } })).toEqual(
          before.event,
        );
        expect(await db.proposal.findUnique({ where: { id } })).toEqual(
          before.proposal,
        );
      });
    });
  },
);
