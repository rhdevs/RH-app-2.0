import { Prisma, type PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type * as ProposalsFlagModule from "../proposals/flag";
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
 * INTEGRATION TESTS of the proposal comment thread, unread counts and the
 * head's nudge (F11, F21), against the LOCAL development database (skipped
 * unless DATABASE_URL is the local dev database; run `npm run test:db`). Run
 * this file on its own. It needs the proposal index script to have run
 * (create-proposal-indexes.mjs --commit), for the read-marker and nudge-key
 * unique indexes.
 *
 * The tests own every row they touch: users E99908xx, CCAs 9011 and 9012
 * (proposals, heads and positions only; the CCA rows are never written),
 * positions named "TEST ...", every `proposal.*` notice. The three flag rows
 * are put back as they were.
 */

const U = {
  headA: "E9990801", // heads CCA 9011
  headA2: "E9990802", // also heads CCA 9011
  headB: "E9990803", // heads CCA 9012
  dirA: "E9990804", // director of 9011
  dirA2: "E9990805", // also director of 9011 (holds no position until a test says)
  dirB: "E9990806", // director of 9012
  dirHead: "E9990807", // director of 9011 AND head of 9011
  admin: "E9990808",
  jcrc: "E9990809", // jcrc, no position
  former: "E9990810", // used to head 9011, has no head row now
  scrc: "E9990811",
  resident: "E9990812",
};
const IDS = Object.values(U);
const CCA_A = 9011;
const CCA_B = 9012;
const CCAS = [CCA_A, CCA_B];
const FLAGS = [
  "proposals.enabled",
  "directors.enabled",
  "notifications.enabled",
];
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const NOT_FOUND = "NOT_FOUND:PROPOSAL_NOT_FOUND";
const DAY_MS = 86_400_000;
const LIMIT_ACTIONS = [
  "create",
  "update",
  "submit",
  "approve",
  "return",
  "finish",
  "comment",
  "nudge",
  "commentRead",
];

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "proposal comments, unread counts and nudges (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let proposalsFlag: typeof ProposalsFlagModule;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;

    const as = (
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
          "x-forwarded-for": `198.51.100.${(ipCounter += 1)}`,
        }),
      }).proposal;

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
      // proposals.enabled is cached for a few seconds.
      proposalsFlag.resetProposalsFlagCache();
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

    const limitKeys = () =>
      LIMIT_ACTIONS.flatMap((action) =>
        IDS.map((id) => `proposal.${action}:${id}`),
      );

    const clean = async () => {
      await db.rateLimit.deleteMany({ where: { key: { in: limitKeys() } } });
      const mine = await db.proposal.findMany({
        where: { OR: [{ ccaID: { in: CCAS } }, { createdBy: { in: IDS } }] },
        select: { id: true },
      });
      const ids = mine.map((p) => p.id);
      await db.proposalStatusHistory.deleteMany({
        where: { proposalID: { in: ids } },
      });
      await db.proposalComment.deleteMany({
        where: { proposalID: { in: ids } },
      });
      await db.proposalCommentRead.deleteMany({
        where: { OR: [{ proposalID: { in: ids } }, { userID: { in: IDS } }] },
      });
      await db.proposal.deleteMany({ where: { id: { in: ids } } });
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
            { kind: { startsWith: "proposal." } },
            { noticeKey: { startsWith: "request.nudge:" } },
          ],
        },
      });
      await db.roleAuditLog.deleteMany({
        where: {
          OR: [
            { actorUserID: { in: IDS } },
            { targetUserID: { in: IDS } },
            { action: "proposal.transition", targetCcaID: { in: CCAS } },
          ],
        },
      });
      await db.user.deleteMany({ where: { email: { startsWith: "e99908" } } });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.upsert({
        where: { userID },
        create: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
        update: { roles },
      });

    const makePosition = async (
      name: string,
      ccaIDs: number[],
      holder: string,
    ) => {
      const p = await db.jcrcPosition.create({
        data: { name: `TEST ${name}`, createdBy: "test", vetsProposals: true },
      });
      for (const ccaID of ccaIDs) {
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

    const failingTable = () => ({
      findFirst: () => Promise.reject(new Error("db down")),
      findMany: () => Promise.reject(new Error("db down")),
      findUnique: () => Promise.reject(new Error("db down")),
    });

    /** A database where reading one table fails INSIDE a transaction. */
    const withFailingTxRead = (table: string): PrismaClient =>
      proxied(db, (prop) =>
        prop === "$transaction"
          ? (fn: (tx: unknown) => Promise<unknown>, opts?: never) =>
              db.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, p) {
                        return p === table
                          ? failingTable()
                          : (Reflect.get(t, p) as unknown);
                      },
                    }),
                  ),
                opts,
              )
          : undefined,
      );

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
                              findMany: () => Promise.resolve([]),
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

    /** A database where reading ONE flag key fails. */
    const withFailingFlag = (key: string): PrismaClient => {
      proposalsFlag.resetProposalsFlagCache();
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

    const READ_METHODS = new Set([
      "findUnique",
      "findFirst",
      "findMany",
      "count",
      "groupBy",
      "aggregate",
    ]);

    /**
     * A database that records every call to a model and REFUSES any write, and
     * forbids a transaction, so a pure read is proved by what it could do.
     */
    const readOnlyDb = () => {
      const calls: string[] = [];
      const guarded = proxied(db, (prop) => {
        if (prop === "$transaction") {
          return () => Promise.reject(new Error("a read opened a transaction"));
        }
        const delegate = Reflect.get(db, prop, db) as unknown;
        if (
          typeof prop === "string" &&
          !prop.startsWith("$") &&
          typeof delegate === "object" &&
          delegate !== null
        ) {
          return new Proxy(delegate, {
            get(t, method) {
              const fn = Reflect.get(t, method, t) as unknown;
              if (typeof method !== "string" || typeof fn !== "function") {
                return fn;
              }
              if (!READ_METHODS.has(method)) {
                return () =>
                  Promise.reject(new Error(`write ${prop}.${method}`));
              }
              return (...args: unknown[]) => {
                calls.push(`${prop}.${method}`);
                return (fn as (...a: unknown[]) => unknown).apply(t, args);
              };
            },
          });
        }
        return undefined;
      });
      return { db: guarded, calls };
    };

    const draftInput = (ccaID = CCA_A) => ({
      ccaID,
      category: "pubs" as const,
      title: "Pub night",
      description: "A night out",
    });

    /** A proposal in a given status, written through the real procedures. */
    const stage = async (
      to: "draft" | "in_review" | "needs_action" | "cleared" | "finished",
      creator = U.headA,
      ccaID = CCA_A,
    ) => {
      const made = await as(creator).create(draftInput(ccaID));
      if (to === "draft") return made.id;
      const sent = await as(creator).submit({ id: made.id, version: 0 });
      if (to === "in_review") return made.id;
      const director = ccaID === CCA_A ? U.dirA : U.dirB;
      if (to === "needs_action") {
        await as(director).return({
          id: made.id,
          version: sent.version,
          reason: "More detail please",
        });
        return made.id;
      }
      const done = await as(director).approve({
        id: made.id,
        version: sent.version,
      });
      if (to === "finished") {
        await as(director).finish({ id: made.id, version: done.version });
      }
      return made.id;
    };

    const rowsWritten = async (id: string) => ({
      comments: await db.proposalComment.count({ where: { proposalID: id } }),
      markers: await db.proposalCommentRead.count({
        where: { proposalID: id },
      }),
      notices: await db.notification.count({
        where: { kind: { in: ["proposal.comment", "proposal.nudge"] } },
      }),
      counters: await db.rateLimit.count({
        where: { key: { in: limitKeys() } },
      }),
    });

    const noticesOf = (userID: string, kind: string) =>
      db.notification.findMany({ where: { userID, kind } });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      proposalsFlag = await import("../proposals/flag");
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.dirA, U.dirA2, U.dirB, U.jcrc]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      await setRoles(U.dirHead, ["resident", "jcrc", "cca_head"]);
      for (const id of [U.headA, U.headA2, U.headB, U.former]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.scrc, ["resident", "scrc"]);
      await setRoles(U.resident, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, CCA_A],
        [U.headA2, CCA_A],
        [U.headB, CCA_B],
        [U.dirHead, CCA_A],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Dir A", [CCA_A], U.dirA);
      await makePosition("Dir B", [CCA_B], U.dirB);
      await makePosition("Dir Head", [CCA_A], U.dirHead);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("who may use the thread and the nudge", () => {
      const REFUSED: Array<[string, string]> = [
        ["a head of another CCA", U.headB],
        ["a director of another CCA", U.dirB],
        ["an admin", U.admin],
        ["a JCRC member with no position", U.jcrc],
        ["a former head of the CCA", U.former],
        ["an RF", U.scrc],
        ["an ordinary resident", U.resident],
      ];

      it("every comment procedure and the nudge refuse each of them with the same NOT_FOUND, whatever the session claims, and write nothing", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "first" });
        const before = await rowsWritten(id);
        for (const [who, userID] of REFUSED) {
          const caller = as(userID);
          expect(
            await errorOf(caller.commentList({ proposalID: id })),
            `list: ${who}`,
          ).toBe(NOT_FOUND);
          expect(
            await errorOf(caller.commentAdd({ proposalID: id, body: "hi" })),
            `add: ${who}`,
          ).toBe(NOT_FOUND);
          expect(
            await errorOf(caller.commentMarkRead({ proposalID: id })),
            `markRead: ${who}`,
          ).toBe(NOT_FOUND);
          expect(await errorOf(caller.nudge({ id })), `nudge: ${who}`).toBe(
            NOT_FOUND,
          );
        }
        expect(await rowsWritten(id)).toEqual(before);
      });

      it("a missing id gets the same answer as another CCA's id", async () => {
        const missing = "0123456789abcdef01234567";
        const c = as(U.headA);
        expect(await errorOf(c.commentList({ proposalID: missing }))).toBe(
          NOT_FOUND,
        );
        expect(
          await errorOf(c.commentAdd({ proposalID: missing, body: "x" })),
        ).toBe(NOT_FOUND);
        expect(await errorOf(c.commentMarkRead({ proposalID: missing }))).toBe(
          NOT_FOUND,
        );
        expect(await errorOf(c.nudge({ id: missing }))).toBe(NOT_FOUND);
      });

      it("a director who is not a head is refused the nudge: only a head can nudge", async () => {
        const id = await stage("in_review");
        expect(await errorOf(as(U.dirA).nudge({ id }))).toBe(NOT_FOUND);
      });

      it("a head who stops heading the CCA is refused from then on", async () => {
        const id = await stage("in_review");
        await as(U.headA2).commentAdd({ proposalID: id, body: "still here" });
        await db.ccaHead.deleteMany({ where: { userID: U.headA2 } });
        expect(
          await errorOf(as(U.headA2).commentList({ proposalID: id })),
        ).toBe(NOT_FOUND);
        expect(await errorOf(as(U.headA2).nudge({ id }))).toBe(NOT_FOUND);
      });

      it("the CCA is the stored proposal's, not anything the browser sends", async () => {
        const idB = await stage("in_review", U.headB, CCA_B);
        expect(
          await errorOf(as(U.headA).commentAdd({ proposalID: idB, body: "x" })),
        ).toBe(NOT_FOUND);
        expect(
          await errorOf(as(U.dirB).commentAdd({ proposalID: idB, body: "x" })),
        ).toBe("ok");
      });

      it("a director cannot reach a draft's thread, but the heads can, and a head who is also a director can", async () => {
        const id = await stage("draft");
        const dir = as(U.dirA);
        expect(await errorOf(dir.commentList({ proposalID: id }))).toBe(
          NOT_FOUND,
        );
        expect(
          await errorOf(dir.commentAdd({ proposalID: id, body: "peek" })),
        ).toBe(NOT_FOUND);
        expect(await errorOf(dir.commentMarkRead({ proposalID: id }))).toBe(
          NOT_FOUND,
        );
        expect(await rowsWritten(id)).toMatchObject({
          comments: 0,
          markers: 0,
        });

        await as(U.headA2).commentAdd({ proposalID: id, body: "note to us" });
        expect(
          (await as(U.headA).commentList({ proposalID: id })).items,
        ).toHaveLength(1);
        expect(
          await errorOf(as(U.dirHead).commentList({ proposalID: id })),
        ).toBe("ok");

        // Once it is submitted the director opens the thread, but the draft-stage
        // comments stay the heads' (see "heads-only comments").
        const sent = await as(U.headA).get({ id });
        await as(U.headA).submit({ id, version: sent.version });
        expect((await dir.commentList({ proposalID: id })).items).toHaveLength(
          0,
        );
      });
    });

    describe("the thread", () => {
      it("adds and lists newest first, with names, no ids, and markup kept as typed", async () => {
        await db.user.create({
          data: {
            email: "e9990801@u.nus.edu",
            userID: U.headA,
            displayName: "Head A",
          },
        });
        const id = await stage("in_review");
        await as(U.headA).commentAdd({
          proposalID: id,
          body: "  <b>bold</b> & <script>x</script>​ ",
        });
        await as(U.dirA).commentAdd({ proposalID: id, body: "Looks fine" });

        const page = await as(U.headA).commentList({ proposalID: id });
        expect(page.items.map((c) => c.body)).toEqual([
          "Looks fine",
          "<b>bold</b> & <script>x</script>",
        ]);
        expect(page.items[1]).toMatchObject({
          mine: true,
          authorName: "Head A",
        });
        expect(page.items[0]).toMatchObject({ mine: false, authorName: null });
        expect(JSON.stringify(page)).not.toContain(U.headA);
        expect(JSON.stringify(page)).not.toContain(U.dirA);
      });

      it("pages with a cursor: 50 at a time, nothing dropped or repeated", async () => {
        const id = await stage("in_review");
        await db.proposalComment.createMany({
          data: Array.from({ length: 60 }, (_, i) => ({
            proposalID: id,
            authorID: U.headA,
            body: `c${String(i).padStart(2, "0")}`,
            createdAt: new Date(Date.now() - (60 - i) * 1000),
          })),
        });
        const c = as(U.dirA);
        const first = await c.commentList({ proposalID: id });
        expect(first.items).toHaveLength(50);
        expect(first.nextCursor).not.toBeNull();
        const second = await c.commentList({
          proposalID: id,
          cursor: first.nextCursor!,
        });
        expect(second.items).toHaveLength(10);
        expect(second.nextCursor).toBeNull();
        const all = [...first.items, ...second.items].map((x) => x.body);
        expect(new Set(all).size).toBe(60);
        expect(all[0]).toBe("c59");
        expect(all[59]).toBe("c00");
      });

      it("refuses an empty, blank or over-long comment and writes nothing", async () => {
        const id = await stage("in_review");
        const c = as(U.headA);
        for (const body of ["", "   ", "​​", "x".repeat(2001)]) {
          expect(await errorOf(c.commentAdd({ proposalID: id, body }))).toMatch(
            /^BAD_REQUEST:/,
          );
        }
        expect(await rowsWritten(id)).toMatchObject({ comments: 0 });
        await c.commentAdd({ proposalID: id, body: "x".repeat(2000) });
        expect(await rowsWritten(id)).toMatchObject({ comments: 1 });
      });

      it("has no edit and no delete", async () => {
        const { appRouter } = await import("~/server/api/root");
        const names = Object.keys(appRouter._def.procedures);
        expect(names).toContain("proposal.commentAdd");
        expect(
          names.filter((n) =>
            /^proposal.comment(Edit|Delete|Remove|Update)/.test(n),
          ),
        ).toEqual([]);
      });

      it.each([
        "draft",
        "in_review",
        "needs_action",
        "cleared",
        "finished",
      ] as const)(
        "allows a comment while the proposal is %s",
        async (status) => {
          const id = await stage(status);
          expect(
            await errorOf(
              as(U.headA).commentAdd({ proposalID: id, body: "note" }),
            ),
          ).toBe("ok");
        },
      );

      it("refuses a comment on a canceled proposal but still lists the thread", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "before" });
        await db.proposal.update({
          where: { id },
          data: { status: "canceled" },
        });
        expect(
          await errorOf(as(U.headA).commentAdd({ proposalID: id, body: "x" })),
        ).toBe("CONFLICT:COMMENTS_CLOSED");
        expect(
          (await as(U.dirA).commentList({ proposalID: id })).items,
        ).toHaveLength(1);
      });

      it("a deleted author's comment stays readable as a comment with no name", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "~/server/api/services/userAdmin"
        );
        const user = await db.user.create({
          data: { email: "e9990801@u.nus.edu", userID: U.headA },
        });
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "from the past" });
        await as(U.headA).commentMarkRead({ proposalID: id });
        await as(U.dirA).commentAdd({ proposalID: id, body: "reply" });

        const target = await loadAdminUserTarget(db, user.id);
        const result = await deleteUserAccountCascade(db, target, U.admin);

        expect(result.deleted).toMatchObject({
          proposalCommentAuthorCleared: 1,
          proposalCommentRead: 1,
        });
        expect(
          await db.proposalComment.count({ where: { proposalID: id } }),
        ).toBe(2);
        expect(
          await db.proposalCommentRead.count({ where: { userID: U.headA } }),
        ).toBe(0);

        const page = await as(U.headA2).commentList({ proposalID: id });
        expect(page.items.map((c) => [c.body, c.authorName])).toEqual([
          ["reply", null],
          ["from the past", null],
        ]);
        // The comment with no author counts as someone else's for the others.
        expect(page.unread).toBe(2);
        expect((await as(U.dirA).commentList({ proposalID: id })).unread).toBe(
          1,
        );
      });
    });

    describe("unread counts", () => {
      it("each person has their own count, and their own comments are not unread to them", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "one" });
        await as(U.headA).commentAdd({ proposalID: id, body: "two" });
        await as(U.dirA).commentAdd({ proposalID: id, body: "three" });

        const unread = async (who: string) =>
          (await as(who).commentList({ proposalID: id })).unread;
        expect(await unread(U.headA)).toBe(1); // only the director's
        expect(await unread(U.dirA)).toBe(2); // only the head's two
        expect(await unread(U.headA2)).toBe(3);
        expect(await unread(U.dirHead)).toBe(3);
        expect((await as(U.headA).get({ id })).unread).toBe(1);
      });

      it("marking read is per person, and the count rises again with a newer comment", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "one" });
        await as(U.dirA).commentMarkRead({ proposalID: id });

        expect((await as(U.dirA).commentList({ proposalID: id })).unread).toBe(
          0,
        );
        expect(
          (await as(U.headA2).commentList({ proposalID: id })).unread,
        ).toBe(1);

        await new Promise((r) => setTimeout(r, 15));
        await as(U.headA).commentAdd({ proposalID: id, body: "two" });
        expect((await as(U.dirA).commentList({ proposalID: id })).unread).toBe(
          1,
        );
      });

      it("a comment that arrives after the page loaded stays unread when the page marks itself read", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "seen" });
        const page = await as(U.dirA).commentList({ proposalID: id });
        await new Promise((r) => setTimeout(r, 15));
        await as(U.headA).commentAdd({ proposalID: id, body: "late" });

        await as(U.dirA).commentMarkRead({
          proposalID: id,
          upTo: page.items[0]!.createdAt,
        });

        expect((await as(U.dirA).commentList({ proposalID: id })).unread).toBe(
          1,
        );
      });

      it("the marker never moves backward", async () => {
        const id = await stage("in_review");
        await as(U.dirA).commentMarkRead({ proposalID: id });
        const first = await db.proposalCommentRead.findFirst({
          where: { proposalID: id, userID: U.dirA },
        });
        await as(U.dirA).commentMarkRead({
          proposalID: id,
          upTo: new Date(first!.readAt.getTime() - 60_000),
        });
        const after = await db.proposalCommentRead.findFirst({
          where: { proposalID: id, userID: U.dirA },
        });
        expect(after!.readAt.getTime()).toBe(first!.readAt.getTime());
      });

      it("two simultaneous mark-reads leave one marker and no error", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "one" });
        for (let round = 0; round < 3; round += 1) {
          await db.proposalCommentRead.deleteMany({
            where: { proposalID: id, userID: U.dirA },
          });
          const results = await Promise.allSettled(
            Array.from({ length: 4 }, () =>
              as(U.dirA).commentMarkRead({ proposalID: id }),
            ),
          );
          expect(results.map((r) => r.status)).toEqual(
            Array(4).fill("fulfilled"),
          );
          expect(
            await db.proposalCommentRead.count({
              where: { proposalID: id, userID: U.dirA },
            }),
          ).toBe(1);
        }
        expect((await as(U.dirA).commentList({ proposalID: id })).unread).toBe(
          0,
        );
      });

      it("the unread count is a pure read: no write and no transaction, however many times it is asked", async () => {
        const id = await stage("in_review");
        await as(U.headA).commentAdd({ proposalID: id, body: "one" });
        const before = await rowsWritten(id);
        const { db: guarded, calls } = readOnlyDb();
        const dir = as(U.dirA, EVERYTHING, guarded);
        const head = as(U.headA2, EVERYTHING, guarded);

        for (let i = 0; i < 3; i += 1) {
          expect((await dir.commentList({ proposalID: id })).unread).toBe(1);
          expect((await dir.get({ id })).unread).toBe(1);
          expect((await dir.directorQueue({})).items[0]!.unread).toBe(1);
          expect((await head.list({ ccaID: CCA_A })).items[0]!.unread).toBe(1);
        }
        expect(calls.length).toBeGreaterThan(0);
        expect(await rowsWritten(id)).toEqual(before);
      });

      it("a list of proposals is counted in one grouped query, not one per row", async () => {
        const ids = [
          await stage("in_review"),
          await stage("in_review"),
          await stage("needs_action"),
          await stage("draft"),
        ];
        await as(U.headA).commentAdd({ proposalID: ids[0]!, body: "a" });
        await as(U.headA).commentAdd({ proposalID: ids[0]!, body: "b" });
        await as(U.headA).commentAdd({ proposalID: ids[2]!, body: "c" });
        await as(U.dirA).commentMarkRead({ proposalID: ids[2]! });
        await as(U.headA2).commentAdd({ proposalID: ids[3]!, body: "d" });

        const { db: guarded, calls } = readOnlyDb();
        const head = await as(U.headA2, EVERYTHING, guarded).list({
          ccaID: CCA_A,
        });
        const byId = new Map(head.items.map((i) => [i.id, i.unread]));
        expect(byId.get(ids[0]!)).toBe(2);
        expect(byId.get(ids[1]!)).toBe(0);
        expect(byId.get(ids[2]!)).toBe(1);
        expect(byId.get(ids[3]!)).toBe(0); // their own comment
        expect(
          calls.filter((c) => c === "proposalComment.groupBy"),
        ).toHaveLength(1);
        expect(
          calls.filter((c) => c.startsWith("proposalComment.")),
        ).toHaveLength(1);

        const queue = await as(U.dirA).directorQueue({});
        expect(
          Object.fromEntries(queue.items.map((i) => [i.id, i.unread])),
        ).toEqual({ [ids[0]!]: 2, [ids[1]!]: 0 });
      });
    });

    describe("heads-only comments (draft stage)", () => {
      const submitted = async () => {
        const id = await stage("draft");
        await as(U.headA).commentAdd({ proposalID: id, body: "draft talk" });
        await as(U.headA2).commentAdd({ proposalID: id, body: "draft reply" });
        const cur = await as(U.headA).get({ id });
        await as(U.headA).submit({ id, version: cur.version });
        return id;
      };

      it("after submit a director's list, count, page and queue leave the draft-stage comments out, and a head still sees them", async () => {
        const id = await submitted();
        const dir = as(U.dirA);

        const page = await dir.commentList({ proposalID: id });
        expect(page.items).toEqual([]);
        expect(page.unread).toBe(0);
        expect((await dir.get({ id })).unread).toBe(0);
        expect((await dir.directorQueue({})).items[0]).toMatchObject({
          id,
          unread: 0,
        });

        const head = await as(U.headA).commentList({ proposalID: id });
        expect(head.items.map((c) => [c.body, c.headsOnly])).toEqual([
          ["draft reply", true],
          ["draft talk", true],
        ]);
        expect(head.unread).toBe(1); // headA's own comment does not count
      });

      it("a comment written after submit is visible to both, and unread for both", async () => {
        const id = await submitted();
        await as(U.headA).commentAdd({ proposalID: id, body: "open now" });

        const dir = await as(U.dirA).commentList({ proposalID: id });
        expect(dir.items.map((c) => [c.body, c.headsOnly])).toEqual([
          ["open now", false],
        ]);
        expect(dir.unread).toBe(1);
        const head = await as(U.headA2).commentList({ proposalID: id });
        expect(head.items).toHaveLength(3);
        expect(head.unread).toBe(2); // draft talk + open now
      });

      it("a needs_action comment is visible to directors", async () => {
        const id = await stage("needs_action");
        await as(U.headA).commentAdd({ proposalID: id, body: "fixed it" });
        const dir = await as(U.dirA).commentList({ proposalID: id });
        expect(dir.items.map((c) => [c.body, c.headsOnly])).toEqual([
          ["fixed it", false],
        ]);
      });

      it("a head who is also a director sees every comment and counts each once", async () => {
        const id = await submitted();
        await as(U.headA).commentAdd({ proposalID: id, body: "open now" });
        const both = as(U.dirHead);

        const page = await both.commentList({ proposalID: id });
        expect(page.items).toHaveLength(3);
        expect(page.unread).toBe(3);
        expect((await both.get({ id })).unread).toBe(3);
        expect((await both.directorQueue({})).items[0]).toMatchObject({
          id,
          unread: 3,
        });
        expect((await both.list({ ccaID: CCA_A })).items[0]?.unread).toBe(3);
      });

      it("the privacy comes from the status read inside the transaction, not the one before it", async () => {
        const id = await stage("in_review");
        // The earlier read says in_review; the transaction's snapshot says draft.
        const stale = proxied(db, (prop) =>
          prop === "$transaction"
            ? (fn: (tx: unknown) => Promise<unknown>, opts?: never) =>
                db.$transaction(
                  (tx) =>
                    fn(
                      new Proxy(tx, {
                        get(t, p) {
                          if (p !== "proposal") {
                            return Reflect.get(t, p) as unknown;
                          }
                          return {
                            findUnique: async (args: never) => {
                              const row = await t.proposal.findUnique(args);
                              return row && { ...row, status: "draft" };
                            },
                          };
                        },
                      }),
                    ),
                  opts,
                )
            : undefined,
        );
        await as(U.headA, EVERYTHING, stale).commentAdd({
          proposalID: id,
          body: "overlap",
        });
        const row = await db.proposalComment.findFirst({
          where: { proposalID: id },
        });
        expect(row?.headsOnly).toBe(true);
        expect(
          (await as(U.dirA).commentList({ proposalID: id })).items,
        ).toEqual([]);
        expect(await noticesOf(U.dirA, "proposal.comment")).toHaveLength(0);
      });

      it("a comment row from before the field existed is visible to directors", async () => {
        const id = await stage("in_review");
        await db.$runCommandRaw({
          insert: "ProposalComment",
          documents: [
            {
              proposalID: { $oid: id },
              authorID: U.headA,
              body: "old row",
              createdAt: { $date: new Date().toISOString() },
            },
          ],
        });
        const page = await as(U.dirA).commentList({ proposalID: id });
        expect(page.items.map((c) => [c.body, c.headsOnly])).toEqual([
          ["old row", false],
        ]);
        expect(page.unread).toBe(1);
      });
    });

    describe("notices of a comment", () => {
      it("go to the CCA's other heads and its directors, once each, with the route each can open", async () => {
        const id = await stage("in_review");
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });
        await as(U.headA).commentAdd({ proposalID: id, body: "hello" });

        const headLink = `/cca/${CCA_A}/proposals/${id}`;
        const dirLink = `/director/proposals/${id}`;
        expect((await noticesOf(U.headA2, "proposal.comment"))[0]?.href).toBe(
          headLink,
        );
        expect((await noticesOf(U.dirA, "proposal.comment"))[0]?.href).toBe(
          dirLink,
        );
        // Both a head and a director: one notice, with the head's route.
        const both = await noticesOf(U.dirHead, "proposal.comment");
        expect(both).toHaveLength(1);
        expect(both[0]?.href).toBe(headLink);
        // Not the author, and not anyone with no part in this CCA.
        for (const other of [U.headA, U.headB, U.dirB, U.admin, U.former]) {
          expect(await noticesOf(other, "proposal.comment")).toHaveLength(0);
        }
        const all = await db.notification.findMany({
          where: { kind: "proposal.comment" },
        });
        expect(
          all
            .map((n) => n.userID)
            .filter((u) => IDS.includes(u))
            .sort(),
        ).toEqual([U.dirA, U.dirHead, U.headA2].sort());
      });

      it("a director's comment tells the heads and not the director themselves", async () => {
        const id = await stage("in_review");
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });
        await as(U.dirA).commentAdd({ proposalID: id, body: "question" });

        expect(await noticesOf(U.dirA, "proposal.comment")).toHaveLength(0);
        for (const head of [U.headA, U.headA2, U.dirHead]) {
          const got = await noticesOf(head, "proposal.comment");
          expect(got, head).toHaveLength(1);
          expect(got[0]?.href).toBe(`/cca/${CCA_A}/proposals/${id}`);
        }
      });

      it("a draft's comment does not notify directors, who cannot open it", async () => {
        const id = await stage("draft");
        await as(U.headA).commentAdd({ proposalID: id, body: "private" });

        expect(await noticesOf(U.dirA, "proposal.comment")).toHaveLength(0);
        expect(await noticesOf(U.headA2, "proposal.comment")).toHaveLength(1);
        // dirHead heads the CCA, so a draft's comment reaches them as a head.
        expect(await noticesOf(U.dirHead, "proposal.comment")).toHaveLength(1);
      });

      it("recipients are worked out at run time: a head who left is not told, a new one is", async () => {
        const id = await stage("in_review");
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });
        await db.ccaHead.deleteMany({ where: { userID: U.headA2 } });
        await db.ccaHead.create({ data: { userID: U.former, ccaID: CCA_A } });
        await as(U.headA).commentAdd({ proposalID: id, body: "hi" });

        expect(await noticesOf(U.headA2, "proposal.comment")).toHaveLength(0);
        expect(await noticesOf(U.former, "proposal.comment")).toHaveLength(1);
      });

      it("write nothing while notifications are off, and the comment still posts", async () => {
        const id = await stage("in_review");
        await setFlag("notifications.enabled", "off");
        await as(U.headA).commentAdd({ proposalID: id, body: "hi" });

        expect(
          await db.notification.count({ where: { kind: "proposal.comment" } }),
        ).toBe(0);
        expect(await rowsWritten(id)).toMatchObject({ comments: 1 });
      });

      it("a notice that cannot be written rolls the comment back", async () => {
        const id = await stage("in_review");
        const before = await rowsWritten(id);
        const answer = await errorOf(
          as(U.headA, EVERYTHING, withFailingNotices()).commentAdd({
            proposalID: id,
            body: "lost",
          }),
        );
        expect(answer).not.toBe("ok");
        expect(await rowsWritten(id)).toMatchObject({
          comments: before.comments,
          notices: before.notices,
        });
      });

      it.each(["ccaHead", "jcrcPositionCca"])(
        "a recipient read that fails (%s) rolls the comment back",
        async (table) => {
          const id = await stage("in_review");
          const answer = await errorOf(
            as(U.headA, EVERYTHING, withFailingTxRead(table)).commentAdd({
              proposalID: id,
              body: "lost",
            }),
          );
          expect(answer).not.toBe("ok");
          expect(await rowsWritten(id)).toMatchObject({
            comments: 0,
            notices: 0,
          });
        },
      );
    });

    describe("nudge", () => {
      it("tells each current director once, by the director's route, and says so", async () => {
        const id = await stage("in_review");
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });

        const res = await as(U.headA).nudge({ id });

        // dirA and dirHead direct the CCA; the nudging head is not nudged.
        expect(res).toEqual({ status: "sent", sent: 2, alreadySent: 0 });
        for (const dir of [U.dirA, U.dirHead]) {
          const got = await noticesOf(dir, "proposal.nudge");
          expect(got, dir).toHaveLength(1);
          expect(got[0]).toMatchObject({
            href: `/director/proposals/${id}`,
            body: "Pub night",
            readAt: null,
          });
          expect(got[0]?.noticeKey).toMatch(
            new RegExp(
              `^proposal\\.nudge:${id}:\\d{4}-\\d{2}-\\d{2}\\|${dir}$`,
            ),
          );
        }
        for (const other of [U.headA, U.headA2, U.dirB, U.headB]) {
          expect(await noticesOf(other, "proposal.nudge")).toHaveLength(0);
        }
      });

      it("a repeat on the same Singapore day says it was already sent and writes nothing", async () => {
        const id = await stage("in_review");
        await as(U.headA).nudge({ id });
        const before = await rowsWritten(id);

        const again = await as(U.headA2).nudge({ id });

        expect(again).toEqual({
          status: "already_sent",
          sent: 0,
          alreadySent: 2,
        });
        expect((await rowsWritten(id)).notices).toBe(before.notices);
      });

      it("works again on the next Singapore day, and the day is Singapore's", async () => {
        const id = await stage("in_review");
        // 23:30 UTC on 4 Aug is 07:30 SGT on 5 Aug; 15:30 UTC on 5 Aug is
        // 23:30 SGT the same SGT day; 16:30 UTC is 00:30 SGT on 6 Aug.
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.UTC(2031, 7, 4, 23, 30)));
        expect((await as(U.headA).nudge({ id })).status).toBe("sent");
        vi.setSystemTime(new Date(Date.UTC(2031, 7, 5, 15, 30)));
        expect((await as(U.headA).nudge({ id })).status).toBe("already_sent");
        vi.setSystemTime(new Date(Date.UTC(2031, 7, 5, 16, 30)));
        expect((await as(U.headA).nudge({ id })).status).toBe("sent");
        vi.useRealTimers();
        expect(await noticesOf(U.dirA, "proposal.nudge")).toHaveLength(2);
      });

      it("works out the directors when it is pressed (A30): a director who left is not nudged, one who joined is", async () => {
        const id = await stage("in_review");
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });
        // dirA leaves the position; dirA2 takes over.
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dirA },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        const dirPosition = await db.jcrcPosition.findFirst({
          where: { name: "TEST Dir A" },
        });
        await setRoles(U.dirA2, ["resident", "jcrc"]);
        await db.jcrcPositionHolder.create({
          data: {
            positionID: dirPosition!.id,
            userID: U.dirA2,
            assignedBy: U.admin,
            endsAt: null,
          },
        });

        const res = await as(U.headA).nudge({ id });

        expect(res).toMatchObject({ status: "sent", sent: 2 });
        expect(await noticesOf(U.dirA, "proposal.nudge")).toHaveLength(0);
        expect(await noticesOf(U.dirA2, "proposal.nudge")).toHaveLength(1);
        expect(await noticesOf(U.dirHead, "proposal.nudge")).toHaveLength(1);
      });

      it("a director added after a nudge is still nudged the same day; the others are not nudged twice", async () => {
        const id = await stage("in_review");
        await as(U.headA).nudge({ id });
        await setRoles(U.dirA2, ["resident", "jcrc"]);
        await makePosition("Dir A2", [CCA_A], U.dirA2);

        const res = await as(U.headA).nudge({ id });

        expect(res).toEqual({ status: "sent", sent: 1, alreadySent: 2 });
        expect(await noticesOf(U.dirA, "proposal.nudge")).toHaveLength(1);
        expect(await noticesOf(U.dirA2, "proposal.nudge")).toHaveLength(1);
      });

      it.each(["draft", "needs_action", "cleared", "finished"] as const)(
        "is refused while the proposal is %s, and writes nothing",
        async (status) => {
          const id = await stage(status);
          const before = await rowsWritten(id);
          expect(await errorOf(as(U.headA).nudge({ id }))).toBe(
            "CONFLICT:PROPOSAL_NOT_IN_REVIEW",
          );
          expect((await rowsWritten(id)).notices).toBe(before.notices);
        },
      );

      it("says there is no director instead of pretending it went", async () => {
        const id = await stage("in_review");
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });
        await db.jcrcPositionHolder.deleteMany({});
        await db.jcrcPositionCca.deleteMany({ where: { ccaID: CCA_A } });

        const res = await as(U.headA).nudge({ id });

        expect(res).toEqual({ status: "no_director", sent: 0, alreadySent: 0 });
        expect(
          await db.notification.count({ where: { kind: "proposal.nudge" } }),
        ).toBe(0);
      });

      it("a head who is the only director has nobody else to nudge", async () => {
        const id = await stage("in_review");
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.dirA } });

        const res = await as(U.dirHead).nudge({ id });

        expect(res.status).toBe("no_director");
      });

      it("is refused, and says why, while notifications are off", async () => {
        const id = await stage("in_review");
        await setFlag("notifications.enabled", "off");
        expect(await errorOf(as(U.headA).nudge({ id }))).toBe(
          "FORBIDDEN:NOTIFICATIONS_DISABLED",
        );
        expect(
          await db.notification.count({ where: { kind: "proposal.nudge" } }),
        ).toBe(0);
      });

      it("simultaneous nudges leave one notice per director and no error", async () => {
        const id = await stage("in_review");
        for (let round = 0; round < 3; round += 1) {
          await db.notification.deleteMany({
            where: { kind: "proposal.nudge" },
          });
          const results = await Promise.allSettled(
            [U.headA, U.headA2, U.headA, U.headA2].map((u) =>
              as(u).nudge({ id }),
            ),
          );
          expect(results.map((r) => r.status)).toEqual(
            Array(4).fill("fulfilled"),
          );
          expect(await noticesOf(U.dirA, "proposal.nudge")).toHaveLength(1);
          expect(await noticesOf(U.dirHead, "proposal.nudge")).toHaveLength(1);
        }
      });

      const conflict = () =>
        new Prisma.PrismaClientKnownRequestError("write conflict", {
          code: "P2034",
          clientVersion: "test",
        });

      /** A database whose first `fails` transactions throw a write conflict. */
      const conflicting = (fails: number): PrismaClient => {
        let left = fails;
        return proxied(db, (prop) =>
          prop === "$transaction"
            ? (fn: never, opts?: never) => {
                if (left > 0) {
                  left -= 1;
                  return Promise.reject(conflict());
                }
                return db.$transaction(fn, opts);
              }
            : undefined,
        );
      };

      it("retries once on a write conflict and then sends", async () => {
        const id = await stage("in_review");
        const res = await as(U.headA, EVERYTHING, conflicting(1)).nudge({ id });
        expect(res).toMatchObject({ status: "sent", sent: 2 });
        expect(await noticesOf(U.dirA, "proposal.nudge")).toHaveLength(1);
      });

      it("a conflict that persists is a try-again error, never 'already sent', even when a same-day key exists", async () => {
        const id = await stage("in_review");
        await as(U.headA).nudge({ id }); // keys now exist for today
        await setRoles(U.dirA2, ["resident", "jcrc"]);
        await makePosition("Dir A2", [CCA_A], U.dirA2);

        const answer = await errorOf(
          as(U.headA, EVERYTHING, conflicting(2)).nudge({ id }),
        );

        expect(answer).toBe("CONFLICT:NUDGE_TRY_AGAIN");
        // the new director was not nudged, and the head can press again
        expect(await noticesOf(U.dirA2, "proposal.nudge")).toHaveLength(0);
        expect((await as(U.headA).nudge({ id })).status).toBe("sent");
        expect(await noticesOf(U.dirA2, "proposal.nudge")).toHaveLength(1);
      });

      it("a recipient read that fails refuses the nudge and writes nothing", async () => {
        const id = await stage("in_review");
        const answer = await errorOf(
          as(U.headA, EVERYTHING, withFailingTxRead("jcrcPositionCca")).nudge({
            id,
          }),
        );
        expect(answer).not.toBe("ok");
        expect(
          await db.notification.count({ where: { kind: "proposal.nudge" } }),
        ).toBe(0);
      });

      it("the nudge notice assumes no proposal: a notice with the same key shape and no link counts and lists like any other (A3)", async () => {
        const { notify } = await import("~/server/api/services/notifications");
        const scope = "request.nudge:abc123:2031-08-05";
        const first = await notify(db, {
          recipients: [U.dirA],
          kind: "proposal.nudge",
          title: "A head asked you to look at a request",
          once: scope,
        });
        const second = await notify(db, {
          recipients: [U.dirA],
          kind: "proposal.nudge",
          title: "A head asked you to look at a request",
          once: scope,
        });
        expect(first).toEqual({ written: 1, alreadySent: 0 });
        expect(second).toEqual({ written: 0, alreadySent: 1 });

        const inbox = as(U.dirA) as unknown;
        void inbox;
        const caller = createCaller({
          db: db as never,
          session: {
            user: {
              userID: U.dirA,
              roles: ["resident", "jcrc"],
              eligible: true,
              hasMatric: true,
              credentialsStale: false,
            },
            expires: new Date(Date.now() + 3600_000).toISOString(),
          } as never,
          headers: new Headers({ "x-forwarded-for": "198.51.100.250" }),
        }).notifications;
        expect((await caller.unreadCount()).count).toBe(1);
        const list = await caller.list({});
        expect(list.items).toHaveLength(1);
        expect(list.items[0]?.href ?? null).toBeNull();
      });
    });

    describe("the flag and the limits", () => {
      it("every procedure is refused while proposals are off, and none writes", async () => {
        const id = await stage("in_review");
        await setFlag("proposals.enabled", "off");
        const before = await rowsWritten(id);
        const c = as(U.headA);
        for (const [name, run] of [
          ["list", () => c.commentList({ proposalID: id })],
          ["add", () => c.commentAdd({ proposalID: id, body: "x" })],
          ["markRead", () => c.commentMarkRead({ proposalID: id })],
          ["nudge", () => c.nudge({ id })],
        ] as const) {
          expect(await errorOf(run()), name).toBe(
            "FORBIDDEN:PROPOSALS_DISABLED",
          );
        }
        expect(await rowsWritten(id)).toEqual(before);
      });

      it("every procedure is refused when the flag read fails", async () => {
        const id = await stage("in_review");
        const before = await rowsWritten(id);
        const c = as(U.headA, EVERYTHING, withFailingFlag("proposals.enabled"));
        for (const [name, run] of [
          ["list", () => c.commentList({ proposalID: id })],
          ["add", () => c.commentAdd({ proposalID: id, body: "x" })],
          ["markRead", () => c.commentMarkRead({ proposalID: id })],
          ["nudge", () => c.nudge({ id })],
        ] as const) {
          expect(await errorOf(run()), name).toBe(
            "FORBIDDEN:PROPOSALS_DISABLED",
          );
        }
        expect(await rowsWritten(id)).toEqual(before);
      });

      const seed = (action: string, userID: string, count: number) => {
        const data = { count, expiresAt: new Date(Date.now() + 3_600_000) };
        return db.rateLimit.upsert({
          where: { key: `proposal.${action}:${userID}` },
          create: { key: `proposal.${action}:${userID}`, ...data },
          update: data,
        });
      };

      it("the 121st comment in an hour is refused and writes nothing; another person is not held up", async () => {
        const id = await stage("in_review");
        await seed("comment", U.headA, 120);
        expect(
          await errorOf(as(U.headA).commentAdd({ proposalID: id, body: "x" })),
        ).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
        expect(await rowsWritten(id)).toMatchObject({ comments: 0 });
        expect(
          await errorOf(as(U.headA2).commentAdd({ proposalID: id, body: "x" })),
        ).toBe("ok");
      });

      it("the 31st nudge in an hour is refused and writes nothing", async () => {
        const id = await stage("in_review");
        await seed("nudge", U.headA, 30);
        expect(await errorOf(as(U.headA).nudge({ id }))).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/,
        );
        expect(
          await db.notification.count({ where: { kind: "proposal.nudge" } }),
        ).toBe(0);
      });

      it("a person refused by the access check does not spend or create a counter", async () => {
        const id = await stage("in_review");
        await errorOf(as(U.headB).commentAdd({ proposalID: id, body: "x" }));
        await errorOf(as(U.headB).nudge({ id }));
        expect(
          await db.rateLimit.count({
            where: {
              key: {
                in: [
                  `proposal.comment:${U.headB}`,
                  `proposal.nudge:${U.headB}`,
                ],
              },
            },
          }),
        ).toBe(0);
      });

      it("the 241st mark-read in an hour is refused and writes no marker; another person is not held up (#131)", async () => {
        const id = await stage("in_review");
        await seed("commentRead", U.dirA, 240);
        expect(
          await errorOf(as(U.dirA).commentMarkRead({ proposalID: id })),
        ).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
        expect(
          await db.proposalCommentRead.count({
            where: { proposalID: id, userID: U.dirA },
          }),
        ).toBe(0);
        expect(
          await errorOf(as(U.headA).commentMarkRead({ proposalID: id })),
        ).toBe("ok");
      });

      it("a refused reader does not spend the mark-read budget", async () => {
        const id = await stage("in_review");
        await errorOf(as(U.headB).commentMarkRead({ proposalID: id }));
        expect(
          await db.rateLimit.count({
            where: { key: `proposal.commentRead:${U.headB}` },
          }),
        ).toBe(0);
      });

      it("marking read is not charged to the comment budget", async () => {
        const id = await stage("in_review");
        await as(U.dirA).commentMarkRead({ proposalID: id });
        expect(
          await db.rateLimit.count({
            where: { key: `proposal.comment:${U.dirA}` },
          }),
        ).toBe(0);
        void DAY_MS;
      });
    });
  },
);
