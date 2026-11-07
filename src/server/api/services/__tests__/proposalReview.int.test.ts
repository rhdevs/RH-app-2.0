import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type * as HandoverModule from "../jcrcHandover";
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
import { resetProposalsFlagCache } from "../proposals/flag";

/**
 * INTEGRATION TESTS of the director's review (approve, return, finish), the
 * self-approved label, the notices to heads and the director's home, against
 * the LOCAL development database (skipped unless DATABASE_URL is the local dev
 * database; run `npm run test:db`). Run this file on its own.
 *
 * The tests own every row they touch: users E99907xx, CCAs 9001 to 9003
 * (proposals, heads and positions only; the CCA rows are never written),
 * positions named "TEST ...", every `proposal.*` notice. The three flag rows
 * are put back as they were.
 */

const U = {
  headA: "E9990701", // heads CCA 9001
  headA2: "E9990702", // also heads CCA 9001
  headB: "E9990703", // heads CCA 9002
  headC: "E9990704", // heads CCA 9003, which no flagged position lists
  dirA: "E9990705", // director of 9001
  dirA2: "E9990706", // also director of 9001
  dirB: "E9990707", // director of 9002
  dirHead: "E9990708", // director of 9001 AND head of 9001
  admin: "E9990709", // admin, heads and directs nothing
  jcrc: "E9990710", // jcrc with no position
  unflagged: "E9990711", // jcrc, holds an unflagged position listing 9001
  oversee: "E9990712", // jcrc, holds an overseesAll flagged position listing 9002 only
  scrc: "E9990713",
  hall: "E9990714",
  resident: "E9990715",
};
const IDS = Object.values(U);
const CCA_A = 9001;
const CCA_B = 9002;
const CCA_C = 9003;
const CCAS = [CCA_A, CCA_B, CCA_C];
const FLAGS = [
  "proposals.enabled",
  "directors.enabled",
  "notifications.enabled",
];
/** Session roles that claim every power: the server must not believe them. */
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const ACTIONS = ["approve", "return", "finish"] as const;
type Action = (typeof ACTIONS)[number];
const ALL_ACTIONS = ["create", "update", "submit", "upload", ...ACTIONS];
const NOT_FOUND = "NOT_FOUND:PROPOSAL_NOT_FOUND";
const CHECK_FAILED = "FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED";
const HOUR = 3_600_000;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "proposal review (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let handover: typeof HandoverModule;
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
    type Caller = ReturnType<typeof as>;

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
      // The flag is cached per lambda for a few seconds; a test that flips it
      // expects the next call to see the new value.
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

    const limitKeys = () =>
      ALL_ACTIONS.flatMap((action) =>
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
          OR: [{ userID: { in: IDS } }, { kind: { startsWith: "proposal." } }],
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
      await db.user.deleteMany({ where: { email: { startsWith: "e99907" } } });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
      });

    const makePosition = async (
      name: string,
      ccaIDs: number[],
      holder: string,
      opts: { vets?: boolean; overseesAll?: boolean } = {},
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          overseesAll: opts.overseesAll ?? false,
          vetsProposals: opts.vets ?? true,
        },
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

    /** A database where reading one table fails (outside a transaction). */
    const withFailingRead = (table: string): PrismaClient =>
      proxied(db, (prop) => (prop === table ? failingTable() : undefined));

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
    const withFailingFlag = (key: string): PrismaClient =>
      proxied(db, (prop) =>
        prop === "systemFlag"
          ? {
              findUnique: (args: { where: { key: string } }) =>
                args.where.key === key
                  ? Promise.reject(new Error("db down"))
                  : db.systemFlag.findUnique(args as never),
            }
          : undefined,
      );

    /** Console output from refusals, captured so a test can read the log. */
    const captureErrors = () => {
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      return {
        text: () => spy.mock.calls.map((c) => String(c[0])).join("\n"),
        restore: () => spy.mockRestore(),
      };
    };

    const draftInput = (ccaID = CCA_A) => ({
      ccaID,
      category: "pubs" as const,
      title: "Pub night",
      description: "A night out",
    });

    type Stored = { id: string; version: number };

    /** A proposal in review (or cleared), written through the real procedures. */
    const stage = async (
      to: "in_review" | "cleared",
      creator = U.headA,
      ccaID = CCA_A,
    ): Promise<Stored> => {
      const made = await as(creator).create(draftInput(ccaID));
      const sent = await as(creator).submit({ id: made.id, version: 0 });
      if (to === "in_review") return { id: made.id, version: sent.version };
      const done = await as(U.dirA).approve({
        id: made.id,
        version: sent.version,
      });
      return { id: made.id, version: done.version };
    };

    const stageFor = (action: Action) =>
      stage(action === "finish" ? "cleared" : "in_review");

    const act = (who: Caller, action: Action, p: Stored) =>
      action === "approve"
        ? who.approve(p)
        : action === "return"
          ? who.return({ ...p, reason: "Please add a date" })
          : who.finish(p);

    const snapshot = async (id: string) => ({
      row: await db.proposal.findUnique({ where: { id } }),
      history: await db.proposalStatusHistory.count({
        where: { proposalID: id },
      }),
      audit: await db.roleAuditLog.count({
        where: { action: "proposal.transition", targetCcaID: { in: CCAS } },
      }),
      notices: await db.notification.count({
        where: { kind: { startsWith: "proposal." } },
      }),
      counters: await db.rateLimit.count({
        where: { key: { in: limitKeys() } },
      }),
    });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      handover = await import("../jcrcHandover");
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [
        U.dirA,
        U.dirA2,
        U.dirB,
        U.jcrc,
        U.unflagged,
        U.oversee,
      ]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      await setRoles(U.dirHead, ["resident", "jcrc", "cca_head"]);
      for (const id of [U.headA, U.headA2, U.headB, U.headC]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.scrc, ["resident", "scrc"]);
      await setRoles(U.hall, ["resident", "hall_office"]);
      await setRoles(U.resident, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, CCA_A],
        [U.headA2, CCA_A],
        [U.headB, CCA_B],
        [U.headC, CCA_C],
        [U.dirHead, CCA_A],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Dir A", [CCA_A], U.dirA);
      await makePosition("Dir A2", [CCA_A], U.dirA2);
      await makePosition("Dir B", [CCA_B], U.dirB);
      await makePosition("Dir Head", [CCA_A], U.dirHead);
      await makePosition("Unflagged", [CCA_A], U.unflagged, { vets: false });
      await makePosition("Oversee", [CCA_B], U.oversee, { overseesAll: true });
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("who may act: approve, return and finish each refuse", () => {
      const REFUSED: Array<[string, string]> = [
        ["a JCRC member with no position", U.jcrc],
        ["a holder of an unflagged position", U.unflagged],
        ["an admin", U.admin],
        ["an RF", U.scrc],
        ["a Hall Office member", U.hall],
        ["a head of the CCA who is not a director", U.headA],
        ["a director of another CCA", U.dirB],
        [
          "an overseesAll holder whose flagged position does not list the CCA",
          U.oversee,
        ],
        ["an ordinary resident", U.resident],
      ];

      it.each(ACTIONS)(
        "%s refuses every one of them, whatever the session claims, and writes nothing",
        async (action) => {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          for (const [who, userID] of REFUSED) {
            expect(await errorOf(act(as(userID), action, p)), who).toBe(
              NOT_FOUND,
            );
          }
          expect(await snapshot(p.id)).toEqual(before);
        },
      );

      it.each(ACTIONS)(
        "%s works for a director of the proposal's CCA, even with no session role at all",
        async (action) => {
          const p = await stageFor(action);
          const res = await act(as(U.dirA, ["resident"]), action, p);
          expect(res.status).toBe(
            { approve: "cleared", return: "needs_action", finish: "finished" }[
              action
            ],
          );
          expect(res.version).toBe(p.version + 1);
        },
      );

      it("the CCA asked about is the stored proposal's, not the director's own", async () => {
        const p = await stage("in_review", U.headB, CCA_B);
        // dirA directs 9001 only; the proposal is 9002's.
        expect(await errorOf(as(U.dirA).approve(p))).toBe(NOT_FOUND);
        expect(await errorOf(as(U.dirB).approve(p))).toBe("ok");
      });

      it("a draft is invisible to a director (B19), and a missing id is the same answer", async () => {
        const made = await as(U.headA).create(draftInput());
        for (const action of ACTIONS) {
          expect(
            await errorOf(act(as(U.dirA), action, { id: made.id, version: 0 })),
          ).toBe(NOT_FOUND);
        }
        expect(
          await errorOf(
            as(U.dirA).approve({ id: "0123456789abcdef01234567", version: 0 }),
          ),
        ).toBe(NOT_FOUND);
      });

      it("approve and return run only from in review; finish only from cleared", async () => {
        const review = await stage("in_review");
        const cleared = await stage("cleared");
        expect(await errorOf(as(U.dirA).finish(review))).toBe(
          "CONFLICT:PROPOSAL_CONFLICT",
        );
        expect(await errorOf(as(U.dirA).approve(cleared))).toBe(
          "CONFLICT:PROPOSAL_CONFLICT",
        );
        expect(
          await errorOf(
            as(U.dirA).return({ ...cleared, reason: "Too late to return" }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect((await snapshot(review.id)).row?.status).toBe("in_review");
        expect((await snapshot(cleared.id)).row?.status).toBe("cleared");
      });
    });

    describe("the switches", () => {
      it.each(ACTIONS)(
        "%s is refused while directors.enabled is off or absent",
        async (action) => {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          for (const value of ["off", null, "ON "]) {
            await setFlag("directors.enabled", value);
            expect(await errorOf(act(as(U.dirA), action, p))).toBe(NOT_FOUND);
          }
          expect(await snapshot(p.id)).toEqual(before);
        },
      );

      it.each(ACTIONS)(
        "%s is refused while directors.enabled cannot be read, naming only the error",
        async (action) => {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          const log = captureErrors();
          const answer = await errorOf(
            act(
              as(U.dirA, EVERYTHING, withFailingFlag("directors.enabled")),
              action,
              p,
            ),
          );
          const text = log.text();
          log.restore();
          expect(answer).toBe(CHECK_FAILED);
          expect(text).toContain('"error":"Error"');
          expect(text).not.toContain("db down");
          expect(await snapshot(p.id)).toEqual(before);
        },
      );

      it.each(ACTIONS)(
        "%s is refused while proposals.enabled is off, absent or unreadable",
        async (action) => {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          for (const value of ["off", null]) {
            await setFlag("proposals.enabled", value);
            expect(await errorOf(act(as(U.dirA), action, p))).toBe(
              "FORBIDDEN:PROPOSALS_DISABLED",
            );
          }
          await setFlag("proposals.enabled", "on");
          expect(
            await errorOf(
              act(
                as(U.dirA, EVERYTHING, withFailingFlag("proposals.enabled")),
                action,
                p,
              ),
            ),
          ).toBe("FORBIDDEN:PROPOSALS_DISABLED");
          expect(await snapshot(p.id)).toEqual(before);
        },
      );

      it.each([
        ["userRole"],
        ["jcrcPositionHolder"],
        ["jcrcPosition"],
        ["jcrcPositionCca"],
      ])(
        "a failed %s read refuses all three, writes nothing and logs only the error name",
        async (table) => {
          for (const action of ACTIONS) {
            const p = await stageFor(action);
            const before = await snapshot(p.id);
            const log = captureErrors();
            const answer = await errorOf(
              act(as(U.dirA, EVERYTHING, withFailingRead(table)), action, p),
            );
            const text = log.text();
            log.restore();
            expect(answer, `${action} ${table}`).toBe(CHECK_FAILED);
            expect(text).not.toContain("db down");
            expect(await snapshot(p.id)).toEqual(before);
          }
        },
      );
    });

    describe("A48: the power is read from the rows on every call", () => {
      it("a JcrcTerm that has ended refuses at once, with the holder row untouched", async () => {
        const p = await stage("in_review");
        await db.jcrcTerm.create({
          data: { userID: U.dirA, endsAt: new Date(Date.now() - 1000) },
        });
        expect(await errorOf(as(U.dirA).approve(p))).toBe(NOT_FOUND);
        expect(
          await db.jcrcPositionHolder.count({ where: { userID: U.dirA } }),
        ).toBe(1);
        expect((await snapshot(p.id)).row?.status).toBe("in_review");
      });

      it("the sweep that removes jcrc keeps the refusal", async () => {
        const p = await stage("in_review");
        await db.jcrcTerm.create({
          data: { userID: U.dirA, endsAt: new Date(Date.now() - 1000) },
        });
        await handover.sweepEndedJcrcTerms(db, new Date());
        expect(
          (await db.userRole.findUnique({ where: { userID: U.dirA } }))?.roles,
        ).not.toContain("jcrc");
        expect(await errorOf(as(U.dirA).approve(p))).toBe(NOT_FOUND);
      });

      it("removing jcrc directly refuses at once, and restoring it restores the power", async () => {
        const p = await stage("in_review");
        await db.userRole.update({
          where: { userID: U.dirA },
          data: { roles: ["resident"] },
        });
        expect(await errorOf(as(U.dirA).approve(p))).toBe(NOT_FOUND);
        expect(
          await db.jcrcPositionHolder.count({ where: { userID: U.dirA } }),
        ).toBe(1);
        await db.userRole.update({
          where: { userID: U.dirA },
          data: { roles: ["resident", "jcrc"] },
        });
        expect(await errorOf(as(U.dirA).approve(p))).toBe("ok");
      });

      it("a holder row past its end date gives no power even though jcrc survives", async () => {
        const p = await stage("in_review");
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dirA },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        expect(
          (await db.userRole.findUnique({ where: { userID: U.dirA } }))?.roles,
        ).toContain("jcrc");
        expect(await errorOf(as(U.dirA).approve(p))).toBe(NOT_FOUND);
        // The other director of the CCA is untouched.
        expect(await errorOf(as(U.dirA2).approve(p))).toBe("ok");
      });

      it("removing the holder row refuses at once", async () => {
        const p = await stage("in_review");
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.dirA } });
        expect(await errorOf(as(U.dirA).approve(p))).toBe(NOT_FOUND);
      });
    });

    describe("A64: overseesAll grants no approval", () => {
      it("a flagged overseesAll position that lists no CCA at all is refused for every action", async () => {
        await makePosition("Oversee none", [], U.jcrc, {
          overseesAll: true,
        });
        expect(await as(U.jcrc).directorEntry()).toEqual({ show: false });
        for (const action of ACTIONS) {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          expect(await errorOf(act(as(U.jcrc), action, p)), action).toBe(
            NOT_FOUND,
          );
          expect(await snapshot(p.id)).toEqual(before);
        }
        expect(await errorOf(as(U.jcrc).directorQueue({}))).toBe(
          "FORBIDDEN:NOT_DIRECTOR",
        );
      });
    });

    describe("A5: two directors acting at once", () => {
      /**
       * Both callers load the proposal, and neither goes on until both have
       * (same status, same version), so the status check passes for both and
       * only the compare-and-set can stop the loser.
       */
      const meeting = (n: number) => {
        let here = 0;
        let go!: () => void;
        const gate = new Promise<void>((resolve) => {
          go = resolve;
        });
        return () => {
          here += 1;
          if (here >= n) go();
          return gate;
        };
      };
      const loadsTogether = (wait: () => Promise<void>): PrismaClient =>
        proxied(db, (prop) =>
          prop === "proposal"
            ? new Proxy(db.proposal, {
                get(t, p) {
                  if (p === "findUnique") {
                    return async (args: never) => {
                      const found = await t.findUnique(args);
                      await wait();
                      return found;
                    };
                  }
                  const v = Reflect.get(t, p, t) as unknown;
                  return typeof v === "function"
                    ? (v as (...a: unknown[]) => unknown).bind(t)
                    : v;
                },
              })
            : undefined,
        );

      it("both pass the status check on one version; the compare-and-set stops the loser", async () => {
        for (let round = 0; round < 3; round++) {
          const p = await stage("in_review");
          const wait = meeting(2);
          const results = await Promise.allSettled([
            as(U.dirA, EVERYTHING, loadsTogether(wait)).approve(p),
            as(U.dirA2, EVERYTHING, loadsTogether(wait)).approve(p),
          ]);
          expect(
            results.filter((r) => r.status === "fulfilled"),
            `round ${round}`,
          ).toHaveLength(1);
          const lost = results.filter((r) => r.status === "rejected");
          expect(lost).toHaveLength(1);
          expect(
            lost.map((r) => (r as PromiseRejectedResult).reason as unknown),
          ).toMatchObject([{ message: "PROPOSAL_CONFLICT" }]);
          expect(
            await db.proposalStatusHistory.count({
              where: { proposalID: p.id, toStatus: "cleared" },
            }),
          ).toBe(1);
          expect(
            await db.roleAuditLog.count({
              where: {
                action: "proposal.transition",
                reason: { startsWith: `proposal ${p.id}: in_review` },
              },
            }),
          ).toBe(1);
        }
      });

      it("an approval and a return on one version: one outcome, one history row", async () => {
        const p = await stage("in_review");
        const wait = meeting(2);
        const results = await Promise.allSettled([
          as(U.dirA, EVERYTHING, loadsTogether(wait)).approve(p),
          as(U.dirA2, EVERYTHING, loadsTogether(wait)).return({
            ...p,
            reason: "Needs a date",
          }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          results
            .filter((r) => r.status === "rejected")
            .map((r) => (r as PromiseRejectedResult).reason as unknown),
        ).toMatchObject([{ message: "PROPOSAL_CONFLICT" }]);
        expect(
          await db.proposalStatusHistory.count({
            where: { proposalID: p.id, fromStatus: "in_review" },
          }),
        ).toBe(1);
      });

      it("two approvals: one wins, the other is a CONFLICT, one history row", async () => {
        for (let round = 0; round < 3; round++) {
          const p = await stage("in_review");
          const results = await Promise.allSettled([
            as(U.dirA).approve(p),
            as(U.dirA2).approve(p),
          ]);
          const won = results.filter((r) => r.status === "fulfilled");
          const lost = results.filter((r) => r.status === "rejected");
          expect(won, `round ${round}`).toHaveLength(1);
          expect(lost).toHaveLength(1);
          expect(
            lost.map((r) => (r as PromiseRejectedResult).reason as unknown),
          ).toMatchObject([{ message: "PROPOSAL_CONFLICT" }]);
          expect(
            await db.proposalStatusHistory.count({
              where: { proposalID: p.id, toStatus: "cleared" },
            }),
          ).toBe(1);
          expect(
            await db.proposalStatusHistory.count({
              where: { proposalID: p.id },
            }),
          ).toBe(2);
          expect((await snapshot(p.id)).row).toMatchObject({
            status: "cleared",
            version: p.version + 1,
          });
        }
      });

      it("an approval racing a return leaves exactly one outcome", async () => {
        const p = await stage("in_review");
        const results = await Promise.allSettled([
          as(U.dirA).approve(p),
          as(U.dirA2).return({ ...p, reason: "Needs a date" }),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const row = (await snapshot(p.id)).row;
        expect(["cleared", "needs_action"]).toContain(row?.status);
        expect(
          await db.proposalStatusHistory.count({
            where: { proposalID: p.id, fromStatus: "in_review" },
          }),
        ).toBe(1);
      });

      it("a director holding an old version cannot approve content that came back", async () => {
        const p = await stage("in_review");
        const returned = await as(U.dirA).return({
          ...p,
          reason: "Add a link",
        });
        const edited = await as(U.headA).update({
          id: p.id,
          version: returned.version,
          title: "Pub night, revised",
        });
        const sent = await as(U.headA).submit({
          id: p.id,
          version: edited.version,
        });
        expect(await errorOf(as(U.dirA).approve(p))).toBe(
          "CONFLICT:PROPOSAL_CONFLICT",
        );
        expect(
          await errorOf(
            as(U.dirA).approve({ id: p.id, version: sent.version }),
          ),
        ).toBe("ok");
      });
    });

    describe("what is stored: notes, reasons, approver and the self-approved label", () => {
      const clearedRow = (id: string) =>
        db.proposalStatusHistory.findFirst({
          where: { proposalID: id, toStatus: "cleared" },
        });

      it("an approval stores the approver and the note; a blank note is null", async () => {
        const a = await stage("in_review");
        await as(U.dirA).approve({ ...a, note: "  Looks good  " });
        expect(await clearedRow(a.id)).toMatchObject({
          fromStatus: "in_review",
          actorID: U.dirA,
          approverID: U.dirA,
          selfApproved: false,
          note: "Looks good",
        });
        const b = await stage("in_review");
        await as(U.dirA).approve({ ...b, note: "   " });
        expect((await clearedRow(b.id))?.note).toBeNull();
        const c = await stage("in_review");
        await as(U.dirA).approve(c);
        expect((await clearedRow(c.id))?.note).toBeNull();
      });

      it("a return needs a reason, stores it, and leaves approver and label empty", async () => {
        const p = await stage("in_review");
        for (const reason of ["", "   "]) {
          expect(await errorOf(as(U.dirA).return({ ...p, reason }))).toMatch(
            /^BAD_REQUEST:/,
          );
        }
        expect(
          await errorOf(as(U.dirA).return({ ...p, reason: "x".repeat(501) })),
        ).toMatch(/^BAD_REQUEST:/);
        await as(U.dirA).return({ ...p, reason: "  Add the venue  " });
        expect(
          await db.proposalStatusHistory.findFirst({
            where: { proposalID: p.id, toStatus: "needs_action" },
          }),
        ).toMatchObject({
          actorID: U.dirA,
          approverID: null,
          selfApproved: false,
          note: "Add the venue",
        });
      });

      it("a finish records the actor and no approver", async () => {
        const p = await stage("cleared");
        await as(U.dirA).finish(p);
        expect(
          await db.proposalStatusHistory.findFirst({
            where: { proposalID: p.id, toStatus: "finished" },
          }),
        ).toMatchObject({
          fromStatus: "cleared",
          actorID: U.dirA,
          approverID: null,
          selfApproved: false,
        });
      });

      it("the label is false for a director who is neither the author nor a head", async () => {
        const p = await stage("cleared");
        expect((await clearedRow(p.id))?.selfApproved).toBe(false);
      });

      it("the label is true when the approver heads the CCA (not the author)", async () => {
        const p = await stage("in_review"); // written by headA
        await as(U.dirHead).approve(p);
        expect(await clearedRow(p.id)).toMatchObject({
          approverID: U.dirHead,
          selfApproved: true,
        });
      });

      it("the label is true when a director approves their own proposal", async () => {
        const p = await stage("in_review", U.dirHead);
        await as(U.dirHead).approve(p);
        expect(await clearedRow(p.id)).toMatchObject({
          approverID: U.dirHead,
          selfApproved: true,
        });
      });

      it("the label is true for the author even after they stopped heading the CCA", async () => {
        const p = await stage("in_review", U.dirHead);
        await db.ccaHead.deleteMany({ where: { userID: U.dirHead } });
        await as(U.dirHead).approve(p);
        expect((await clearedRow(p.id))?.selfApproved).toBe(true);
      });

      it("a deleted creator (createdBy null) is not the approver; the head test still decides", async () => {
        const p = await stage("in_review");
        await db.proposal.update({
          where: { id: p.id },
          data: { createdBy: null },
        });
        await as(U.dirA).approve(p);
        expect(await clearedRow(p.id)).toMatchObject({
          approverID: U.dirA,
          selfApproved: false,
        });

        const q = await stage("in_review");
        await db.proposal.update({
          where: { id: q.id },
          data: { createdBy: null },
        });
        await as(U.dirHead).approve(q);
        expect(await clearedRow(q.id)).toMatchObject({
          approverID: U.dirHead,
          selfApproved: true,
        });
      });

      it("the label is not taken from the request", async () => {
        const p = await stage("in_review");
        await as(U.dirA).approve({
          ...p,
          selfApproved: true,
          approverID: U.headA,
        } as never);
        expect(await clearedRow(p.id)).toMatchObject({
          approverID: U.dirA,
          selfApproved: false,
        });
      });

      it("a failed read of the label refuses the approval and rolls everything back", async () => {
        const p = await stage("in_review");
        const before = await snapshot(p.id);
        const log = captureErrors();
        const answer = await errorOf(
          as(U.dirA, EVERYTHING, withFailingTxRead("ccaHead")).approve(p),
        );
        const text = log.text();
        log.restore();
        expect(answer).toBe(CHECK_FAILED);
        expect(text).not.toContain("db down");
        const after = await snapshot(p.id);
        // The budget counter is spent by the attempt; nothing else moved.
        expect({ ...after, counters: 0 }).toEqual({ ...before, counters: 0 });
        expect(after.row?.status).toBe("in_review");
        // And the director can approve once the read works.
        expect(await errorOf(as(U.dirA).approve(p))).toBe("ok");
      });

      it("the proposal page shows the approver's name and the label, and no id", async () => {
        await db.user.create({
          data: {
            email: "e9990708@u.nus.edu",
            userID: U.dirHead,
            displayName: "Dana Director",
          },
        });
        const p = await stage("in_review");
        await as(U.dirHead).approve(p);
        const seen = await as(U.headA).get({ id: p.id });
        const row = seen.history.find((h) => h.toStatus === "cleared");
        expect(row).toMatchObject({
          selfApproved: true,
          approverName: "Dana Director",
        });
        expect(JSON.stringify(seen)).not.toContain(U.dirHead);
        expect(JSON.stringify(seen)).not.toContain("e9990708");
        // A different approver with no name on file has no name, not an id.
        const q = await stage("in_review");
        await as(U.dirA).approve(q);
        const other = await as(U.headA).get({ id: q.id });
        expect(
          other.history.find((h) => h.toStatus === "cleared")?.approverName,
        ).toBeNull();
      });
    });

    describe("the director's view of one proposal", () => {
      it("shows the actions the status allows, to directors only", async () => {
        const p = await stage("in_review");
        expect((await as(U.dirA).get({ id: p.id })).reviewActions).toEqual([
          "approve",
          "return",
        ]);
        expect((await as(U.headA).get({ id: p.id })).reviewActions).toEqual([]);
        // A head who is also a director sees them too.
        const both = await as(U.dirHead).get({ id: p.id });
        expect(both).toMatchObject({ viewer: "head", canEdit: false });
        expect(both.reviewActions).toEqual(["approve", "return"]);

        await as(U.dirA).approve(p);
        expect((await as(U.dirA).get({ id: p.id })).reviewActions).toEqual([
          "finish",
        ]);
      });

      it("carries the CCA's name, the poster and the link fields, and refuses outsiders", async () => {
        const p = await stage("in_review");
        const seen = await as(U.dirA).get({ id: p.id });
        expect(seen).toHaveProperty("ccaName");
        expect(seen).toHaveProperty("posterUrl");
        expect(seen).toHaveProperty("docLink");
        for (const userID of [U.admin, U.jcrc, U.dirB, U.oversee, U.scrc]) {
          expect(await errorOf(as(userID).get({ id: p.id }))).toBe(NOT_FOUND);
        }
        const draft = await as(U.headA).create(draftInput());
        expect(await errorOf(as(U.dirA).get({ id: draft.id }))).toBe(NOT_FOUND);
      });

      it("a returned proposal can be edited and resubmitted after a real return", async () => {
        const p = await stage("in_review");
        const returned = await as(U.dirA).return({
          ...p,
          reason: "Please add a date",
        });
        const seen = await as(U.headA).get({ id: p.id });
        expect(seen).toMatchObject({
          status: "needs_action",
          canEdit: true,
          reviewActions: [],
        });
        expect(
          seen.history.find((h) => h.toStatus === "needs_action")?.note,
        ).toBe("Please add a date");
        const edited = await as(U.headA).update({
          id: p.id,
          version: returned.version,
          plannedStart: 1_900_000_000,
          plannedEnd: 1_900_003_600,
        });
        const sent = await as(U.headA).submit({
          id: p.id,
          version: edited.version,
        });
        expect(sent.status).toBe("in_review");
        // The director sees it in the queue again.
        const queue = await as(U.dirA).directorQueue({});
        expect(queue.items.map((i) => i.id)).toContain(p.id);
      });
    });

    describe("notices to the head, in the same transaction", () => {
      const noticesOf = (id: string) =>
        db.notification.findMany({
          // Only this test's people: the development database may hold other
          // heads of these CCAs, who are rightly notified too.
          where: { href: { contains: id }, userID: { in: IDS } },
          orderBy: { createdAt: "asc" },
        });

      it("approve, return and finish each notify the CCA's heads and not the actor", async () => {
        const a = await stage("in_review");
        await db.notification.deleteMany({ where: {} });
        await as(U.dirHead).approve({ ...a, note: "Go ahead" });
        const approved = (await noticesOf(a.id)).filter(
          (n) => n.kind === "proposal.approved",
        );
        // The heads and the other directors hear; dirHead, who acted, does not.
        expect(approved.map((n) => n.userID).sort()).toEqual(
          [U.headA, U.headA2, U.dirA, U.dirA2].sort(),
        );
        const headsNotice = approved.find((n) => n.userID === U.headA);
        expect(headsNotice?.href).toBe(`/cca/${CCA_A}/proposals/${a.id}`);
        expect(headsNotice?.body).toContain("Go ahead");

        const b = await stage("in_review");
        await as(U.dirA).return({ ...b, reason: "Add the venue" });
        const returned = (await noticesOf(b.id)).filter(
          (n) => n.kind === "proposal.returned",
        );
        expect(returned.map((n) => n.userID).sort()).toEqual(
          [U.headA, U.headA2, U.dirHead, U.dirA2].sort(),
        );
        expect(returned.find((n) => n.userID === U.headA)?.body).toContain(
          "Add the venue",
        );

        const c = await stage("cleared");
        await as(U.dirA).finish(c);
        const finished = (await noticesOf(c.id)).filter(
          (n) => n.kind === "proposal.finished",
        );
        // headA, headA2 and dirHead (a head), plus the other director dirA2.
        expect(finished.map((n) => n.userID).sort()).toEqual(
          [U.headA, U.headA2, U.dirHead, U.dirA2].sort(),
        );
      });

      it("the other directors hear the outcome, the actor does not, and the private note stays out", async () => {
        const a = await stage("in_review");
        await db.notification.deleteMany({ where: {} });
        await as(U.dirA).approve({ ...a, note: "Private word for the head" });
        const heard = await noticesOf(a.id);
        const coDirectors = heard.filter((n) => n.userID === U.dirA2);
        expect(coDirectors).toHaveLength(1);
        expect(coDirectors[0]).toMatchObject({
          kind: "proposal.approved",
          href: `/director/proposals/${a.id}`,
        });
        expect(coDirectors[0]?.body).not.toContain("Private word");
        expect(coDirectors[0]?.href).not.toMatch(/^\/cca/);
        expect(heard.map((n) => n.userID)).not.toContain(U.dirA);
        // A person who is head AND director hears once, with the head's notice.
        const both = heard.filter((n) => n.userID === U.dirHead);
        expect(both).toHaveLength(1);
        expect(both[0]?.href).toBe(`/cca/${CCA_A}/proposals/${a.id}`);
        expect(both[0]?.body).toContain("Private word");
        // A director of another CCA hears nothing.
        expect(heard.map((n) => n.userID)).not.toContain(U.dirB);

        // A self-approving director/head still tells the other directors.
        const b = await stage("in_review", U.dirHead);
        await as(U.dirHead).approve(b);
        const mine = (await noticesOf(b.id)).filter(
          (n) => n.kind === "proposal.approved",
        );
        expect(mine.map((n) => n.userID)).not.toContain(U.dirHead);
        expect(mine.map((n) => n.userID)).toContain(U.dirA);
        expect(mine.map((n) => n.userID)).toContain(U.dirA2);

        const c = await stage("in_review");
        await as(U.dirA).return({ ...c, reason: "Private reason" });
        const back = (await noticesOf(c.id)).filter(
          (n) => n.kind === "proposal.returned" && n.userID === U.dirA2,
        );
        expect(back).toHaveLength(1);
        expect(back[0]?.body).not.toContain("Private reason");
      });

      it.each(ACTIONS)(
        "%s rolls back when the directors to tell cannot be read",
        async (action) => {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          const log = captureErrors();
          const answer = await errorOf(
            act(
              as(U.dirA, EVERYTHING, withFailingTxRead("jcrcPositionCca")),
              action,
              p,
            ),
          );
          const text = log.text();
          log.restore();
          expect(answer).toBe(CHECK_FAILED);
          expect(text).not.toContain("db down");
          // The hourly budget is spent before the move, so ignore the counter.
          expect({ ...(await snapshot(p.id)), counters: 0 }).toEqual({
            ...before,
            counters: 0,
          });
          expect(await errorOf(act(as(U.dirA), action, p))).toBe("ok");
        },
      );

      it("the notice to a director points at the director's route, never at /cca", async () => {
        const made = await as(U.headA).create(draftInput());
        await as(U.headA).submit({ id: made.id, version: 0 });
        const notices = await db.notification.findMany({
          where: { kind: "proposal.submitted" },
        });
        expect(notices.length).toBeGreaterThan(0);
        for (const n of notices) {
          expect(n.href).toBe(`/director/proposals/${made.id}`);
          expect(n.href).not.toMatch(/^\/cca/);
        }
      });

      it.each(ACTIONS)(
        "%s rolls back completely when its notice cannot be written",
        async (action) => {
          const p = await stageFor(action);
          const before = await snapshot(p.id);
          const answer = await errorOf(
            act(as(U.dirA, EVERYTHING, withFailingNotices()), action, p),
          );
          expect(answer).toMatch(/^INTERNAL_SERVER_ERROR:/);
          expect(answer).not.toContain("boom");
          const after = await snapshot(p.id);
          expect({ ...after, counters: 0 }).toEqual({
            ...before,
            counters: 0,
          });
          // Nothing moved, so the same call works once notices work.
          expect(await errorOf(act(as(U.dirA), action, p))).toBe("ok");
        },
      );

      it("moves the proposal without notices while notifications are off", async () => {
        await setFlag("notifications.enabled", "off");
        const p = await stage("in_review");
        await as(U.dirA).approve(p);
        expect((await snapshot(p.id)).row?.status).toBe("cleared");
        expect(
          await db.notification.count({
            where: { kind: { startsWith: "proposal." } },
          }),
        ).toBe(0);
      });
    });

    describe("rate limits", () => {
      it("a refused person writes no counter, and a working director is not bothered", async () => {
        const p = await stage("in_review");
        const before = await snapshot(p.id);
        await errorOf(as(U.admin).approve(p));
        await errorOf(as(U.dirB).return({ ...p, reason: "no" }));
        expect((await snapshot(p.id)).counters).toBe(before.counters);

        // A day of real use: many reviews in a row.
        for (let i = 0; i < 6; i++) {
          const q = await stage("in_review");
          await as(U.dirA).approve(q);
          await as(U.dirA).finish({ id: q.id, version: q.version + 1 });
        }
      });

      it("approve stops at the hourly ceiling, spent after the guard", async () => {
        const p = await stage("in_review");
        const stale = { id: p.id, version: p.version + 5 };
        let spent = 0;
        // The stage's own approvals are not in play: dirA2 has a clean budget.
        for (; spent < 60; spent++) {
          const answer = await errorOf(as(U.dirA2).approve(stale));
          if (answer !== "CONFLICT:PROPOSAL_CONFLICT") {
            throw new Error(`call ${spent}: ${answer}`);
          }
        }
        expect(await errorOf(as(U.dirA2).approve(stale))).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:/,
        );
        // Another director is not held up by it.
        expect(await errorOf(as(U.dirA).approve(p))).toBe("ok");
      });
    });

    describe("the director's home and queue", () => {
      type Seeded = { a1: Stored; a2: string; b1: Stored; c1: Stored };
      const seed = async (): Promise<Seeded> => {
        const a1 = await stage("in_review");
        const a2 = (await as(U.headA).create(draftInput())).id; // a draft
        const b1 = await stage("in_review", U.headB, CCA_B);
        const c1 = await stage("in_review", U.headC, CCA_C);
        return { a1, a2, b1, c1 };
      };

      it("each director sees only the submitted proposals of the CCAs they direct now", async () => {
        const s = await seed();
        const ids = async (u: string) =>
          (await as(u).directorQueue({})).items.map((i) => i.id).sort();
        expect(await ids(U.dirA)).toEqual([s.a1.id]);
        expect(await ids(U.dirA2)).toEqual([s.a1.id]);
        expect(await ids(U.dirHead)).toEqual([s.a1.id]);
        expect(await ids(U.dirB)).toEqual([s.b1.id]);
        // The draft and the unlisted CCA's proposal are in nobody's queue.
        for (const u of [U.dirA, U.dirB, U.oversee]) {
          const all = await ids(u);
          expect(all).not.toContain(s.a2);
          expect(all).not.toContain(s.c1.id);
        }
        // The overseesAll holder sees only the CCA the position lists.
        expect(await ids(U.oversee)).toEqual([s.b1.id]);
      });

      it("counts by status exclude drafts and other CCAs, and follow the work", async () => {
        const s = await seed();
        const zero = {
          in_review: 0,
          needs_action: 0,
          cleared: 0,
          finished: 0,
          canceled: 0,
        };
        expect((await as(U.dirA).directorHome()).counts).toEqual({
          ...zero,
          in_review: 1,
        });
        await as(U.dirA).approve(s.a1);
        expect((await as(U.dirA).directorHome()).counts).toEqual({
          ...zero,
          cleared: 1,
        });
        expect((await as(U.dirA).directorQueue({})).items).toEqual([]);
        await as(U.dirA).finish({ id: s.a1.id, version: s.a1.version + 1 });
        expect((await as(U.dirA).directorHome()).counts).toMatchObject({
          cleared: 0,
          finished: 1,
        });
        expect((await as(U.dirB).directorHome()).counts.in_review).toBe(1);
      });

      it("lists the CCAs the director vets and who heads them, with names and no ids", async () => {
        await db.user.create({
          data: {
            email: "e9990701@u.nus.edu",
            userID: U.headA,
            displayName: "Hana Head",
          },
        });
        await seed();
        const home = await as(U.dirA).directorHome();
        expect(home.ccas.map((c) => c.ccaID)).toEqual([CCA_A]);
        // The three made here, plus any other head the database holds.
        expect(home.ccas[0]?.heads.length).toBeGreaterThanOrEqual(3);
        expect(home.ccas[0]?.heads).toContain("Hana Head");
        expect(home.ccas[0]?.heads).toContain("A head with no name on file");
        const text = JSON.stringify(home);
        for (const id of IDS) expect(text).not.toContain(id);
        expect(text).not.toContain("e9990701");
      });

      it.each([
        ["an admin", U.admin],
        ["a JCRC member with no position", U.jcrc],
        ["a holder of an unflagged position", U.unflagged],
        ["an RF", U.scrc],
        ["a Hall Office member", U.hall],
        ["a head who is not a director", U.headA],
        ["a resident", U.resident],
      ])("%s sees none of it", async (_who, userID) => {
        await seed();
        expect(await errorOf(as(userID).directorHome())).toBe(
          "FORBIDDEN:NOT_DIRECTOR",
        );
        expect(await errorOf(as(userID).directorQueue({}))).toBe(
          "FORBIDDEN:NOT_DIRECTOR",
        );
      });

      it("an admin who is also a director sees the director's CCAs only", async () => {
        const s = await seed();
        await db.userRole.update({
          where: { userID: U.dirA },
          data: { roles: ["resident", "jcrc", "admin"] },
        });
        const queue = await as(U.dirA, ["resident", "admin"]).directorQueue({});
        expect(queue.items.map((i) => i.id)).toEqual([s.a1.id]);
      });

      it("refuses while a switch is off, and says so when a read fails (never an empty queue)", async () => {
        await seed();
        await setFlag("directors.enabled", "off");
        expect(await errorOf(as(U.dirA).directorQueue({}))).toBe(
          "FORBIDDEN:NOT_DIRECTOR",
        );
        await setFlag("directors.enabled", "on");
        await setFlag("proposals.enabled", "off");
        expect(await errorOf(as(U.dirA).directorHome())).toBe(
          "FORBIDDEN:PROPOSALS_DISABLED",
        );
        await setFlag("proposals.enabled", "on");
        const log = captureErrors();
        for (const table of ["userRole", "jcrcPositionHolder"]) {
          const failing = withFailingRead(table);
          expect(
            await errorOf(as(U.dirA, EVERYTHING, failing).directorQueue({})),
          ).toBe(CHECK_FAILED);
          expect(
            await errorOf(as(U.dirA, EVERYTHING, failing).directorHome()),
          ).toBe(CHECK_FAILED);
        }
        const text = log.text();
        log.restore();
        expect(text).not.toContain("db down");
      });

      it("pages oldest first, 50 at a time, and no row drops off", async () => {
        const b1 = await stage("in_review", U.headB, CCA_B);
        const old = Date.now() - 10 * HOUR;
        await db.proposal.createMany({
          data: Array.from({ length: 50 }, (_, i) => ({
            ccaID: CCA_B,
            createdBy: U.headB,
            category: "pubs",
            title: `Backlog ${i}`,
            description: "x",
            blastMessage: null,
            plannedStart: null,
            plannedEnd: null,
            posterUrl: null,
            docLink: null,
            status: "in_review",
            version: 1,
            eventID: null,
            submittedAt: new Date(old + i * 1000),
          })),
        });
        const first = await as(U.dirB).directorQueue({});
        expect(first.items).toHaveLength(50);
        expect(first.nextCursor).not.toBeNull();
        expect(first.items[0]?.title).toBe("Backlog 0");
        const second = await as(U.dirB).directorQueue({
          cursor: first.nextCursor!,
        });
        expect(second.items.map((i) => i.id)).toEqual([b1.id]);
        expect(second.nextCursor).toBeNull();
        const all = [...first.items, ...second.items].map((i) => i.id);
        expect(new Set(all).size).toBe(51);
      });
    });

    describe("a queue cursor whose row changed", () => {
      it("carries on past a row that has left review, and drops no other row", async () => {
        const b1 = await stage("in_review", U.headB, CCA_B);
        const old = Date.now() - 10 * HOUR;
        await db.proposal.createMany({
          data: Array.from({ length: 50 }, (_, i) => ({
            ccaID: CCA_B,
            createdBy: U.headB,
            category: "pubs",
            title: `Backlog ${i}`,
            description: "x",
            blastMessage: null,
            plannedStart: null,
            plannedEnd: null,
            posterUrl: null,
            docLink: null,
            status: "in_review",
            version: 1,
            eventID: null,
            submittedAt: new Date(old + i * 1000),
          })),
        });
        const first = await as(U.dirB).directorQueue({});
        // The cursor is the position of the page's LAST row, not a row of the
        // next page to be found again.
        expect(first.nextCursor).toMatch(/^[0-9]+_[a-f0-9]{24}$/);
        expect(first.nextCursor).not.toBe(b1.id);
        const lastShown = first.items[first.items.length - 1]!;
        expect(first.nextCursor!.endsWith(`_${lastShown.id}`)).toBe(true);
        // The row the cursor stands on leaves review before "Show more".
        await db.proposal.update({
          where: { id: lastShown.id },
          data: { status: "approved" },
        });
        const second = await as(U.dirB).directorQueue({
          cursor: first.nextCursor!,
        });
        // The page after it is still there, whole, and nothing repeats.
        expect(second.items.map((i) => i.id)).toEqual([b1.id]);
        const seen = new Set(first.items.map((i) => i.id));
        for (const i of second.items) expect(seen.has(i.id)).toBe(false);
        expect(second.nextCursor).toBeNull();
      });

      it("pages rows that share one submission time without a repeat or a gap", async () => {
        const same = new Date(Date.now() - 10 * HOUR);
        await db.proposal.createMany({
          data: Array.from({ length: 53 }, (_, i) => ({
            ccaID: CCA_B,
            createdBy: U.headB,
            category: "pubs",
            title: `Tie ${i}`,
            description: "x",
            blastMessage: null,
            plannedStart: null,
            plannedEnd: null,
            posterUrl: null,
            docLink: null,
            status: "in_review",
            version: 1,
            eventID: null,
            submittedAt: same,
          })),
        });
        const first = await as(U.dirB).directorQueue({});
        expect(first.items).toHaveLength(50);
        const second = await as(U.dirB).directorQueue({
          cursor: first.nextCursor!,
        });
        expect(second.items).toHaveLength(3);
        expect(second.nextCursor).toBeNull();
        const all = [...first.items, ...second.items].map((i) => i.id);
        expect(new Set(all).size).toBe(53);
        const ids = [...all];
        expect(ids).toEqual([...ids].sort());
      });

      it("refuses a cursor that is not one of ours", async () => {
        expect(
          await errorOf(
            as(U.dirB).directorQueue({ cursor: "not-a-cursor" } as never),
          ),
        ).toMatch(/^BAD_REQUEST/);
      });
    });

    describe("the navigation entry", () => {
      it("shows for a director of at least one CCA and for no one else", async () => {
        for (const u of [U.dirA, U.dirA2, U.dirB, U.dirHead, U.oversee]) {
          expect(await as(u).directorEntry()).toEqual({ show: true });
        }
        for (const u of [
          U.admin,
          U.jcrc,
          U.unflagged,
          U.scrc,
          U.hall,
          U.headA,
          U.resident,
        ]) {
          expect(await as(u).directorEntry()).toEqual({ show: false });
        }
      });

      it("is hidden while either switch is off", async () => {
        await setFlag("directors.enabled", "off");
        expect(await as(U.dirA).directorEntry()).toEqual({ show: false });
        await setFlag("directors.enabled", "on");
        await setFlag("proposals.enabled", null);
        expect(await as(U.dirA).directorEntry()).toEqual({ show: false });
      });

      it("a failed guard read is an error, not a quiet false", async () => {
        const log = captureErrors();
        const answer = await errorOf(
          as(
            U.dirA,
            EVERYTHING,
            withFailingRead("jcrcPositionHolder"),
          ).directorEntry(),
        );
        const text = log.text();
        log.restore();
        expect(answer).toBe(CHECK_FAILED);
        expect(text).not.toContain("db down");
      });

      it("follows the rows: a removed holder loses the entry at once", async () => {
        expect(await as(U.dirA).directorEntry()).toEqual({ show: true });
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.dirA } });
        expect(await as(U.dirA).directorEntry()).toEqual({ show: false });
      });
    });
  },
);
