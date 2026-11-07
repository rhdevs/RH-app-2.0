import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type { DueKind } from "~/server/api/services/dueCheck/types";
import type { runDueCheck as RunDueCheck } from "~/server/api/services/dueCheck/runner";
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

/**
 * INTEGRATION TESTS of disposable requests (create, read, edit, approve,
 * reject, delete), who may do what, the notices, the rate limits, the
 * no-Social-director notice and account deletion, against the LOCAL
 * development database (skipped unless DATABASE_URL is the local dev
 * database; run `npm run test:db`). Run this file on its own.
 *
 * The tests own every row they touch: users E99913xx, CCAs 9001 and 9002
 * (heads and requests only; the CCA rows are never written), positions named
 * "TEST ...", every `disposable.*` and `due.disposables_no_director` notice.
 * The four flag rows are put back as they were.
 */

const U = {
  headA: "E9991301", // heads CCA 9001
  headA2: "E9991302", // also heads CCA 9001
  headB: "E9991303", // heads CCA 9002
  social: "E9991304", // the Social director (jcrc, holds the flagged position)
  jcrc: "E9991305", // jcrc, no position
  vetter: "E9991306", // jcrc, director of 9001 (vetsProposals only)
  admin: "E9991307",
  scrc: "E9991308",
  hall: "E9991309",
  resident: "E9991310",
  social2: "E9991311", // holds a second flagged position when a test adds one
};
const IDS = Object.values(U);
const CCA_A = 9001;
const CCA_B = 9002;
const CCAS = [CCA_A, CCA_B];
const FLAGS = [
  "disposables.enabled",
  "directors.enabled",
  "notifications.enabled",
  "proposals.enabled",
];
/** Session roles that claim every power: the server must not believe them. */
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const ACTIONS = ["create", "update", "approve", "reject", "delete"] as const;
const DAY = "2099-06-15";
const NOT_FOUND = "NOT_FOUND:DISPOSABLE_NOT_FOUND";
const CHECK_FAILED = "FORBIDDEN:DISPOSABLE_ACCESS_CHECK_FAILED";
const NOT_SOCIAL = "FORBIDDEN:NOT_SOCIAL_DIRECTOR";
const NOT_HEAD = "FORBIDDEN:NOT_CCA_HEAD";
const NOT_READER = "FORBIDDEN:NOT_DISPOSABLE_READER";
const CONFLICT = "CONFLICT:DISPOSABLE_CONFLICT";

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "disposable requests (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let runDueCheck: typeof RunDueCheck;
    let kindUnderTest: DueKind;
    let resetNotificationsCache: () => void;
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
      }).disposable;

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
      resetNotificationsCache();
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
            in: ACTIONS.flatMap((a) =>
              IDS.map((id) => `disposable.${a}:${id}`),
            ),
          },
        },
      });
      const proposals = await db.proposal.findMany({
        where: { ccaID: { in: CCAS }, title: { startsWith: "TEST " } },
        select: { id: true },
      });
      await db.disposableRequest.deleteMany({
        where: {
          OR: [{ ccaID: { in: CCAS } }, { createdBy: { in: IDS } }],
        },
      });
      await db.proposal.deleteMany({
        where: { id: { in: proposals.map((p) => p.id) } },
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
            { kind: { startsWith: "disposable." } },
          ],
        },
      });
      await db.user.deleteMany({ where: { email: { startsWith: "e99913" } } });
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
      count: () => Promise.reject(new Error("db down")),
    });

    /**
     * A database whose "is this proposal taken" pre-check always finds nothing,
     * so concurrent writers reach the partial unique index itself.
     */
    const withoutDuplicatePrecheck = (): PrismaClient =>
      proxied(db, (prop) =>
        prop === "disposableRequest"
          ? new Proxy(db.disposableRequest, {
              get(t, p) {
                if (p === "findFirst") return () => Promise.resolve(null);
                const v = Reflect.get(t, p) as unknown;
                return typeof v === "function"
                  ? (v as (...x: unknown[]) => unknown).bind(t)
                  : v;
              },
            })
          : undefined,
      );

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

    const input = (over: Record<string, unknown> = {}) => ({
      ccaID: CCA_A,
      title: "Hall dinner",
      description: "Supper after the show",
      proposalID: null,
      plates: 40,
      cups: 20,
      bowls: 0,
      forks: 40,
      spoons: 40,
      collectionDay: DAY,
      collectionTime: "18:30",
      ...over,
    });

    /** A pending request, filed by headA through the real procedure. */
    const file = async (over: Record<string, unknown> = {}) => {
      const made = await as(U.headA).create(input(over) as never);
      return made;
    };

    const stored = (id: string) =>
      db.disposableRequest.findUniqueOrThrow({ where: { id } });

    /**
     * Notices of one kind, or (default) every disposable notice except the
     * "filed" one the Social director gets when a request is filed, which has
     * its own tests; the others assert who is NOT told about a decision.
     */
    const noticesFor = (userID: string, kind?: string) =>
      db.notification.findMany({
        where: {
          userID,
          kind: kind ?? { startsWith: "disposable.", not: "disposable.filed" },
        },
      });

    const makeProposal = (ccaID: number, title = "TEST proposal") =>
      db.proposal.create({
        data: {
          ccaID,
          category: "pubs",
          title,
          description: "x",
          createdBy: U.headA,
        },
      });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      ({ disposablesNoDirectorKind: kindUnderTest } = await import(
        "~/server/api/services/dueCheck/disposablesNoDirector"
      ));
      ({ resetNotificationsFlagCache: resetNotificationsCache } = await import(
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
      for (const id of [U.social, U.social2, U.jcrc, U.vetter]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      for (const id of [U.headA, U.headA2, U.headB]) {
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
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Social", U.social, { social: true });
      await makePosition("Vetter A", U.vetter, { vets: true, ccaIDs: [CCA_A] });
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("the flag", () => {
      it("is off when absent, not 'on' or unreadable, and every gated procedure refuses", async () => {
        for (const value of [null, "off", "ON", ""]) {
          await setFlag("disposables.enabled", value);
          expect((await as(U.headA).enabled()).enabled).toBe(false);
          expect(await errorOf(as(U.headA).list({}))).toBe(
            "FORBIDDEN:DISPOSABLES_DISABLED",
          );
          expect(await errorOf(as(U.headA).create(input() as never))).toBe(
            "FORBIDDEN:DISPOSABLES_DISABLED",
          );
          expect((await as(U.headA).entry()).show).toBe(false);
        }
      });

      it("a failed flag read counts as off", async () => {
        const down = proxied(db, (prop) =>
          prop === "systemFlag"
            ? { findUnique: () => Promise.reject(new Error("db down")) }
            : undefined,
        );
        expect((await as(U.headA, EVERYTHING, down).enabled()).enabled).toBe(
          false,
        );
      });
    });

    describe("create", () => {
      it("a head files a pending request for their own CCA, version 0", async () => {
        const made = await file();

        const row = await stored(made.id);
        expect(row).toMatchObject({
          ccaID: CCA_A,
          createdBy: U.headA,
          status: "pending",
          version: 0,
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
          plates: 40,
          collectionDay: DAY,
          collectionTime: "18:30",
        });
        expect(row).not.toHaveProperty("academicYear");
      });

      it("another head of the same CCA may file too; a head of another CCA may not", async () => {
        expect(await errorOf(as(U.headA2).create(input() as never))).toBe("ok");
        expect(await errorOf(as(U.headB).create(input() as never))).toBe(
          NOT_HEAD,
        );
      });

      it.each([
        ["an admin", U.admin],
        ["a JCRC member", U.jcrc],
        ["a director", U.vetter],
        ["the Social director", U.social],
        ["an RF", U.scrc],
        ["Hall Office", U.hall],
        ["a resident", U.resident],
      ])(
        "%s who heads no CCA is refused, whatever the session claims",
        async (_n, id) => {
          expect(await errorOf(as(id).create(input() as never))).toBe(NOT_HEAD);
          expect(
            await db.disposableRequest.count({ where: { ccaID: CCA_A } }),
          ).toBe(0);
        },
      );

      it("refuses bad content and writes nothing", async () => {
        const bad: Array<Record<string, unknown>> = [
          { plates: 0, cups: 0, bowls: 0, forks: 0, spoons: 0 },
          { plates: -1 },
          { plates: 501 },
          { plates: 1.5 },
          { title: "   " },
          { title: "x".repeat(121) },
          { description: "x".repeat(1001) },
          { collectionDay: "2099-02-30" },
          { collectionDay: "2020-01-01" },
          { collectionTime: "24:00" },
          { proposalID: "not-an-id" },
        ];
        for (const over of bad) {
          expect(
            (await errorOf(as(U.headA).create(input(over) as never))) !== "ok",
            JSON.stringify(over),
          ).toBe(true);
        }
        expect(
          await db.disposableRequest.count({ where: { ccaID: CCA_A } }),
        ).toBe(0);
      });

      it("allows collection today and zero for some items", async () => {
        const { sgtDayKey } = await import("~/lib/time/sgt");
        const today = sgtDayKey(new Date());
        expect(
          await errorOf(
            as(U.headA).create(
              input({
                collectionDay: today,
                plates: 0,
                cups: 0,
                bowls: 0,
                forks: 0,
                spoons: 1,
              }) as never,
            ),
          ),
        ).toBe("ok");
      });

      it("a status in the input is not accepted or stored", async () => {
        const made = await as(U.headA).create({
          ...input(),
          status: "approved",
        } as never);
        expect((await stored(made.id)).status).toBe("pending");
      });

      it("a created request tells the Social director, and only the Social director (#134)", async () => {
        const made = await file({ title: "Hall dinner" });
        const told = await noticesFor(U.social, "disposable.filed");
        expect(told).toHaveLength(1);
        expect(told[0]).toMatchObject({
          title: "A disposable request was filed",
          body: "Hall dinner",
          href: `/disposables/${made.id}`,
        });
        expect(await noticesFor(U.social)).toEqual([]);
        for (const other of [U.headA, U.headA2, U.headB, U.jcrc, U.vetter]) {
          expect(await noticesFor(other, "disposable.filed")).toEqual([]);
        }
      });

      it("writes no filed notice while notifications are off, and still files", async () => {
        await setFlag("notifications.enabled", "off");
        const made = await file();
        expect((await stored(made.id)).status).toBe("pending");
        expect(await noticesFor(U.social, "disposable.filed")).toEqual([]);
      });

      it("with no Social director nobody is told, and the request is still filed", async () => {
        await setFlag("directors.enabled", null);
        const made = await file();
        expect((await stored(made.id)).status).toBe("pending");
        expect(
          await db.notification.count({
            where: { kind: "disposable.filed" },
          }),
        ).toBe(0);
      });

      it("a failed filed notice is logged by error name and never fails the request", async () => {
        const broken = proxied(db, (prop) =>
          prop === "notification"
            ? { createMany: () => Promise.reject(new Error("boom-secret")) }
            : undefined,
        );
        const spy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        try {
          const made = await as(U.headA, EVERYTHING, broken).create(
            input() as never,
          );
          expect((await stored(made.id)).status).toBe("pending");
          const log = spy.mock.calls.map((c) => String(c[0])).join(" ");
          expect(log).toContain("disposable_filed_notice_failed");
          expect(log).not.toContain("boom-secret");
        } finally {
          spy.mockRestore();
        }
        expect(
          await db.notification.count({ where: { kind: "disposable.filed" } }),
        ).toBe(0);
      });

      it("stores the text as given, without markup interpretation", async () => {
        const made = await file({ title: "<script>alert(1)</script>" });
        expect((await stored(made.id)).title).toBe("<script>alert(1)</script>");
      });
    });

    describe("proposal link", () => {
      it("links to a proposal of the same CCA, once", async () => {
        const proposal = await makeProposal(CCA_A);
        const made = await file({ proposalID: proposal.id });
        expect((await stored(made.id)).proposalID).toBe(proposal.id);

        expect(
          await errorOf(
            as(U.headA).create(input({ proposalID: proposal.id }) as never),
          ),
        ).toBe("CONFLICT:DISPOSABLE_PROPOSAL_TAKEN");
      });

      it("refuses another CCA's proposal and one that does not exist", async () => {
        const other = await makeProposal(CCA_B);
        expect(
          await errorOf(
            as(U.headA).create(input({ proposalID: other.id }) as never),
          ),
        ).toBe("BAD_REQUEST:DISPOSABLE_BAD_PROPOSAL");
        expect(
          await errorOf(
            as(U.headA).create(input({ proposalID: "a".repeat(24) }) as never),
          ),
        ).toBe("BAD_REQUEST:DISPOSABLE_BAD_PROPOSAL");
      });

      it("the partial unique index refuses a second request on one proposal, and not two with none", async () => {
        const reply = (await db.$runCommandRaw({
          listIndexes: "DisposableRequest",
        })) as { cursor?: { firstBatch?: Array<{ name: string }> } };
        const names = (reply.cursor?.firstBatch ?? []).map((i) => i.name);
        expect(names).toContain("disposable_request_proposal_unique");

        const proposal = await makeProposal(CCA_A);
        const data = {
          ccaID: CCA_A,
          createdBy: U.headA,
          title: "t",
          description: "",
          plates: 1,
          cups: 0,
          bowls: 0,
          forks: 0,
          spoons: 0,
          collectionDay: DAY,
          collectionTime: "10:00",
        };
        await db.disposableRequest.create({
          data: { ...data, proposalID: proposal.id },
        });
        await expect(
          db.disposableRequest.create({
            data: { ...data, proposalID: proposal.id },
          }),
        ).rejects.toBeDefined();
        await db.disposableRequest.create({
          data: { ...data, proposalID: null },
        });
        await db.disposableRequest.create({
          data: { ...data, proposalID: null },
        });
      });

      it("proposalChoices lists the CCA's proposals for its head only and marks the taken one", async () => {
        const linked = await makeProposal(CCA_A, "TEST linked");
        await makeProposal(CCA_A, "TEST free");
        await file({ proposalID: linked.id });

        const choices = await as(U.headA).proposalChoices({ ccaID: CCA_A });

        expect(choices.map((c) => [c.title, c.taken]).sort()).toEqual([
          ["TEST free", false],
          ["TEST linked", true],
        ]);
        expect(
          await errorOf(as(U.headB).proposalChoices({ ccaID: CCA_A })),
        ).toBe(NOT_HEAD);
        expect(
          await errorOf(as(U.social).proposalChoices({ ccaID: CCA_A })),
        ).toBe(NOT_HEAD);
      });
    });

    describe("reading (A54)", () => {
      it("a head sees their own CCA's requests and no other", async () => {
        await file();
        await as(U.headB).create(
          input({ ccaID: CCA_B, title: "B's" }) as never,
        );

        const res = await as(U.headA).list({});

        expect(res.items.map((r) => r.ccaID)).toEqual([CCA_A]);
        expect(res.viewer).toEqual({
          isSocialDirector: false,
          canCreate: true,
        });
        expect(res.ccaOptions.map((c) => c.ccaID)).toEqual([CCA_A]);
      });

      it("a head asking for another CCA is refused the read; the other head's request is NOT_FOUND by id", async () => {
        const theirs = await as(U.headB).create(
          input({ ccaID: CCA_B }) as never,
        );

        expect(await errorOf(as(U.headA).list({ ccaID: CCA_B }))).toBe(
          NOT_READER,
        );
        expect(await errorOf(as(U.headA).get({ id: theirs.id }))).toBe(
          NOT_FOUND,
        );
        expect(await errorOf(as(U.headA).get({ id: "a".repeat(24) }))).toBe(
          NOT_FOUND,
        );
      });

      it("every JCRC member reads all requests and may act on none unless the Social director", async () => {
        const a = await file();
        await as(U.headB).create(input({ ccaID: CCA_B }) as never);

        for (const id of [U.jcrc, U.vetter, U.social]) {
          expect((await as(id).list({})).items).toHaveLength(2);
          expect((await as(id).get({ id: a.id })).ccaID).toBe(CCA_A);
        }
        const plain = await as(U.jcrc).list({});
        expect(
          plain.items.every(
            (r) => !r.can.approve && !r.can.edit && !r.can.delete,
          ),
        ).toBe(true);
        const social = await as(U.social).list({});
        expect(social.viewer.isSocialDirector).toBe(true);
        expect(
          social.items.every(
            (r) => r.can.approve && r.can.edit && r.can.delete,
          ),
        ).toBe(true);
      });

      it.each([
        ["an admin", U.admin],
        ["an RF", U.scrc],
        ["Hall Office", U.hall],
        ["a resident", U.resident],
      ])("%s who is none of those is refused", async (_n, id) => {
        const made = await file();
        expect(await errorOf(as(id).list({}))).toBe(NOT_READER);
        expect(await errorOf(as(id).get({ id: made.id }))).toBe(NOT_FOUND);
      });

      it("filters by status, CCA and collection day", async () => {
        const a = await file({ collectionDay: "2099-06-10" });
        await file({ collectionDay: "2099-06-20" });
        await as(U.social).approve({
          id: a.id,
          version: a.version,
          note: null,
        });
        await as(U.headB).create(input({ ccaID: CCA_B }) as never);

        const ids = async (f: object) =>
          (await as(U.social).list(f)).items.map(
            (r) => `${r.ccaID}:${r.collectionDay}`,
          );
        expect(await ids({ status: "approved" })).toEqual([
          `${CCA_A}:2099-06-10`,
        ]);
        expect(await ids({ ccaID: CCA_B })).toEqual([`${CCA_B}:${DAY}`]);
        expect(
          (await ids({ from: "2099-06-12", to: "2099-06-30" })).sort(),
        ).toEqual([`${CCA_B}:${DAY}`, `${CCA_A}:2099-06-20`].sort());
      });

      it("counts and skips a stored row that cannot be shown", async () => {
        await file();
        await db.disposableRequest.create({
          data: {
            ccaID: CCA_A,
            createdBy: U.headA,
            title: "bad",
            description: "",
            plates: 9999,
            cups: 0,
            bowls: 0,
            forks: 0,
            spoons: 0,
            collectionDay: DAY,
            collectionTime: "10:00",
          },
        });

        const res = await as(U.headA).list({});

        expect(res.items).toHaveLength(1);
        expect(res.skipped).toBe(1);
      });

      it("says whether anyone can decide", async () => {
        await file();
        expect((await as(U.headA).list({})).hasSocialDirector).toBe(true);
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.social } });
        expect((await as(U.headA).list({})).hasSocialDirector).toBe(false);
      });

      it("the navigation entry is shown to a head or a JCRC member, from stored rows", async () => {
        expect((await as(U.headA, ["resident"]).entry()).show).toBe(true);
        expect((await as(U.jcrc, ["resident"]).entry()).show).toBe(true);
        expect((await as(U.admin, EVERYTHING).entry()).show).toBe(false);
        expect((await as(U.resident, EVERYTHING).entry()).show).toBe(false);
      });
    });

    describe("approve and reject (the Social director only)", () => {
      it("approves a pending request, records who and when, tells the heads", async () => {
        const made = await file();

        const res = await as(U.social).approve({
          id: made.id,
          version: made.version,
          note: " collect from the porter ",
        });

        expect(res).toMatchObject({
          id: made.id,
          version: 1,
          status: "approved",
        });
        expect(await stored(made.id)).toMatchObject({
          status: "approved",
          version: 1,
          decidedBy: U.social,
          decisionNote: "collect from the porter",
        });
        expect((await stored(made.id)).decidedAt).toBeInstanceOf(Date);
        for (const head of [U.headA, U.headA2]) {
          const notes = await noticesFor(head, "disposable.approved");
          expect(notes).toHaveLength(1);
          expect(notes[0]!.body).toContain("collect from the porter");
          expect(notes[0]!.href).toBe("/disposables");
        }
        expect(await noticesFor(U.headB)).toEqual([]);
        expect(await noticesFor(U.social)).toEqual([]);
      });

      it("rejects a pending request with the reason", async () => {
        const made = await file();

        await as(U.social).reject({
          id: made.id,
          version: 0,
          note: "no stock",
        });

        expect(await stored(made.id)).toMatchObject({
          status: "rejected",
          decisionNote: "no stock",
        });
        expect(await noticesFor(U.headA, "disposable.rejected")).toHaveLength(
          1,
        );
      });

      it.each([
        ["a JCRC member", U.jcrc],
        ["a director", U.vetter],
        ["an admin", U.admin],
        ["an RF", U.scrc],
        ["Hall Office", U.hall],
        ["the CCA's own head", U.headA],
        ["a resident", U.resident],
      ])("%s is refused, whatever the session claims", async (_n, id) => {
        const made = await file();
        for (const action of ["approve", "reject"] as const) {
          expect(
            await errorOf(
              as(id)[action]({ id: made.id, version: 0, note: null }),
            ),
          ).toBe(NOT_SOCIAL);
        }
        expect((await stored(made.id)).status).toBe("pending");
      });

      it("a stale version or a request already decided is a CONFLICT and changes nothing", async () => {
        const made = await file();
        await as(U.social).approve({ id: made.id, version: 0, note: null });

        expect(
          await errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          ),
        ).toBe(CONFLICT);
        expect(
          await errorOf(
            as(U.social).reject({ id: made.id, version: 1, note: null }),
          ),
        ).toBe(CONFLICT);
        expect((await stored(made.id)).status).toBe("approved");
        expect(await noticesFor(U.headA)).toHaveLength(1);
      });

      it("a rejected request cannot be approved", async () => {
        const made = await file();
        await as(U.social).reject({ id: made.id, version: 0, note: null });

        expect(
          await errorOf(
            as(U.social).approve({ id: made.id, version: 1, note: null }),
          ),
        ).toBe(CONFLICT);
      });

      it("an unknown id is NOT_FOUND", async () => {
        expect(
          await errorOf(
            as(U.social).approve({
              id: "a".repeat(24),
              version: 0,
              note: null,
            }),
          ),
        ).toBe(NOT_FOUND);
      });

      it("two decisions at once: exactly one wins", async () => {
        const made = await file();

        const results = await Promise.all([
          errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          ),
          errorOf(as(U.social).reject({ id: made.id, version: 0, note: null })),
        ]);

        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === CONFLICT)).toHaveLength(1);
        const row = await stored(made.id);
        expect(row.version).toBe(1);
        expect(["approved", "rejected"]).toContain(row.status);
        expect(await noticesFor(U.headA)).toHaveLength(1);
      });

      it("nobody can decide with two flagged positions, with none, or with directors off", async () => {
        const made = await file();
        const decide = () =>
          errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          );

        await makePosition("Social 2", U.social2, { social: true });
        expect(await decide()).toBe(NOT_SOCIAL);
        await db.jcrcPositionHolder.deleteMany({
          where: { userID: U.social2 },
        });
        await db.jcrcPosition.deleteMany({ where: { name: "TEST Social 2" } });

        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social" },
          data: { handlesDisposables: false },
        });
        expect(await decide()).toBe(NOT_SOCIAL);
        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social" },
          data: { handlesDisposables: true },
        });

        await setFlag("directors.enabled", "off");
        expect(await decide()).toBe(NOT_SOCIAL);
        await setFlag("directors.enabled", "on");

        expect((await stored(made.id)).status).toBe("pending");
        expect(await decide()).toBe("ok");
      });

      it("a Social director who lost jcrc, or whose position ended, cannot decide", async () => {
        const made = await file();
        await db.jcrcTerm.create({
          data: {
            userID: U.social,
            endsAt: new Date(Date.now() - 1000),
          },
        });
        expect(
          await errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          ),
        ).toBe(NOT_SOCIAL);
      });

      it("a failed guard read refuses and a request stays as it was", async () => {
        const made = await file();
        for (const table of [
          "jcrcPositionHolder",
          "jcrcPosition",
          "userRole",
        ]) {
          const log = vi
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
          const result = await errorOf(
            as(U.social, EVERYTHING, withFailingRead(table)).approve({
              id: made.id,
              version: 0,
              note: null,
            }),
          );
          log.mockRestore();
          expect(result, table).toMatch(/^FORBIDDEN:/);
        }
        expect((await stored(made.id)).status).toBe("pending");
      });

      it("if the notice cannot be written the decision is rolled back", async () => {
        const made = await file();
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);

        const result = await errorOf(
          as(U.social, EVERYTHING, withFailingNotices()).approve({
            id: made.id,
            version: 0,
            note: null,
          }),
        );
        log.mockRestore();

        expect(result).not.toBe("ok");
        expect(await stored(made.id)).toMatchObject({
          status: "pending",
          version: 0,
        });
      });

      it("writes no notice while notifications are off, and still decides", async () => {
        await setFlag("notifications.enabled", "off");
        const made = await file();

        await as(U.social).approve({ id: made.id, version: 0, note: null });

        expect((await stored(made.id)).status).toBe("approved");
        expect(await noticesFor(U.headA)).toEqual([]);
      });
    });

    describe("edit (the Social director only)", () => {
      const edited = (made: { id: string; version: number }, over = {}) => ({
        id: made.id,
        version: made.version,
        ...input(),
        ccaID: undefined,
        ...over,
      });

      it("the Social director edits a pending request in place: still pending, version up, heads told", async () => {
        const made = await file();

        const res = await as(U.social).update(
          edited(made, { plates: 10, title: "Smaller" }) as never,
        );

        expect(res).toMatchObject({ status: "pending", version: 1 });
        expect(await stored(made.id)).toMatchObject({
          plates: 10,
          title: "Smaller",
        });
        expect(await noticesFor(U.headA, "disposable.edited")).toHaveLength(1);
        expect(await noticesFor(U.social)).toEqual([]);
      });

      it("editing an approved request returns it to pending, clears the decision and tells the heads (Q22)", async () => {
        const made = await file();
        await as(U.social).approve({ id: made.id, version: 0, note: "ok" });
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });

        const res = await as(U.social).update(
          edited({ id: made.id, version: 1 }, { cups: 99 }) as never,
        );

        expect(res).toMatchObject({ status: "pending", version: 2 });
        expect(await stored(made.id)).toMatchObject({
          status: "pending",
          cups: 99,
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
        });
        for (const head of [U.headA, U.headA2]) {
          const notes = await noticesFor(head, "disposable.edited");
          expect(notes).toHaveLength(1);
          expect(notes[0]!.body).toContain("pending again");
        }
        expect(await noticesFor(U.social)).toEqual([]);
      });

      it("the Social director edits a rejected request and it stays rejected", async () => {
        const made = await file();
        await as(U.social).reject({ id: made.id, version: 0, note: null });

        const res = await as(U.social).update(
          edited({ id: made.id, version: 1 }, { spoons: 3 }) as never,
        );

        expect(res.status).toBe("rejected");
        expect(await stored(made.id)).toMatchObject({
          spoons: 3,
          status: "rejected",
        });
      });

      it.each([
        ["a head of the same CCA", U.headA],
        ["another head of the same CCA", U.headA2],
        ["a head of another CCA", U.headB],
        ["a director of the requesting CCA", U.vetter],
        ["an admin", U.admin],
        ["a JCRC member", U.jcrc],
        ["an RF", U.scrc],
        ["a resident", U.resident],
      ])(
        "%s is refused update, delete, approve and reject with the same answer, whatever the session claims",
        async (_n, id) => {
          const made = await file();
          const caller = as(id);
          const answers = [
            await errorOf(caller.update(edited(made) as never)),
            await errorOf(caller.delete({ id: made.id })),
            await errorOf(
              caller.approve({ id: made.id, version: 0, note: null }),
            ),
            await errorOf(
              caller.reject({ id: made.id, version: 0, note: null }),
            ),
          ];
          expect(answers).toEqual([
            NOT_SOCIAL,
            NOT_SOCIAL,
            NOT_SOCIAL,
            NOT_SOCIAL,
          ]);
          expect(await stored(made.id)).toMatchObject({
            version: 0,
            status: "pending",
            title: "Hall dinner",
          });
        },
      );

      it("a head update of an approved request changes nothing and writes no notice", async () => {
        const made = await file();
        await as(U.social).approve({ id: made.id, version: 0, note: null });
        await db.notification.deleteMany({ where: { userID: { in: IDS } } });

        const res = await errorOf(
          as(U.headA).update(edited({ id: made.id, version: 1 }) as never),
        );

        expect(res).toBe(NOT_SOCIAL);
        expect(await stored(made.id)).toMatchObject({
          status: "approved",
          version: 1,
        });
        expect(await noticesFor(U.social)).toEqual([]);
        expect(await noticesFor(U.headA)).toEqual([]);
      });

      it("an unknown id is NOT_FOUND for the Social director", async () => {
        expect(
          await errorOf(
            as(U.social).update(
              edited({ id: "a".repeat(24), version: 0 }) as never,
            ),
          ),
        ).toBe(NOT_FOUND);
      });

      it("a stale version is a CONFLICT; two edits at once let one win", async () => {
        const made = await file();
        await as(U.social).update(edited(made) as never);
        expect(await errorOf(as(U.social).update(edited(made) as never))).toBe(
          CONFLICT,
        );

        const fresh = await file({ title: "second" });
        const results = await Promise.all([
          errorOf(
            as(U.social).update(edited(fresh, { title: "one" }) as never),
          ),
          errorOf(
            as(U.social).update(edited(fresh, { title: "two" }) as never),
          ),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect((await stored(fresh.id)).version).toBe(1);
      });

      it("an edit racing a decision: one wins, never both", async () => {
        const made = await file();

        const results = await Promise.all([
          errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          ),
          errorOf(as(U.social).update(edited(made, { plates: 1 }) as never)),
        ]);

        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect((await stored(made.id)).version).toBe(1);
      });

      it("approve racing delete: the row ends up gone, and an approved notice exists only if the approval won", async () => {
        const made = await file();

        const [approved, deleted] = await Promise.all([
          errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          ),
          errorOf(as(U.social).delete({ id: made.id })),
        ]);

        expect(deleted).toBe("ok");
        expect(["ok", NOT_FOUND, CONFLICT]).toContain(approved);
        expect(
          await db.disposableRequest.count({ where: { id: made.id } }),
        ).toBe(0);
        expect((await noticesFor(U.headA, "disposable.approved")).length).toBe(
          approved === "ok" ? 1 : 0,
        );
        expect(await noticesFor(U.headA, "disposable.deleted")).toHaveLength(1);
      });

      it("validates the edit like a new request", async () => {
        const made = await file();
        for (const over of [
          { plates: 0, cups: 0, bowls: 0, forks: 0, spoons: 0 },
          { collectionDay: "2020-01-01" },
          { title: "" },
          { plates: 501 },
        ]) {
          expect(
            (await errorOf(
              as(U.social).update(edited(made, over) as never),
            )) !== "ok",
            JSON.stringify(over),
          ).toBe(true);
        }
        expect((await stored(made.id)).version).toBe(0);
      });

      it("the day is checked only when it changes: other fields of a request whose day has passed can be corrected", async () => {
        const old = await db.disposableRequest.create({
          data: {
            ccaID: CCA_A,
            createdBy: U.headA,
            title: "Old",
            description: "",
            plates: 5,
            cups: 0,
            bowls: 0,
            forks: 0,
            spoons: 0,
            collectionDay: "2020-01-01",
            collectionTime: "10:00",
          },
        });
        const same = {
          id: old.id,
          version: 0,
          ...input({ collectionDay: "2020-01-01", title: "Corrected" }),
          ccaID: undefined,
        };

        expect(await errorOf(as(U.social).update(same as never))).toBe("ok");
        expect(await stored(old.id)).toMatchObject({
          title: "Corrected",
          collectionDay: "2020-01-01",
        });
        expect(
          await errorOf(
            as(U.social).update({
              ...same,
              version: 1,
              collectionDay: "2020-02-02",
            } as never),
          ),
        ).toBe("BAD_REQUEST:DISPOSABLE_DATE_PAST");
        expect(
          await errorOf(as(U.social).update({ ...same, version: 1 } as never)),
        ).toBe("ok");
        expect(
          await errorOf(
            as(U.social).update({
              ...same,
              version: 2,
              collectionDay: DAY,
            } as never),
          ),
        ).toBe("ok");
      });

      it("an edit cannot move the request to another CCA or link another CCA proposal", async () => {
        const made = await file();
        const other = await makeProposal(CCA_B);

        const res = await errorOf(
          as(U.social).update(
            edited(made, { ccaID: CCA_B, proposalID: other.id }) as never,
          ),
        );

        expect(res).toBe("BAD_REQUEST:DISPOSABLE_BAD_PROPOSAL");
        expect((await stored(made.id)).ccaID).toBe(CCA_A);
      });

      it("two edits racing to link one proposal: one wins, the other is told it is taken", async () => {
        const proposal = await makeProposal(CCA_A);
        const a = await file({ title: "a" });
        const b = await file({ title: "b" });
        const noPrecheck = withoutDuplicatePrecheck();

        const results = await Promise.all([
          errorOf(
            as(U.social, EVERYTHING, noPrecheck).update(
              edited(a, { proposalID: proposal.id }) as never,
            ),
          ),
          errorOf(
            as(U.social, EVERYTHING, noPrecheck).update(
              edited(b, { proposalID: proposal.id }) as never,
            ),
          ),
        ]);

        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results).toContain("CONFLICT:DISPOSABLE_PROPOSAL_TAKEN");
      });
    });

    describe("delete (the Social director only)", () => {
      it("deletes any request and tells the CCA's heads", async () => {
        const made = await file();

        await as(U.social).delete({ id: made.id });

        expect(
          await db.disposableRequest.count({ where: { id: made.id } }),
        ).toBe(0);
        expect(await noticesFor(U.headA, "disposable.deleted")).toHaveLength(1);
        expect(await noticesFor(U.headA2, "disposable.deleted")).toHaveLength(
          1,
        );
      });

      it.each([
        ["the CCA's head", U.headA],
        ["a JCRC member", U.jcrc],
        ["a director", U.vetter],
        ["an admin", U.admin],
        ["a resident", U.resident],
      ])("%s is refused", async (_n, id) => {
        const made = await file();
        expect(await errorOf(as(id).delete({ id: made.id }))).toBe(NOT_SOCIAL);
        expect(
          await db.disposableRequest.count({ where: { id: made.id } }),
        ).toBe(1);
      });

      it("a missing id is NOT_FOUND, and a second delete too", async () => {
        const made = await file();
        await as(U.social).delete({ id: made.id });
        expect(await errorOf(as(U.social).delete({ id: made.id }))).toBe(
          NOT_FOUND,
        );
      });

      it("if the notice cannot be written the delete is rolled back", async () => {
        const made = await file();
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);

        const result = await errorOf(
          as(U.social, EVERYTHING, withFailingNotices()).delete({
            id: made.id,
          }),
        );
        log.mockRestore();

        expect(result).not.toBe("ok");
        expect(
          await db.disposableRequest.count({ where: { id: made.id } }),
        ).toBe(1);
      });
    });

    describe("a failed role read refuses", () => {
      it("create, list and get refuse when the head read fails; nothing is written", async () => {
        const made = await file();
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        const down = withFailingRead("ccaHead");

        expect(
          await errorOf(as(U.headA, EVERYTHING, down).create(input() as never)),
        ).toBe(CHECK_FAILED);
        expect(await errorOf(as(U.headA, EVERYTHING, down).list({}))).toBe(
          CHECK_FAILED,
        );
        expect(
          await errorOf(as(U.headA, EVERYTHING, down).get({ id: made.id })),
        ).toBe(CHECK_FAILED);
        log.mockRestore();

        expect(
          await db.disposableRequest.count({ where: { ccaID: CCA_A } }),
        ).toBe(1);
      });

      it("logs the error name only", async () => {
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await errorOf(
          as(U.headA, EVERYTHING, withFailingRead("ccaHead")).list({}),
        );
        const text = log.mock.calls.map((c) => String(c[0])).join("\n");
        log.mockRestore();
        expect(text).toContain("disposable_access_read_failed");
        expect(text).not.toContain("db down");
        expect(text).not.toContain(U.headA);
      });
    });

    describe("one request per proposal, under a race", () => {
      it("simultaneous creates for one proposal: one wins and the rest are told it is taken", async () => {
        const proposal = await makeProposal(CCA_A);
        const noPrecheck = withoutDuplicatePrecheck();

        const results = await Promise.all(
          [U.headA, U.headA2, U.headA, U.headA2].map((id) =>
            errorOf(
              as(id, EVERYTHING, noPrecheck).create(
                input({ proposalID: proposal.id }) as never,
              ),
            ),
          ),
        );

        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r !== "ok")).toEqual([
          "CONFLICT:DISPOSABLE_PROPOSAL_TAKEN",
          "CONFLICT:DISPOSABLE_PROPOSAL_TAKEN",
          "CONFLICT:DISPOSABLE_PROPOSAL_TAKEN",
        ]);
        expect(
          await db.disposableRequest.count({
            where: { proposalID: proposal.id },
          }),
        ).toBe(1);
      });

      it("with the normal pre-check the same race gives the same answer", async () => {
        const proposal = await makeProposal(CCA_A);

        const results = await Promise.all(
          [U.headA, U.headA2].map((id) =>
            errorOf(as(id).create(input({ proposalID: proposal.id }) as never)),
          ),
        );

        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results).toContain("CONFLICT:DISPOSABLE_PROPOSAL_TAKEN");
      });
    });

    describe("the collection day is the Singapore day (UTC+8)", () => {
      it("at 15:59 UTC the Singapore day is still the 14th; at 16:00 UTC it is the 15th", async () => {
        const { createRequest } = await import(
          "~/server/api/services/disposables/write"
        );
        const day14 = input({ collectionDay: "2099-06-14" }) as never;

        const before = new Date("2099-06-14T15:59:59.999Z");
        const after = new Date("2099-06-14T16:00:00.000Z");

        await createRequest(db, U.headA, day14, before);
        await expect(createRequest(db, U.headA, day14, after)).rejects.toThrow(
          "DISPOSABLE_DATE_PAST",
        );
        // The 15th is fine from the new Singapore day on.
        await createRequest(
          db,
          U.headA,
          input({ collectionDay: "2099-06-15" }) as never,
          after,
        );
      });
    });

    describe("rate limits (per person, per action, one hour)", () => {
      it("the 21st create in an hour is refused with the wait, and nothing more is written", async () => {
        for (let i = 0; i < 20; i += 1) {
          await as(U.headA).create(input({ title: `r${i}` }) as never);
        }

        const res = await errorOf(as(U.headA).create(input() as never));

        expect(res).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);
        expect(
          await db.disposableRequest.count({ where: { ccaID: CCA_A } }),
        ).toBe(20);
        // Another person is not affected.
        expect(
          await errorOf(as(U.headB).create(input({ ccaID: CCA_B }) as never)),
        ).toBe("ok");
      });

      it("a person who may not act spends no budget", async () => {
        for (let i = 0; i < 3; i += 1) {
          await errorOf(as(U.resident).create(input() as never));
        }
        expect(
          await db.rateLimit.count({
            where: { key: `disposable.create:${U.resident}` },
          }),
        ).toBe(0);
      });
    });

    describe("nobody holds the Social director position: staff are told", () => {
      const NOW = new Date("2099-06-01T04:00:00Z");
      const run = (id: string) =>
        runDueCheck(db, id, { kinds: [kindUnderTest], now: NOW });
      const dueNotices = (id: string) =>
        db.notification.findMany({
          where: { userID: id, kind: "disposable.no_director" },
        });

      it("an admin, an RF and Hall Office each get one notice a day while a request waits", async () => {
        await file();
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.social } });

        for (const id of [U.admin, U.scrc, U.hall]) {
          expect((await run(id)).failedKinds).toEqual([]);
          await run(id);
          const notes = await dueNotices(id);
          expect(notes).toHaveLength(1);
          expect(notes[0]!.title).toContain("1 disposable request is waiting");
          expect(notes[0]!.href).toBe("/scrc");
          expect(notes[0]!.body ?? "").not.toContain("Hall dinner");
        }
      });

      it("nobody else is told, and nothing is written when no request waits, a Social director exists, or the flag is off", async () => {
        for (const id of [U.headA, U.jcrc, U.resident]) {
          await file();
          await db.jcrcPositionHolder.deleteMany({
            where: { userID: U.social },
          });
          await run(id);
          expect(await dueNotices(id)).toEqual([]);
        }
        await db.disposableRequest.deleteMany({ where: { ccaID: CCA_A } });
        await run(U.admin);
        expect(await dueNotices(U.admin)).toEqual([]);

        await file();
        await db.jcrcPosition.updateMany({
          where: { name: "TEST Social" },
          data: { handlesDisposables: true },
        });
        await db.jcrcPositionHolder.create({
          data: {
            positionID: (
              await db.jcrcPosition.findFirstOrThrow({
                where: { name: "TEST Social" },
              })
            ).id,
            userID: U.social,
            assignedBy: U.admin,
            endsAt: null,
          },
        });
        await run(U.admin);
        expect(await dueNotices(U.admin)).toEqual([]);

        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.social } });
        await setFlag("disposables.enabled", "off");
        await run(U.admin);
        expect(await dueNotices(U.admin)).toEqual([]);
      });

      it("a failed read writes nothing and names the kind", async () => {
        await file();
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        const down = proxied(db, (prop) =>
          prop === "disposableRequest" ? failingTable() : undefined,
        );

        const res = await runDueCheck(down, U.admin, {
          kinds: [kindUnderTest],
          now: NOW,
        });
        log.mockRestore();

        expect(res.failedKinds).toEqual([kindUnderTest.name]);
        expect(await dueNotices(U.admin)).toEqual([]);
      });
    });

    describe("account deletion", () => {
      it("keeps the request for the CCA and the Social director and clears the deleted person", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "../userAdmin"
        );
        const user = await db.user.create({
          data: { email: "e9991301@u.nus.edu", userID: U.headA },
        });
        const made = await file();
        await as(U.social).approve({ id: made.id, version: 0, note: "ok" });
        const theirs = await as(U.headB).create(
          input({ ccaID: CCA_B }) as never,
        );
        const socialUser = await db.user.create({
          data: { email: "e9991304@u.nus.edu", userID: U.social },
        });

        const first = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, user.id),
          U.admin,
        );
        expect(first.deleted).toMatchObject({ disposableRequesterCleared: 1 });
        const second = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, socialUser.id),
          U.admin,
        );
        expect(second.deleted).toMatchObject({ disposableDeciderCleared: 1 });

        expect(await stored(made.id)).toMatchObject({
          createdBy: null,
          decidedBy: null,
          status: "approved",
          decisionNote: "ok",
        });
        expect((await stored(theirs.id)).createdBy).toBe(U.headB);
      });

      it("a deleted Social director or director does not come back with a re-granted jcrc", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "../userAdmin"
        );
        const { isSocialDirector, isDirectorOf } = await import(
          "~/server/api/services/directorGuard"
        );
        const social = await db.user.create({
          data: { email: "e9991304@u.nus.edu", userID: U.social },
        });
        const vetter = await db.user.create({
          data: { email: "e9991306@u.nus.edu", userID: U.vetter },
        });
        await db.jcrcTerm.createMany({
          data: [U.social, U.vetter].map((userID) => ({
            userID,
            endsAt: new Date("2099-01-01T00:00:00Z"),
          })),
        });
        expect(await isSocialDirector(db, U.social)).toBe(true);
        expect(await isDirectorOf(db, U.vetter, CCA_A)).toBe(true);

        for (const user of [social, vetter]) {
          const res = await deleteUserAccountCascade(
            db,
            await loadAdminUserTarget(db, user.id),
            U.admin,
          );
          expect(res.deleted).toMatchObject({
            jcrcPositionHolder: 1,
            jcrcTerm: 1,
          });
        }
        expect(
          await db.jcrcPositionHolder.count({
            where: { userID: { in: [U.social, U.vetter] } },
          }),
        ).toBe(0);
        expect(
          await db.jcrcTerm.count({
            where: { userID: { in: [U.social, U.vetter] } },
          }),
        ).toBe(0);

        // The same NUS ids are granted jcrc again.
        await setRoles(U.social, ["resident", "jcrc"]);
        await setRoles(U.vetter, ["resident", "jcrc"]);

        expect(await isSocialDirector(db, U.social)).toBe(false);
        expect(await isDirectorOf(db, U.vetter, CCA_A)).toBe(false);
        const made = await file();
        expect(
          await errorOf(
            as(U.social).approve({ id: made.id, version: 0, note: null }),
          ),
        ).toBe(NOT_SOCIAL);
        expect((await stored(made.id)).status).toBe("pending");
      });
    });
  },
);
