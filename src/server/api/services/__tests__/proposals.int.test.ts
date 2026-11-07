import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type * as TransitionModule from "../proposals/transition";
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
 * INTEGRATION TESTS of the proposal core against the LOCAL development
 * database (skipped unless DATABASE_URL is the local dev database; run
 * `npm run test:db`). The tests own every row they touch: users E99906xx,
 * CCAs 9001 to 9003 (proposals, heads and positions only; the CCA rows are
 * never written), positions named "TEST ...", every `proposal.*` notice. The
 * three flag rows are put back as they were.
 */

const U = {
  headA: "E9990601", // heads CCA 9001
  headA2: "E9990602", // also heads CCA 9001
  headB: "E9990603", // heads CCA 9002
  headC: "E9990604", // heads CCA 9003, which no flagged position lists
  dirA: "E9990605", // director of 9001
  dirB: "E9990606", // director of 9002
  admin: "E9990607", // admin, heads and directs nothing
  jcrc: "E9990608", // jcrc with no position, heads nothing
  scrc: "E9990609",
  hall: "E9990610",
  resident: "E9990611",
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
const START = 1_900_000_000;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "proposals (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let transition: typeof TransitionModule;
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
          "x-forwarded-for": `203.0.113.${(ipCounter += 1)}`,
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

    /** The rate-limit counters these test users could have left behind. */
    const limitKeys = () =>
      (
        [
          "create",
          "update",
          "submit",
          "upload",
          "approve",
          "return",
          "finish",
        ] as const
      ).flatMap((action) => IDS.map((id) => `proposal.${action}:${id}`));

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
      await db.userRole.deleteMany({ where: { userID: { in: [...IDS, ""] } } });
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
      await db.user.deleteMany({ where: { email: { startsWith: "e99906" } } });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: {
          userID,
          roles,
          updatedAt: new Date(),
          updatedBy: "test",
        },
      });

    const makeDirectorPosition = async (
      name: string,
      ccaIDs: number[],
      holder: string,
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          overseesAll: false,
          vetsProposals: true,
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

    /** A database whose notices cannot be written. */
    const withFailingNotices = (): PrismaClient =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === "$transaction") {
            return (fn: (tx: unknown) => Promise<unknown>, opts?: never) =>
              target.$transaction(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, p) {
                        if (p === "notification") {
                          return {
                            createMany: () => Promise.reject(new Error("boom")),
                          };
                        }
                        return Reflect.get(t, p) as unknown;
                      },
                    }),
                  ),
                opts,
              );
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });

    /** A database where reading one table fails. */
    const withFailingRead = (table: string): PrismaClient =>
      new Proxy(db, {
        get(target, prop) {
          if (prop === table) {
            return {
              findFirst: () => Promise.reject(new Error("db down")),
              findMany: () => Promise.reject(new Error("db down")),
              findUnique: () => Promise.reject(new Error("db down")),
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      });

    const draftInput = (ccaID = CCA_A, over: Record<string, unknown> = {}) => ({
      ccaID,
      category: "pubs" as const,
      title: "Pub night",
      description: "A night out",
      ...over,
    });

    /** A complete draft by headA on CCA 9001. */
    const makeDraft = async (over: Record<string, unknown> = {}) => {
      const made = await as(U.headA).create(draftInput(CCA_A, over));
      return made;
    };

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
    });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      transition = await import("../proposals/transition");
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.dirA, U.dirB, U.jcrc]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
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
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makeDirectorPosition("Dir A", [CCA_A], U.dirA);
      await makeDirectorPosition("Dir B", [CCA_B], U.dirB);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("drafts", () => {
      it("a head creates, edits and reads a draft; the row has explicit nulls and the default status", async () => {
        const made = await makeDraft();

        const row = await db.proposal.findUnique({ where: { id: made.id } });
        expect(row).toMatchObject({
          ccaID: CCA_A,
          createdBy: U.headA,
          status: "draft",
          version: 0,
          eventID: null,
          submittedAt: null,
          blastMessage: null,
          plannedStart: null,
          plannedEnd: null,
        });
        // A stored null, not a missing key: the filter must find it.
        expect(
          await db.proposal.count({
            where: { id: made.id, eventID: null, submittedAt: null },
          }),
        ).toBe(1);

        const edited = await as(U.headA2).update({
          id: made.id,
          version: 0,
          title: "  New title  ",
          blastMessage: "Come along",
          plannedStart: START,
          plannedEnd: START + 3600,
        });
        expect(edited.version).toBe(1);

        const seen = await as(U.headA).get({ id: made.id });
        expect(seen).toMatchObject({
          title: "New title",
          blastMessage: "Come along",
          status: "draft",
          version: 1,
          viewer: "head",
          canEdit: true,
          createdByMe: true,
        });
        expect(seen.history).toEqual([]);
        // Nothing in the answer names a person.
        expect(JSON.stringify(seen)).not.toContain(U.headA);

        const list = await as(U.headA2).list({ ccaID: CCA_A });
        expect(list.items.map((i) => i.id)).toEqual([made.id]);
        expect(list.items[0]).not.toHaveProperty("description");
      });

      it("an edit with a stale version, or after submit, is a CONFLICT and changes nothing", async () => {
        const made = await makeDraft();
        await as(U.headA).update({ id: made.id, version: 0, title: "One" });

        expect(
          await errorOf(
            as(U.headA).update({ id: made.id, version: 0, title: "Two" }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect(
          (await db.proposal.findUnique({ where: { id: made.id } }))?.title,
        ).toBe("One");

        await as(U.headA).submit({ id: made.id, version: 1 });
        expect(
          await errorOf(
            as(U.headA).update({ id: made.id, version: 2, title: "Three" }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
      });

      it("refuses an end that is not after the stored start", async () => {
        const made = await makeDraft({ plannedStart: START });
        expect(
          await errorOf(
            as(U.headA).update({
              id: made.id,
              version: 0,
              plannedEnd: START - 10,
            }),
          ),
        ).toBe("BAD_REQUEST:END_NOT_AFTER_START");
        expect(
          await errorOf(as(U.headA).update({ id: made.id, version: 0 })),
        ).toBe("BAD_REQUEST:NOTHING_TO_UPDATE");
      });

      it("a returned proposal can be edited and resubmitted", async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        await transition.transitionProposal(db, {
          proposalID: made.id,
          from: "in_review",
          to: "needs_action",
          actorID: U.dirA,
        });

        const seen = await as(U.headA).get({ id: made.id });
        expect(seen).toMatchObject({ status: "needs_action", canEdit: true });
        await as(U.headA).update({
          id: made.id,
          version: seen.version,
          title: "Fixed",
        });
        await as(U.headA).submit({ id: made.id, version: seen.version + 1 });
        expect(
          (await db.proposal.findUnique({ where: { id: made.id } }))?.status,
        ).toBe("in_review");
      });
    });

    describe("who may do what, per procedure (cross-CCA and role refusals)", () => {
      // Every caller below sends session roles that claim every power. The
      // answer must come from the stored rows.
      it("a head of ANOTHER CCA is refused on every procedure", async () => {
        const made = await makeDraft();
        const other = as(U.headB);
        const before = await snapshot(made.id);

        const answers = await Promise.all([
          errorOf(other.create(draftInput(CCA_A))),
          errorOf(other.update({ id: made.id, version: 0, title: "x" })),
          errorOf(other.get({ id: made.id })),
          errorOf(other.list({ ccaID: CCA_A })),
          errorOf(other.submit({ id: made.id, version: 0 })),
        ]);

        // Calls that start from a CCA id say FORBIDDEN. Calls that start from
        // a proposal id say the same NOT_FOUND as a missing id (see below).
        expect(answers).toEqual([
          "FORBIDDEN:NOT_CCA_HEAD",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "FORBIDDEN:NOT_PROPOSAL_READER",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        ]);
        expect(await snapshot(made.id)).toEqual(before);
      });

      it("another CCA's proposal id and a missing id get the identical answer on get, update and submit", async () => {
        const made = await makeDraft();
        const other = as(U.headB);
        const missing = "0123456789abcdef01234567";

        const probe = (id: string) =>
          Promise.all([
            errorOf(other.get({ id })),
            errorOf(other.update({ id, version: 0, title: "x" })),
            errorOf(other.submit({ id, version: 0 })),
          ]);

        const theirs = await probe(made.id);
        const gone = await probe(missing);
        expect(theirs).toEqual(gone);
        expect(theirs).toEqual([
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        ]);
      });

      it("a director of ANOTHER CCA is refused on every procedure", async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        const other = as(U.dirB);

        const answers = await Promise.all([
          errorOf(other.create(draftInput(CCA_A))),
          errorOf(other.update({ id: made.id, version: 1, title: "x" })),
          errorOf(other.get({ id: made.id })),
          errorOf(other.list({ ccaID: CCA_A })),
          errorOf(other.submit({ id: made.id, version: 1 })),
        ]);

        expect(answers).toEqual([
          "FORBIDDEN:NOT_CCA_HEAD",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "FORBIDDEN:NOT_PROPOSAL_READER",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        ]);
      });

      it.each([
        ["an admin who is neither", U.admin],
        ["a JCRC member with no position", U.jcrc],
        ["an RF", U.scrc],
        ["Hall Office", U.hall],
        ["a resident", U.resident],
      ])("%s is refused on every procedure", async (_label, who) => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        const caller = as(who);

        const answers = await Promise.all([
          errorOf(caller.create(draftInput(CCA_A))),
          errorOf(caller.update({ id: made.id, version: 1, title: "x" })),
          errorOf(caller.get({ id: made.id })),
          errorOf(caller.list({ ccaID: CCA_A })),
          errorOf(caller.submit({ id: made.id, version: 1 })),
        ]);

        expect(answers).toEqual([
          "FORBIDDEN:NOT_CCA_HEAD",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
          "FORBIDDEN:NOT_PROPOSAL_READER",
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        ]);
      });

      it("a director may read a submitted proposal of their CCA but never write", async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        const director = as(U.dirA);

        const seen = await director.get({ id: made.id });
        expect(seen).toMatchObject({
          viewer: "director",
          canEdit: false,
          status: "in_review",
        });
        expect(seen.createdByMe).toBe(false);
        expect((await director.list({ ccaID: CCA_A })).items).toHaveLength(1);
        expect(
          await errorOf(
            director.update({ id: made.id, version: 1, title: "x" }),
          ),
        ).toBe("NOT_FOUND:PROPOSAL_NOT_FOUND");
        expect(
          await errorOf(director.submit({ id: made.id, version: 1 })),
        ).toBe("NOT_FOUND:PROPOSAL_NOT_FOUND");
      });

      it("a director does not see a draft, in get or in list", async () => {
        const made = await makeDraft();
        const director = as(U.dirA);

        expect(await errorOf(director.get({ id: made.id }))).toBe(
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        );
        expect((await director.list({ ccaID: CCA_A })).items).toEqual([]);
        // The head still does.
        expect((await as(U.headA).list({ ccaID: CCA_A })).items).toHaveLength(
          1,
        );
      });

      it("a director with directors.enabled off is no reader", async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        await setFlag("directors.enabled", "off");

        expect(await errorOf(as(U.dirA).get({ id: made.id }))).toBe(
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        );
        expect(await errorOf(as(U.dirA).list({ ccaID: CCA_A }))).toBe(
          "FORBIDDEN:NOT_PROPOSAL_READER",
        );
      });

      it("a missing proposal is NOT_FOUND", async () => {
        expect(
          await errorOf(as(U.headA).get({ id: "0123456789abcdef01234567" })),
        ).toBe("NOT_FOUND:PROPOSAL_NOT_FOUND");
        expect(
          await errorOf(
            as(U.headA).submit({ id: "0123456789abcdef01234567", version: 0 }),
          ),
        ).toBe("NOT_FOUND:PROPOSAL_NOT_FOUND");
      });
    });

    describe("rate limits (per person, per action, one hour)", () => {
      /** Put a person's counter for one action at `count` in a live window. */
      const seed = (action: string, userID: string, count: number) => {
        const data = {
          count,
          expiresAt: new Date(Date.now() + 3_600_000),
        };
        return db.rateLimit.upsert({
          where: { key: `proposal.${action}:${userID}` },
          create: { key: `proposal.${action}:${userID}`, ...data },
          update: data,
        });
      };
      const rows = () => db.proposal.count({ where: { ccaID: CCA_A } });

      it("the ceilings are create 10, update 120, submit 20, upload 30, approve, return and finish 60, createEvent 30 an hour", async () => {
        const limits = await import("../proposals/limits");
        expect(limits.PROPOSAL_LIMITS).toEqual({
          create: 10,
          update: 120,
          submit: 20,
          upload: 30,
          approve: 60,
          return: 60,
          finish: 60,
          createEvent: 30,
          comment: 120,
          nudge: 30,
          commentRead: 240,
        });
        expect(limits.PROPOSAL_WINDOW_MS).toBe(3_600_000);
      });

      it("the eleventh create in an hour is refused and writes nothing", async () => {
        const head = as(U.headA);
        for (let i = 0; i < 10; i += 1) {
          await head.create(draftInput(CCA_A, { title: `Night ${i}` }));
        }
        expect(await rows()).toBe(10);

        const answer = await errorOf(head.create(draftInput(CCA_A)));
        expect(answer).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
        expect(await rows()).toBe(10);
      });

      it("the limit is per person: another head of the same CCA is not held up", async () => {
        await seed("create", U.headA, 10);
        expect(await errorOf(as(U.headA).create(draftInput(CCA_A)))).toMatch(
          /^TOO_MANY_REQUESTS:RATE_LIMITED:/,
        );
        expect(await errorOf(as(U.headA2).create(draftInput(CCA_A)))).toBe(
          "ok",
        );
      });

      it("the limit is per action: a spent create budget does not block update or submit", async () => {
        const made = await makeDraft();
        await seed("create", U.headA, 10);
        const head = as(U.headA);
        expect(
          await errorOf(head.update({ id: made.id, version: 0, title: "y" })),
        ).toBe("ok");
        expect(await errorOf(head.submit({ id: made.id, version: 1 }))).toBe(
          "ok",
        );
      });

      it("a spent update budget refuses the save and leaves the row alone", async () => {
        const made = await makeDraft();
        await seed("update", U.headA, 120);
        const before = await snapshot(made.id);

        const answer = await errorOf(
          as(U.headA).update({ id: made.id, version: 0, title: "z" }),
        );

        expect(answer).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
        expect(await snapshot(made.id)).toEqual(before);
      });

      it("a spent submit budget refuses the submit and leaves the draft alone", async () => {
        const made = await makeDraft();
        await seed("submit", U.headA, 20);
        const before = await snapshot(made.id);

        const answer = await errorOf(
          as(U.headA).submit({ id: made.id, version: 0 }),
        );

        expect(answer).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
        expect(await snapshot(made.id)).toEqual(before);
      });

      it("a person who may not act spends no budget and leaves no counter", async () => {
        const made = await makeDraft();
        await as(U.headB)
          .create(draftInput(CCA_A))
          .catch(() => undefined);
        await as(U.headB)
          .update({ id: made.id, version: 0, title: "x" })
          .catch(() => undefined);
        await as(U.headB)
          .submit({ id: made.id, version: 0 })
          .catch(() => undefined);
        expect(
          await db.rateLimit.count({
            where: { key: { endsWith: `:${U.headB}` } },
          }),
        ).toBe(0);
      });
    });

    describe("the flag", () => {
      it.each([["off"], [null]])(
        "with proposals.enabled %s every procedure is refused and nothing changes",
        async (value) => {
          const made = await makeDraft();
          const before = await snapshot(made.id);
          await setFlag("proposals.enabled", value);

          const caller = as(U.headA);
          const answers = await Promise.all([
            errorOf(caller.create(draftInput(CCA_A))),
            errorOf(caller.update({ id: made.id, version: 0, title: "x" })),
            errorOf(caller.get({ id: made.id })),
            errorOf(caller.list({ ccaID: CCA_A })),
            errorOf(caller.submit({ id: made.id, version: 0 })),
          ]);

          for (const a of answers)
            expect(a).toBe("FORBIDDEN:PROPOSALS_DISABLED");
          expect(await caller.enabled()).toEqual({ enabled: false });
          expect(await snapshot(made.id)).toEqual(before);
        },
      );
    });

    describe("a failed role read refuses", () => {
      it("a failed head read refuses a write and a read, and writes nothing", async () => {
        const made = await makeDraft();
        const before = await snapshot(made.id);
        const broken = withFailingRead("ccaHead");

        const answers = await Promise.all([
          errorOf(as(U.headA, EVERYTHING, broken).create(draftInput(CCA_A))),
          errorOf(
            as(U.headA, EVERYTHING, broken).submit({ id: made.id, version: 0 }),
          ),
          errorOf(as(U.headA, EVERYTHING, broken).get({ id: made.id })),
        ]);

        expect(answers).toEqual([
          "FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED",
          "FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED",
          "FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED",
        ]);
        expect(await snapshot(made.id)).toEqual(before);
      });

      it("a failed role read refuses a director, who is not read as a yes", async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });

        for (const table of ["userRole", "jcrcPositionHolder"]) {
          const broken = withFailingRead(table);
          expect(
            await errorOf(as(U.dirA, EVERYTHING, broken).get({ id: made.id })),
          ).toBe("FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED");
          expect(
            await errorOf(
              as(U.dirA, EVERYTHING, broken).list({ ccaID: CCA_A }),
            ),
          ).toBe("FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED");
        }
      });
    });

    describe("submit", () => {
      it("moves the draft to in_review with history, an audit row and a notice to the director", async () => {
        const made = await makeDraft();

        const res = await as(U.headA).submit({ id: made.id, version: 0 });

        expect(res).toMatchObject({ status: "in_review", version: 1 });
        const row = await db.proposal.findUnique({ where: { id: made.id } });
        expect(row?.status).toBe("in_review");
        expect(row?.submittedAt).toBeInstanceOf(Date);
        const history = await db.proposalStatusHistory.findMany({
          where: { proposalID: made.id },
        });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
          fromStatus: "draft",
          toStatus: "in_review",
          actorID: U.headA,
          approverID: null,
          selfApproved: false,
          note: null,
        });
        const audit = await db.roleAuditLog.findMany({
          where: { action: "proposal.transition", targetCcaID: CCA_A },
        });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          actorUserID: U.headA,
          ok: true,
          reason: `proposal ${made.id}: draft -> in_review`,
        });
        const notices = await db.notification.findMany({
          where: { kind: { startsWith: "proposal." } },
        });
        expect(notices.map((n) => [n.userID, n.kind])).toEqual([
          [U.dirA, "proposal.submitted"],
        ]);
        expect(notices[0]?.href).toBe(`/director/proposals/${made.id}`);
      });

      it("refuses an incomplete proposal, naming what is missing, and writes nothing", async () => {
        const made = await as(U.headA).create(
          draftInput(CCA_A, { category: "event" }),
        );
        const before = await snapshot(made.id);

        const answer = await errorOf(
          as(U.headA).submit({ id: made.id, version: 0 }),
        );

        expect(answer).toBe(
          "BAD_REQUEST:PROPOSAL_INCOMPLETE:A planned start date and time; A blast message; A poster; A document link",
        );
        expect(await snapshot(made.id)).toEqual(before);
      });

      it("a failed submit leaves the draft exactly as it was (A20)", async () => {
        const made = await makeDraft();
        const before = await snapshot(made.id);

        const answer = await errorOf(
          as(U.headA, EVERYTHING, withFailingNotices()).submit({
            id: made.id,
            version: 0,
          }),
        );

        expect(answer).toBe("INTERNAL_SERVER_ERROR:Something went wrong.");
        // The move, its history row and its audit row were written before the
        // notice failed; none of them survived.
        expect(await snapshot(made.id)).toEqual(before);
        expect(before.row?.status).toBe("draft");
        // And the head can simply try again.
        await as(U.headA).submit({ id: made.id, version: 0 });
        expect(
          (await db.proposal.findUnique({ where: { id: made.id } }))?.status,
        ).toBe("in_review");
      });

      it("a forced createMany failure reaches the caller with no raw message, and the real one goes to the server log", async () => {
        const made = await makeDraft();
        const spy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        try {
          let thrown: unknown;
          try {
            await as(U.headA, EVERYTHING, withFailingNotices()).submit({
              id: made.id,
              version: 0,
            });
          } catch (error) {
            thrown = error;
          }
          const e = thrown as { code?: string; message?: string };
          expect(e.code).toBe("INTERNAL_SERVER_ERROR");
          expect(e.message).toBe("Something went wrong.");
          expect(String(e.message)).not.toMatch(/boom|prisma|invocation/i);

          // The detail is not lost: it is logged for the operator.
          const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
          expect(logged).toContain("boom");
        } finally {
          spy.mockRestore();
        }
      });

      it("submitting twice, or with a stale version, is a CONFLICT", async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });

        expect(
          await errorOf(as(U.headA).submit({ id: made.id, version: 0 })),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect(
          await errorOf(as(U.headA).submit({ id: made.id, version: 1 })),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect(
          await db.proposalStatusHistory.count({
            where: { proposalID: made.id },
          }),
        ).toBe(1);
      });

      it("two simultaneous submits: one wins, the other is a CONFLICT, one history row", async () => {
        const made = await makeDraft();

        const results = await Promise.allSettled([
          as(U.headA).submit({ id: made.id, version: 0 }),
          as(U.headA2).submit({ id: made.id, version: 0 }),
        ]);

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const lost = results.find((r) => r.status === "rejected") as
          | PromiseRejectedResult
          | undefined;
        expect((lost?.reason as { message: string }).message).toBe(
          "PROPOSAL_CONFLICT",
        );
        expect(
          await db.proposalStatusHistory.count({
            where: { proposalID: made.id },
          }),
        ).toBe(1);
        expect(
          await db.notification.count({
            where: { kind: "proposal.submitted" },
          }),
        ).toBe(1);
      });

      it("an edit that lands between validation and the write cannot be sent unchecked", async () => {
        // The submit validated version 0; an edit then made it version 1.
        const made = await makeDraft();
        await as(U.headA).update({ id: made.id, version: 0, description: "" });

        expect(
          await errorOf(as(U.headA).submit({ id: made.id, version: 0 })),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        // And the transition itself holds the same line against a stale version.
        expect(
          await errorOf(
            transition.transitionProposal(db, {
              proposalID: made.id,
              from: "draft",
              to: "in_review",
              actorID: U.headA,
              expectedVersion: 0,
            }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect(
          (await db.proposal.findUnique({ where: { id: made.id } }))?.status,
        ).toBe("draft");
      });

      it("works with notifications.enabled off, and writes no notice", async () => {
        await setFlag("notifications.enabled", "off");
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        expect(
          (await db.proposal.findUnique({ where: { id: made.id } }))?.status,
        ).toBe("in_review");
        expect(
          await db.notification.count({
            where: { kind: { startsWith: "proposal." } },
          }),
        ).toBe(0);
      });
    });

    describe("vacant positions (A49)", () => {
      const expectStaffNotified = async (proposalID: string) => {
        const notices = await db.notification.findMany({
          where: { kind: "proposal.vacant", userID: { in: IDS } },
        });
        expect(notices.map((n) => n.userID).sort()).toEqual(
          [U.admin, U.scrc, U.hall].sort(),
        );
        for (const n of notices) expect(n.href).toBeNull();
        expect(
          await db.notification.count({
            where: { kind: "proposal.submitted" },
          }),
        ).toBe(0);
        expect(
          (await db.proposal.findUnique({ where: { id: proposalID } }))?.status,
        ).toBe("in_review");
      };

      it("a CCA no flagged position lists still goes to in_review; admins, RFs and Hall Office are told", async () => {
        const made = await as(U.headC).create(draftInput(CCA_C));

        await as(U.headC).submit({ id: made.id, version: 0 });

        await expectStaffNotified(made.id);
      });

      it("a flagged position whose holder has no live jcrc counts as vacant", async () => {
        await db.userRole.updateMany({
          where: { userID: U.dirA },
          data: { roles: ["resident"] },
        });
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        await expectStaffNotified(made.id);
      });

      it("an ended holder row counts as vacant", async () => {
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dirA },
          data: { endsAt: new Date(Date.now() - 60_000) },
        });
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        await expectStaffNotified(made.id);
      });

      it("with directors.enabled off nobody can act, so staff are told", async () => {
        await setFlag("directors.enabled", null);
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        await expectStaffNotified(made.id);
      });

      it("a director who also heads the CCA does not count, so staff are told", async () => {
        await db.ccaHead.create({ data: { userID: U.dirA, ccaID: CCA_A } });
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        await expectStaffNotified(made.id);
      });

      it("still tells a second director who does not head the CCA", async () => {
        await db.ccaHead.create({ data: { userID: U.dirA, ccaID: CCA_A } });
        await makeDirectorPosition("Second", [CCA_A], U.jcrc);
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        const told = await db.notification.findMany({
          where: { kind: "proposal.submitted" },
        });
        expect(told.map((n) => n.userID)).toEqual([U.jcrc]);
      });

      it("a staff row with a blank user id does not stop the submit", async () => {
        await db.userRole.create({
          data: {
            userID: "",
            roles: ["admin"],
            updatedAt: new Date(),
            updatedBy: "test",
          },
        });
        const made = await as(U.headC).create(draftInput(CCA_C));

        await as(U.headC).submit({ id: made.id, version: 0 });

        await expectStaffNotified(made.id);
      });

      it("a director elsewhere is not told about this CCA's proposal", async () => {
        const made = await makeDraft();

        await as(U.headA).submit({ id: made.id, version: 0 });

        const told = await db.notification.findMany({
          where: { kind: "proposal.submitted" },
        });
        expect(told.map((n) => n.userID)).toEqual([U.dirA]);
      });
    });

    describe("transitionProposal", () => {
      const toReview = async () => {
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        return made.id;
      };

      it("refuses a move that is not in the table before touching the database", async () => {
        const made = await makeDraft();
        const before = await snapshot(made.id);

        expect(
          await errorOf(
            transition.transitionProposal(db, {
              proposalID: made.id,
              from: "draft",
              to: "cleared",
              actorID: U.dirA,
            }),
          ),
        ).toBe("BAD_REQUEST:PROPOSAL_BAD_TRANSITION");
        expect(await snapshot(made.id)).toEqual(before);
      });

      it("a stale caller is a CONFLICT with nothing written", async () => {
        const id = await toReview();
        const before = await snapshot(id);

        // The caller thinks it is still a draft.
        expect(
          await errorOf(
            transition.transitionProposal(db, {
              proposalID: id,
              from: "draft",
              to: "in_review",
              actorID: U.headA,
            }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect(await snapshot(id)).toEqual(before);
      });

      it("records the approver and the self-approved label when given", async () => {
        const id = await toReview();

        await transition.transitionProposal(db, {
          proposalID: id,
          from: "in_review",
          to: "cleared",
          actorID: U.dirA,
          approverID: U.dirA,
          selfApproved: true,
          note: "ok",
        });

        const rows = await db.proposalStatusHistory.findMany({
          where: { proposalID: id, toStatus: "cleared" },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          fromStatus: "in_review",
          actorID: U.dirA,
          approverID: U.dirA,
          selfApproved: true,
          note: "ok",
        });
      });

      it("approve and return cannot be applied to a proposal that is not in review", async () => {
        const made = await makeDraft();
        for (const to of ["cleared", "needs_action"] as const) {
          expect(
            await errorOf(
              transition.transitionProposal(db, {
                proposalID: made.id,
                from: "draft",
                to,
                actorID: U.dirA,
              }),
            ),
          ).toBe("BAD_REQUEST:PROPOSAL_BAD_TRANSITION");
        }
      });

      it("A5: an approve and a return at the same moment: exactly one wins, history agrees with status", async () => {
        for (let round = 0; round < 5; round++) {
          await clean();
          await beforeEachSetup();
          const id = await toReview();

          const results = await Promise.allSettled([
            transition.transitionProposal(db, {
              proposalID: id,
              from: "in_review",
              to: "cleared",
              actorID: U.dirA,
            }),
            transition.transitionProposal(db, {
              proposalID: id,
              from: "in_review",
              to: "needs_action",
              actorID: U.dirA,
            }),
          ]);

          const won = results.flatMap((r, i) =>
            r.status === "fulfilled" ? [i] : [],
          );
          expect(won, `round ${round}`).toHaveLength(1);
          const lost = results.find((r) => r.status === "rejected") as
            | PromiseRejectedResult
            | undefined;
          expect((lost?.reason as { code: string }).code).toBe("CONFLICT");

          const row = await db.proposal.findUnique({ where: { id } });
          expect(row?.status).toBe(won[0] === 0 ? "cleared" : "needs_action");
          const history = await db.proposalStatusHistory.findMany({
            where: { proposalID: id },
            orderBy: { createdAt: "asc" },
          });
          // submit, plus exactly one decision, and it names the final status.
          expect(history.map((h) => h.toStatus)).toEqual([
            "in_review",
            row?.status,
          ]);
          expect(
            await db.roleAuditLog.count({
              where: { action: "proposal.transition", targetCcaID: CCA_A },
            }),
          ).toBe(2);
        }
      });

      it("A5: eight simultaneous identical approvals: one history row", async () => {
        const id = await toReview();

        const results = await Promise.allSettled(
          Array.from({ length: 8 }, () =>
            transition.transitionProposal(db, {
              proposalID: id,
              from: "in_review",
              to: "cleared",
              actorID: U.dirA,
            }),
          ),
        );

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(
          await db.proposalStatusHistory.count({
            where: { proposalID: id, toStatus: "cleared" },
          }),
        ).toBe(1);
      });

      it("the notice hook runs in the transaction: if it throws, the move is rolled back", async () => {
        const id = await toReview();
        const before = await snapshot(id);

        const answer = await errorOf(
          transition.transitionProposal(
            db,
            {
              proposalID: id,
              from: "in_review",
              to: "cleared",
              actorID: U.dirA,
            },
            {
              inTransaction: () => Promise.reject(new Error("no")),
            },
          ),
        );

        expect(answer).toBe("undefined:no");
        expect(await snapshot(id)).toEqual(before);
      });
    });

    describe("account deletion", () => {
      it("keeps the proposal and its history for the CCA's other readers, clears the deleted person, keeps the label", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "~/server/api/services/userAdmin"
        );
        const user = await db.user.create({
          data: { email: "e9990601@u.nus.edu", userID: U.headA },
        });
        const made = await makeDraft();
        await as(U.headA).submit({ id: made.id, version: 0 });
        await transition.transitionProposal(db, {
          proposalID: made.id,
          from: "in_review",
          to: "cleared",
          actorID: U.headA,
          approverID: U.headA,
          selfApproved: true,
        });
        // A second proposal by someone else must be untouched.
        const theirs = await as(U.headA2).create(draftInput(CCA_A));
        await db.proposalComment.createMany({
          data: [
            { proposalID: made.id, authorID: U.headA, body: "mine" },
            { proposalID: made.id, authorID: U.headA2, body: "theirs" },
          ],
        });
        await db.proposalCommentRead.createMany({
          data: [
            { proposalID: made.id, userID: U.headA, readAt: new Date() },
            { proposalID: made.id, userID: U.headA2, readAt: new Date() },
          ],
        });

        const target = await loadAdminUserTarget(db, user.id);
        const result = await deleteUserAccountCascade(db, target, U.admin);

        expect(result.deleted).toMatchObject({
          proposalAuthorCleared: 1,
          proposalHistoryActorCleared: 2,
          proposalHistoryApproverCleared: 1,
          proposalCommentAuthorCleared: 1,
          proposalCommentRead: 1,
        });
        // Nothing is deleted; the references are cleared.
        const row = await db.proposal.findUnique({ where: { id: made.id } });
        expect(row).toMatchObject({ createdBy: null, status: "cleared" });
        const history = await db.proposalStatusHistory.findMany({
          where: { proposalID: made.id },
        });
        expect(history).toHaveLength(2);
        for (const h of history) expect(h.actorID).toBeNull();
        expect(history.find((h) => h.toStatus === "cleared")).toMatchObject({
          approverID: null,
          selfApproved: true,
        });
        expect(
          await db.proposalComment.count({ where: { proposalID: made.id } }),
        ).toBe(2);
        expect(
          await db.proposalComment.count({
            where: { proposalID: made.id, authorID: null },
          }),
        ).toBe(1);
        expect(
          await db.proposalCommentRead.count({ where: { userID: U.headA } }),
        ).toBe(0);
        expect(
          await db.proposalCommentRead.count({ where: { userID: U.headA2 } }),
        ).toBe(1);
        expect(
          (await db.proposal.findUnique({ where: { id: theirs.id } }))
            ?.createdBy,
        ).toBe(U.headA2);

        // The CCA's other head and its director still read all of it.
        const seen = await as(U.headA2).get({ id: made.id });
        expect(seen).toMatchObject({ status: "cleared", createdByMe: false });
        expect(seen.history).toHaveLength(2);
        expect(
          seen.history.find((h) => h.toStatus === "cleared")?.selfApproved,
        ).toBe(true);
        expect((await as(U.headA2).list({ ccaID: CCA_A })).items).toHaveLength(
          2,
        );
        expect(await errorOf(as(U.dirA).get({ id: made.id }))).toBe("ok");
        // The deleted person's own headship went with the account.
        expect(await errorOf(as(U.headA).list({ ccaID: CCA_A }))).toBe(
          "FORBIDDEN:NOT_PROPOSAL_READER",
        );
      });
    });

    /** beforeEach's body, for tests that reset the world several times. */
    async function beforeEachSetup() {
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.dirA, U.dirB, U.jcrc]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
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
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makeDirectorPosition("Dir A", [CCA_A], U.dirA);
      await makeDirectorPosition("Dir B", [CCA_B], U.dirB);
    }
  },
);
