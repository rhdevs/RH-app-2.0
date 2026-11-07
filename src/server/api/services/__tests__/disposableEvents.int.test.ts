import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type * as EventLinkModule from "../proposals/eventLink";
import type * as WriteModule from "../disposables/write";
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
 * INTEGRATION TESTS of disposable requests tagged to events (merge proposal
 * 4.9; A66 which events, A67 who may file, A9 who edits, A54 who reads) against
 * the LOCAL development database (skipped unless DATABASE_URL is the local dev
 * database; run `npm run test:db`). Run this file on its own.
 *
 * The tests own every row they touch: users E99918xx, CCAs 9021 and 9022
 * (heads, events, proposals and requests only; the CCA rows are never written),
 * events 99918001 and up, positions named "TEST ...", every `disposable.*`
 * notice. The five flag rows are put back as they were.
 */

const U = {
  headA: "E9991801", // heads CCA 9021
  headA2: "E9991802", // also heads CCA 9021
  headB: "E9991803", // heads CCA 9022
  former: "E9991804", // used to head CCA 9021 (cca_head role, no head row)
  social: "E9991805", // the Social director (jcrc, flagged position)
  jcrc: "E9991806", // live jcrc, no position
  oldJcrc: "E9991807", // jcrc whose term ended
  admin: "E9991808",
  resident: "E9991809",
};
const IDS = Object.values(U);
const CCA_A = 9021;
const CCA_B = 9022;
const CCAS = [CCA_A, CCA_B];
const EV = { a: 99918001, b: 99918002, hall: 99918003 };
const FLAGS = [
  "disposables.enabled",
  "directors.enabled",
  "notifications.enabled",
  "proposals.enabled",
  "events.enabled",
];
/** Session roles that claim every power: the server must not believe them. */
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const DAY = "2099-06-15";
const NOT_HEAD = "FORBIDDEN:NOT_CCA_HEAD";
const NOT_HALL = "FORBIDDEN:NOT_HALL_FILER";
const NOT_FOUND = "NOT_FOUND:DISPOSABLE_NOT_FOUND";
const NOT_SOCIAL = "FORBIDDEN:NOT_SOCIAL_DIRECTOR";
const TAKEN = "CONFLICT:DISPOSABLE_PROPOSAL_TAKEN";
const hour = 3600;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "disposable requests tagged to events (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let runDueCheck: typeof RunDueCheck;
    let link: typeof EventLinkModule;
    let write: typeof WriteModule;
    let resetDisposablesCache: () => void;
    let digestKind: DueKind;
    let noDirectorKind: DueKind;
    let today: string;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;

    const as = (userID: string, client: PrismaClient = db) =>
      createCaller({
        db: client as never,
        session: {
          user: {
            userID,
            roles: EVERYTHING,
            eligible: true,
            hasMatric: true,
            credentialsStale: false,
          },
          expires: new Date(Date.now() + 3600_000).toISOString(),
        } as never,
        headers: new Headers({
          "x-forwarded-for": `198.51.101.${(ipCounter += 1)}`,
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
      await db.rateLimit.deleteMany({
        where: { OR: IDS.map((id) => ({ key: { endsWith: `:${id}` } })) },
      });
      const proposals = await db.proposal.findMany({
        where: { ccaID: { in: CCAS } },
        select: { id: true },
      });
      const proposalIDs = proposals.map((p) => p.id);
      await db.proposalStatusHistory.deleteMany({
        where: { proposalID: { in: proposalIDs } },
      });
      await db.disposableRequest.deleteMany({
        where: {
          OR: [
            { ccaID: { in: CCAS } },
            { createdBy: { in: IDS } },
            { eventID: { gte: EV.a } },
            { proposalID: { in: proposalIDs } },
          ],
        },
      });
      await db.event.deleteMany({
        where: {
          OR: [{ eventID: { in: Object.values(EV) } }, { ccaID: { in: CCAS } }],
        },
      });
      await db.proposal.deleteMany({ where: { id: { in: proposalIDs } } });
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
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
      });

    const nowSeconds = () => Math.floor(Date.now() / 1000);

    /** An event the tests own, written directly (published, in a month). */
    const makeEvent = (
      eventID: number,
      ccaID: number | null,
      over: Record<string, unknown> = {},
    ) =>
      db.event.create({
        data: {
          eventID,
          ccaID,
          createdBy: U.headA,
          title: `TEST event ${eventID}`,
          startTime: nowSeconds() + 30 * 24 * hour,
          endTime: nowSeconds() + 30 * 24 * hour + 2 * hour,
          status: "published",
          updatedAt: new Date(),
          ...over,
        },
      });

    const content = (over: Record<string, unknown> = {}) => ({
      title: "Hall dinner",
      description: "Supper after the show",
      plates: 40,
      cups: 20,
      bowls: 0,
      forks: 40,
      spoons: 40,
      collectionDay: DAY,
      collectionTime: "18:30",
      ...over,
    });
    const forEvent = (eventID: number, over: Record<string, unknown> = {}) =>
      content({ eventID, proposalID: null, ...over }) as never;
    const forProposal = (proposalID: string, over = {}) =>
      content({ eventID: null, proposalID, ...over }) as never;

    const stored = (id: string) =>
      db.disposableRequest.findUniqueOrThrow({ where: { id } });
    /** Every disposable notice for a user, except the director's "filed" notice (#134), which the tests below that file requests would otherwise all have to account for. */
    const noticesFor = (userID: string) =>
      db.notification.findMany({
        where: {
          userID,
          kind: { startsWith: "disposable.", not: "disposable.filed" },
        },
      });

    const makeProposal = (ccaID: number, over: Record<string, unknown> = {}) =>
      db.proposal.create({
        data: {
          ccaID,
          category: "pubs",
          title: "  TEST proposal  ",
          description: "x",
          createdBy: U.headA,
          status: "cleared",
          willBeEvent: true,
          ...over,
        },
      });

    const makePosition = async (name: string, holder: string) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          vetsProposals: false,
          handlesDisposables: true,
        },
      });
      await db.jcrcPositionHolder.create({
        data: {
          positionID: p.id,
          userID: holder,
          assignedBy: U.admin,
          endsAt: null,
        },
      });
    };

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      link = await import("../proposals/eventLink");
      write = await import("../disposables/write");
      ({ resetDisposablesFlagCache: resetDisposablesCache } = await import(
        "../disposables/flag"
      ));
      ({ collectionDigestKind: digestKind } = await import(
        "~/server/api/services/dueCheck/collectionDigest"
      ));
      ({ disposablesNoDirectorKind: noDirectorKind } = await import(
        "~/server/api/services/dueCheck/disposablesNoDirector"
      ));
      const { sgtDayKey } = await import("~/lib/time/sgt");
      today = sgtDayKey(new Date());
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.social, U.jcrc, U.oldJcrc]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      for (const id of [U.headA, U.headA2, U.headB, U.former]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.resident, ["resident"]);
      await db.jcrcTerm.create({
        data: { userID: U.oldJcrc, endsAt: new Date(Date.now() - 1000) },
      });
      for (const [userID, ccaID] of [
        [U.headA, CCA_A],
        [U.headA2, CCA_A],
        [U.headB, CCA_B],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Social", U.social);
      await makeEvent(EV.a, CCA_A);
      await makeEvent(EV.b, CCA_B);
      await makeEvent(EV.hall, null);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("who can file (A67)", () => {
      it("a CCA's event: only a current head of that CCA", async () => {
        for (const id of [U.headA, U.headA2]) {
          expect(await errorOf(as(id).create(forEvent(EV.a)))).toBe("ok");
        }
        const refused = [
          U.former,
          U.headB,
          U.jcrc,
          U.social,
          U.admin,
          U.oldJcrc,
          U.resident,
        ];
        for (const id of refused) {
          expect(await errorOf(as(id).create(forEvent(EV.a))), id).toBe(
            NOT_HEAD,
          );
        }
        expect(await db.disposableRequest.count({})).toBe(2);
      });

      it("a hall-wide event: a live jcrc member or an admin, and no head", async () => {
        for (const id of [U.jcrc, U.social, U.admin]) {
          expect(await errorOf(as(id).create(forEvent(EV.hall))), id).toBe(
            "ok",
          );
        }
        for (const id of [U.oldJcrc, U.headA, U.headB, U.former, U.resident]) {
          expect(await errorOf(as(id).create(forEvent(EV.hall))), id).toBe(
            NOT_HALL,
          );
        }
        expect(await db.disposableRequest.count({})).toBe(3);
      });

      it("a CCA's proposal follows the same rule as its event", async () => {
        const proposal = await makeProposal(CCA_A);
        for (const id of [U.admin, U.jcrc, U.headB, U.former, U.resident]) {
          expect(
            await errorOf(as(id).create(forProposal(proposal.id))),
            id,
          ).toBe(NOT_HEAD);
        }
        const made = await as(U.headA).create(forProposal(proposal.id));
        const row = await stored(made.id);
        expect(row).toMatchObject({
          ccaID: CCA_A,
          eventID: null,
          eventTitle: null,
          proposalID: proposal.id,
          status: "pending",
        });
      });

      it("a stranger learns nothing about a canceled or ended event", async () => {
        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { status: "canceled" },
        });
        expect(await errorOf(as(U.headB).create(forEvent(EV.a)))).toBe(
          NOT_HEAD,
        );
        expect(await errorOf(as(U.headA).create(forEvent(EV.a)))).toBe(
          "BAD_REQUEST:DISPOSABLE_EVENT_CANCELED",
        );
      });

      it("neither an event nor a proposal, and an event that does not exist, are refused", async () => {
        const none = content({ eventID: null, proposalID: null }) as never;
        expect(await errorOf(as(U.headA).create(none))).toContain(
          "Choose the event",
        );
        expect(await errorOf(as(U.headA).create(forEvent(99918999)))).toBe(
          "BAD_REQUEST:DISPOSABLE_BAD_EVENT",
        );
      });

      it("the CCA in the input is ignored: it comes from the event", async () => {
        const made = await as(U.headA).create(forEvent(EV.a, { ccaID: CCA_B }));
        expect((await stored(made.id)).ccaID).toBe(CCA_A);
        expect(await errorOf(as(U.headA).create(forEvent(EV.b)))).toBe(
          NOT_HEAD,
        );
      });
    });

    describe("which events can be tagged (A66)", () => {
      const refusal = (code: string) => `BAD_REQUEST:${code}`;

      it("draft, submitted, published, changes requested, no status and an unknown status can; canceled and declined cannot", async () => {
        const cases: Array<[string | null, string]> = [
          ["draft", "ok"],
          ["submitted", "ok"],
          ["published", "ok"],
          ["changes_requested", "ok"],
          [null, "ok"],
          ["something_new", "ok"],
          ["canceled", refusal("DISPOSABLE_EVENT_CANCELED")],
          ["declined", refusal("DISPOSABLE_EVENT_DECLINED")],
        ];
        for (const [status, expected] of cases) {
          await db.event.updateMany({
            where: { eventID: EV.a },
            data: { status },
          });
          expect(
            await errorOf(as(U.headA).create(forEvent(EV.a))),
            String(status),
          ).toBe(expected);
        }
      });

      it("an event that has ended cannot; one ending in a second, or with no end yet, can", async () => {
        const set = (endTime: number | null) =>
          db.event.updateMany({ where: { eventID: EV.a }, data: { endTime } });

        await set(nowSeconds() - 1);
        expect(await errorOf(as(U.headA).create(forEvent(EV.a)))).toBe(
          refusal("DISPOSABLE_EVENT_ENDED"),
        );
        await set(nowSeconds());
        expect(await errorOf(as(U.headA).create(forEvent(EV.a)))).toBe(
          refusal("DISPOSABLE_EVENT_ENDED"),
        );
        await set(nowSeconds() + 60);
        expect(await errorOf(as(U.headA).create(forEvent(EV.a)))).toBe("ok");
        await set(null);
        expect(await errorOf(as(U.headA).create(forEvent(EV.a)))).toBe("ok");
      });

      it("an event with no title cannot", async () => {
        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { title: "  " },
        });
        expect(await errorOf(as(U.headA).create(forEvent(EV.a)))).toBe(
          refusal("DISPOSABLE_EVENT_UNTITLED"),
        );
      });

      it("a refused tag writes nothing and spends no extra request", async () => {
        await db.event.updateMany({
          where: { eventID: EV.hall },
          data: { status: "declined" },
        });
        await errorOf(as(U.jcrc).create(forEvent(EV.hall)));
        expect(await db.disposableRequest.count({})).toBe(0);
      });

      it("the picker lists only what the person may tag now, by the same rules", async () => {
        await makeEvent(99918010, CCA_A, { status: "canceled" });
        await makeEvent(99918011, CCA_A, { status: "declined" });
        await makeEvent(99918012, CCA_A, { endTime: nowSeconds() - 5 });
        await makeEvent(99918013, CCA_A, { title: null });
        await makeEvent(99918014, CCA_A, { status: "draft", endTime: null });

        const ids = (rows: Array<{ eventID: number }>) =>
          rows.map((r) => r.eventID).sort();

        expect(ids(await as(U.headA).eventChoices())).toEqual(
          [EV.a, 99918014].sort(),
        );
        expect(ids(await as(U.headB).eventChoices())).toEqual([EV.b]);
        expect(ids(await as(U.jcrc).eventChoices())).toEqual([EV.hall]);
        expect(ids(await as(U.admin).eventChoices())).toEqual([EV.hall]);
        expect(await as(U.resident).eventChoices()).toEqual([]);
        expect(await as(U.former).eventChoices()).toEqual([]);
        expect(await as(U.oldJcrc).eventChoices()).toEqual([]);
      });

      it("canFile says yes only to a person who could file now", async () => {
        const can = async (id: string, eventID: number) =>
          (await as(id).canFile({ eventID })).canFile;
        expect(await can(U.headA, EV.a)).toBe(true);
        expect(await can(U.admin, EV.a)).toBe(false);
        expect(await can(U.headB, EV.a)).toBe(false);
        expect(await can(U.jcrc, EV.hall)).toBe(true);
        expect(await can(U.admin, EV.hall)).toBe(true);
        expect(await can(U.headA, EV.hall)).toBe(false);
        expect(await can(U.resident, EV.hall)).toBe(false);
        expect(await can(U.headA, 99918999)).toBe(false);
        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { status: "canceled" },
        });
        expect(await can(U.headA, EV.a)).toBe(false);
      });
    });

    describe("several requests on one event, and one per proposal", () => {
      it("a CCA event takes any number of requests, each with the title kept at filing", async () => {
        const first = await as(U.headA).create(forEvent(EV.a, { title: "1" }));
        const second = await as(U.headA2).create(
          forEvent(EV.a, { title: "2" }),
        );
        const third = await as(U.headA).create(forEvent(EV.a, { title: "3" }));

        for (const made of [first, second, third]) {
          expect(await stored(made.id)).toMatchObject({
            eventID: EV.a,
            eventTitle: `TEST event ${EV.a}`,
            ccaID: CCA_A,
          });
        }
        const seen = await as(U.social).get({ id: first.id });
        expect(seen.sameEvent.map((r) => r.id).sort()).toEqual(
          [second.id, third.id].sort(),
        );
        const byHead = await as(U.headA).get({ id: second.id });
        expect(byHead.sameEvent).toHaveLength(2);
      });

      it("one request per proposal is still enforced, with the event or without", async () => {
        const proposal = await makeProposal(CCA_A);
        await as(U.headA).create(forProposal(proposal.id));

        expect(
          await errorOf(as(U.headA2).create(forProposal(proposal.id))),
        ).toBe(TAKEN);

        await db.proposal.update({
          where: { id: proposal.id },
          data: { eventID: EV.a },
        });
        expect(
          await errorOf(
            as(U.headA).create(forEvent(EV.a, { proposalID: proposal.id })),
          ),
        ).toBe(TAKEN);
      });

      it("a proposal that already has an event is refused with a pointer to the event", async () => {
        const proposal = await makeProposal(CCA_A, { eventID: EV.a });
        expect(
          await errorOf(as(U.headA).create(forProposal(proposal.id))),
        ).toBe(`BAD_REQUEST:DISPOSABLE_PROPOSAL_HAS_EVENT:${EV.a}`);
        expect(await db.disposableRequest.count({})).toBe(0);
      });

      it("a proposal whose event is gone counts as having none", async () => {
        const proposal = await makeProposal(CCA_A, { eventID: 99918555 });
        const made = await as(U.headA).create(forProposal(proposal.id));
        expect((await stored(made.id)).eventID).toBeNull();
      });

      it("a draft, canceled or event-less proposal: draft and canceled are refused, the rest can be tagged", async () => {
        const cases: Array<[string, string]> = [
          ["draft", "BAD_REQUEST:DISPOSABLE_PROPOSAL_NOT_OPEN"],
          ["canceled", "BAD_REQUEST:DISPOSABLE_PROPOSAL_NOT_OPEN"],
          ["in_review", "ok"],
          ["needs_action", "ok"],
          ["cleared", "ok"],
          ["finished", "ok"],
        ];
        for (const [status, expected] of cases) {
          const proposal = await makeProposal(CCA_A, { status });
          expect(
            await errorOf(as(U.headA).create(forProposal(proposal.id))),
            status,
          ).toBe(expected);
        }
        expect(await db.disposableRequest.count({})).toBe(4);
      });

      it("a stranger filing for a draft proposal is told they cannot file, not what state it is in", async () => {
        const proposal = await makeProposal(CCA_A, { status: "draft" });
        expect(
          await errorOf(as(U.headB).create(forProposal(proposal.id))),
        ).toBe(NOT_HEAD);
      });

      it("a failed tag step after the save is logged by name and the saved request is returned", async () => {
        const proposal = await makeProposal(CCA_A);
        let reads = 0;
        const failing = new Proxy(db, {
          get(target, prop) {
            if (prop === "proposal") {
              return new Proxy(target.proposal, {
                get(t, p) {
                  if (p === "findUnique") {
                    return (args: never) => {
                      reads += 1;
                      // The 1st read resolves the tag; the 2nd is the re-read after the save.
                      if (reads === 2) {
                        const err = new Error(
                          "secret detail the log must not carry",
                        );
                        err.name = "TagReadFailed";
                        return Promise.reject(err);
                      }
                      return (t.findUnique as (a: never) => unknown)(args);
                    };
                  }
                  const v = Reflect.get(t, p) as unknown;
                  return typeof v === "function"
                    ? (v as (...x: unknown[]) => unknown).bind(t)
                    : v;
                },
              });
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function"
              ? (v as (...x: unknown[]) => unknown).bind(target)
              : v;
          },
        });
        const logged: string[] = [];
        const spy = vi.spyOn(console, "error").mockImplementation((m) => {
          logged.push(String(m));
        });
        try {
          const made = await as(U.headA, failing).create(
            forProposal(proposal.id),
          );
          expect(reads).toBeGreaterThanOrEqual(2);
          expect(await stored(made.id)).toMatchObject({
            proposalID: proposal.id,
            eventID: null,
          });
          expect(logged.join(" ")).toContain("disposable_tag_failed");
          expect(logged.join(" ")).toContain("TagReadFailed");
          expect(logged.join(" ")).not.toContain("secret detail");
          // A retry is refused only because the request is there, as it should be.
          expect(
            await errorOf(as(U.headA).create(forProposal(proposal.id))),
          ).toBe(TAKEN);
        } finally {
          spy.mockRestore();
        }
      });

      it("both given: only when the proposal's event is that event", async () => {
        const free = await makeProposal(CCA_A);
        expect(
          await errorOf(
            as(U.headA).create(forEvent(EV.a, { proposalID: free.id })),
          ),
        ).toBe("BAD_REQUEST:DISPOSABLE_EVENT_MISMATCH");

        const linked = await makeProposal(CCA_A, { eventID: EV.a });
        const made = await as(U.headA).create(
          forEvent(EV.a, { proposalID: linked.id }),
        );
        expect(await stored(made.id)).toMatchObject({
          eventID: EV.a,
          proposalID: linked.id,
        });
      });
    });

    describe("a proposal's event is made (A66)", () => {
      it("request first, event second: the request moves to the event and keeps the proposal", async () => {
        const proposal = await makeProposal(CCA_A);
        const made = await as(U.headA).create(forProposal(proposal.id));
        const before = await stored(made.id);

        const result = await link.createEventFromProposal(
          db,
          U.headA,
          proposal.id,
        );

        expect(result.created).toBe(true);
        const after = await stored(made.id);
        expect(after).toMatchObject({
          eventID: result.eventID,
          eventTitle: "TEST proposal",
          ccaID: CCA_A,
          proposalID: proposal.id,
          status: "pending",
          version: before.version,
        });
        const event = await db.event.findUniqueOrThrow({
          where: { eventID: result.eventID! },
        });
        expect(event.title).toBe("TEST proposal");
        const got = await as(U.headA).get({ id: made.id });
        expect(got.event).toMatchObject({
          eventID: result.eventID,
          title: "TEST proposal",
          state: "ok",
        });
      });

      it("event claimed first, request filed before the event row exists: the last step moves it", async () => {
        const proposal = await makeProposal(CCA_A);
        let filed: { id: string } | null = null;
        const hooked = new Proxy(db, {
          get(target, prop) {
            if (prop === "event") {
              return new Proxy(target.event, {
                get(t, p) {
                  if (p === "create") {
                    return async (args: never) => {
                      // The claim has committed; the Event does not exist yet.
                      filed = await as(U.headA).create(
                        forProposal(proposal.id),
                      );
                      return (t.create as (a: never) => unknown)(args);
                    };
                  }
                  const v = Reflect.get(t, p) as unknown;
                  return typeof v === "function"
                    ? (v as (...x: unknown[]) => unknown).bind(t)
                    : v;
                },
              });
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function"
              ? (v as (...x: unknown[]) => unknown).bind(target)
              : v;
          },
        });

        const result = await link.createEventFromProposal(
          hooked,
          U.headA,
          proposal.id,
        );

        expect(result.created).toBe(true);
        expect(filed).not.toBeNull();
        expect(await stored(filed!.id)).toMatchObject({
          eventID: result.eventID,
          eventTitle: "TEST proposal",
          ccaID: CCA_A,
          proposalID: proposal.id,
        });
      });

      it("event made between the check and the commit: the new request is tagged, not refused", async () => {
        const proposal = await makeProposal(CCA_A);
        let eventID: number | null = null;
        const hooked = new Proxy(db, {
          get(target, prop) {
            if (prop === "disposableRequest") {
              return new Proxy(target.disposableRequest, {
                get(t, p) {
                  if (p === "create") {
                    return async (args: never) => {
                      // After the pre-check, before the request is written.
                      const made = await link.createEventFromProposal(
                        target,
                        U.headA,
                        proposal.id,
                      );
                      eventID = made.eventID;
                      return (t.create as (a: never) => unknown)(args);
                    };
                  }
                  const v = Reflect.get(t, p) as unknown;
                  return typeof v === "function"
                    ? (v as (...x: unknown[]) => unknown).bind(t)
                    : v;
                },
              });
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function"
              ? (v as (...x: unknown[]) => unknown).bind(target)
              : v;
          },
        });

        const made = await write.createRequest(
          hooked,
          U.headA,
          forProposal(proposal.id) as never,
        );

        expect(eventID).not.toBeNull();
        expect(await stored(made.id)).toMatchObject({
          eventID,
          eventTitle: "TEST proposal",
          ccaID: CCA_A,
          proposalID: proposal.id,
        });
      });

      it("a proposal made into an event whose request was filed once does not take a second", async () => {
        const proposal = await makeProposal(CCA_A);
        await as(U.headA).create(forProposal(proposal.id));
        const result = await link.createEventFromProposal(
          db,
          U.headA,
          proposal.id,
        );
        expect(
          await errorOf(
            as(U.headA2).create(
              forEvent(result.eventID!, { proposalID: proposal.id }),
            ),
          ),
        ).toBe(TAKEN);
        expect(
          await errorOf(as(U.headA2).create(forProposal(proposal.id))),
        ).toBe(`BAD_REQUEST:DISPOSABLE_PROPOSAL_HAS_EVENT:${result.eventID}`);
      });
    });

    describe("a write conflict on the claim, a dangling claim and the picker's scan", () => {
      /**
       * A client whose first `failures` transactions end in a write conflict
       * (P2034), as when someone edits the request the claim moves. Before each
       * failure `before` may change the stored state, as a rival claim would.
       */
      const conflicting = async (
        failures: number,
        before?: (call: number) => Promise<void>,
      ) => {
        const { Prisma } = await import("@prisma/client");
        let calls = 0;
        const client = new Proxy(db, {
          get(target, prop) {
            if (prop === "$transaction") {
              return async (...args: unknown[]) => {
                calls += 1;
                if (calls <= failures) {
                  await before?.(calls);
                  throw new Prisma.PrismaClientKnownRequestError("conflict", {
                    code: "P2034",
                    clientVersion: "test",
                  });
                }
                return (
                  target.$transaction as unknown as (
                    ...a: unknown[]
                  ) => Promise<unknown>
                )(...args);
              };
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function"
              ? (v as (...x: unknown[]) => unknown).bind(target)
              : v;
          },
        });
        return { client, calls: () => calls };
      };

      /** A client that runs `hook` just before the request row is written. */
      const beforeRequestCreate = (hook: () => Promise<void>) =>
        new Proxy(db, {
          get(target, prop) {
            if (prop === "disposableRequest") {
              return new Proxy(target.disposableRequest, {
                get(t, p) {
                  if (p === "create") {
                    return async (args: never) => {
                      await hook();
                      return (t.create as (a: never) => unknown)(args);
                    };
                  }
                  const v = Reflect.get(t, p) as unknown;
                  return typeof v === "function"
                    ? (v as (...x: unknown[]) => unknown).bind(t)
                    : v;
                },
              });
            }
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function"
              ? (v as (...x: unknown[]) => unknown).bind(target)
              : v;
          },
        });

      const eventsOfProposal = () =>
        db.event.findMany({
          where: { ccaID: CCA_A, title: "TEST proposal" },
          select: { eventID: true },
        });

      it("a conflict with no other claimer is retried, then the event is made and the request moves", async () => {
        const proposal = await makeProposal(CCA_A);
        const made = await as(U.headA).create(forProposal(proposal.id));
        const { client, calls } = await conflicting(1);

        const result = await link.createEventFromProposal(
          client,
          U.headA,
          proposal.id,
        );

        expect(result.created).toBe(true);
        expect(calls()).toBe(2);
        const events = await eventsOfProposal();
        expect(events.map((e) => e.eventID)).toEqual([result.eventID]);
        expect(
          (await db.proposal.findUniqueOrThrow({ where: { id: proposal.id } }))
            .eventID,
        ).toBe(result.eventID);
        expect(await stored(made.id)).toMatchObject({
          eventID: result.eventID,
          eventTitle: "TEST proposal",
        });
      });

      it("a conflict while another press holds the claim is a lost race, and makes nothing", async () => {
        const proposal = await makeProposal(CCA_A);
        const { client, calls } = await conflicting(1, async () => {
          await db.proposal.update({
            where: { id: proposal.id },
            data: { eventID: 99918060, eventClaimedAt: new Date() },
          });
        });

        const result = await link.createEventFromProposal(
          client,
          U.headA,
          proposal.id,
        );

        expect(result).toEqual({ created: false, eventID: 99918060 });
        expect(calls()).toBe(1);
        expect(await eventsOfProposal()).toEqual([]);
      });

      it("a conflict that never clears is rethrown to the failure path, not read as already linked", async () => {
        const proposal = await makeProposal(CCA_A);
        const { client, calls } = await conflicting(99);

        await expect(
          link.createEventFromProposal(client, U.headA, proposal.id),
        ).rejects.toMatchObject({ code: "P2034" });
        expect(calls()).toBe(3);

        expect(await link.draftEventAfterApproval(client, proposal.id)).toBe(
          "failed",
        );
        const failed = await db.notification.findMany({
          where: { userID: U.headA, kind: "proposal.event_draft_failed" },
        });
        expect(failed).toHaveLength(1);
        expect(await eventsOfProposal()).toEqual([]);
        expect(
          (await db.proposal.findUniqueOrThrow({ where: { id: proposal.id } }))
            .eventID,
        ).toBeNull();
      });

      it("two presses with a request filed make one event and tag the request once", async () => {
        const proposal = await makeProposal(CCA_A);
        const made = await as(U.headA).create(forProposal(proposal.id));

        const settled = await Promise.allSettled([
          link.createEventFromProposal(db, U.headA, proposal.id),
          link.createEventFromProposal(db, U.headA2, proposal.id),
        ]);

        const won = settled.flatMap((s) =>
          s.status === "fulfilled" && s.value.created ? [s.value] : [],
        );
        expect(won).toHaveLength(1);
        const events = await eventsOfProposal();
        expect(events.map((e) => e.eventID)).toEqual([won[0]!.eventID]);
        expect(await stored(made.id)).toMatchObject({
          eventID: won[0]!.eventID,
          eventTitle: "TEST proposal",
          proposalID: proposal.id,
        });
      });

      it("a filing resolved during the claim, inserted after the final move, ends tagged", async () => {
        const { moveProposalRequestToEvent } = await import(
          "../disposables/eventTag"
        );
        const proposal = await makeProposal(CCA_A);
        const claimed = 99918070;
        await db.proposal.update({
          where: { id: proposal.id },
          data: { eventID: claimed, eventClaimedAt: new Date() },
        });
        // The filing resolved its target during the claim (no Event row yet).
        // Before it inserts, the Event is made and the final move runs: it
        // finds no request.
        const client = beforeRequestCreate(async () => {
          await makeEvent(claimed, CCA_A, { title: "TEST proposal" });
          await db.$transaction((tx) =>
            moveProposalRequestToEvent(tx, {
              proposalID: proposal.id,
              eventID: claimed,
              proposalTitle: "TEST proposal",
              ccaID: CCA_A,
            }),
          );
        });

        const made = await write.createRequest(
          client,
          U.headA,
          forProposal(proposal.id) as never,
        );

        expect(await stored(made.id)).toMatchObject({
          eventID: claimed,
          eventTitle: "TEST proposal",
          ccaID: CCA_A,
          proposalID: proposal.id,
        });
      });

      it("a claim with no Event row (dangling or in flight) does not tag the request", async () => {
        const proposal = await makeProposal(CCA_A);
        const client = beforeRequestCreate(async () => {
          await db.proposal.update({
            where: { id: proposal.id },
            data: { eventID: 99918071, eventClaimedAt: new Date() },
          });
        });

        const made = await write.createRequest(
          client,
          U.headA,
          forProposal(proposal.id) as never,
        );

        expect(await stored(made.id)).toMatchObject({
          eventID: null,
          eventTitle: null,
          proposalID: proposal.id,
        });
      });

      it("more than 300 old events do not crowd an upcoming one out of the picker", async () => {
        const old = nowSeconds() - 400 * 24 * hour;
        await db.event.createMany({
          data: Array.from({ length: 305 }, (_, i) => ({
            eventID: 99919000 + i,
            ccaID: CCA_A,
            createdBy: U.headA,
            title: `TEST old ${i}`,
            startTime: old + i * hour,
            endTime: null,
            status: "published",
            updatedAt: new Date(),
          })),
        });

        const choices = await as(U.headA).eventChoices();

        expect(choices).toHaveLength(100);
        expect(choices.at(-1)?.eventID).toBe(EV.a);
        const starts = choices.map((c) => c.startTime ?? 0);
        expect(starts).toEqual([...starts].sort((a, b) => a - b));
      });
    });

    describe("a canceled event, a renamed event and a deleted one", () => {
      it("a canceled event's requests keep their status, show as canceled, and can still be approved", async () => {
        const made = await as(U.headA).create(forEvent(EV.a));
        const before = await stored(made.id);

        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { status: "canceled" },
        });

        expect(await stored(made.id)).toMatchObject({
          status: "pending",
          version: before.version,
        });
        const asHead = await as(U.headA).get({ id: made.id });
        expect(asHead.status).toBe("pending");
        expect(asHead.event?.state).toBe("canceled");
        const list = await as(U.social).list({});
        expect(list.items[0]!.event?.state).toBe("canceled");

        const decided = await as(U.social).approve({
          id: made.id,
          version: 0,
          note: null,
        });
        expect(decided.status).toBe("approved");
      });

      it("a declined event shows as declined; the request is unchanged", async () => {
        const made = await as(U.headA).create(forEvent(EV.a));
        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { status: "declined" },
        });
        expect((await as(U.headA).get({ id: made.id })).event?.state).toBe(
          "declined",
        );
      });

      it("shows the live title while the event exists and the kept title once it is gone", async () => {
        const made = await as(U.headA).create(forEvent(EV.a));
        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { title: "Renamed night" },
        });
        expect((await as(U.headA).get({ id: made.id })).event).toMatchObject({
          title: "Renamed night",
          state: "ok",
        });

        await db.event.deleteMany({ where: { eventID: EV.a } });
        expect((await as(U.headA).get({ id: made.id })).event).toMatchObject({
          title: `TEST event ${EV.a}`,
          state: "gone",
        });
        expect((await stored(made.id)).eventID).toBe(EV.a);
      });

      it("an event's CCA does not change, so the request's CCA never needs to", async () => {
        const made = await as(U.headA).create(forEvent(EV.a));
        expect((await stored(made.id)).ccaID).toBe(CCA_A);
        expect(
          (await db.event.findUniqueOrThrow({ where: { eventID: EV.a } }))
            .ccaID,
        ).toBe(CCA_A);
      });
    });

    describe("update, delete and decide stay with the Social director (A9)", () => {
      it("a head cannot edit, decide or delete, and an edit cannot retag", async () => {
        const made = await as(U.headA).create(forEvent(EV.a));
        const edit = {
          id: made.id,
          version: 0,
          ...content({ title: "Edited" }),
        };

        expect(await errorOf(as(U.headA).update(edit as never))).toBe(
          NOT_SOCIAL,
        );
        expect(
          await errorOf(
            as(U.headA).approve({ id: made.id, version: 0, note: null }),
          ),
        ).toBe(NOT_SOCIAL);
        expect(await errorOf(as(U.headA).delete({ id: made.id }))).toBe(
          NOT_SOCIAL,
        );

        const retag = {
          ...edit,
          eventID: EV.b,
          ccaID: CCA_B,
          proposalID: null,
        };
        expect(await errorOf(as(U.social).update(retag as never))).toBe("ok");
        expect(await stored(made.id)).toMatchObject({
          title: "Edited",
          eventID: EV.a,
          ccaID: CCA_A,
          eventTitle: `TEST event ${EV.a}`,
        });
      });
    });

    describe("hall-wide requests (A54, A67)", () => {
      const fileHall = (id: string, over: Record<string, unknown> = {}) =>
        as(id).create(forEvent(EV.hall, over));

      it("stored with a null CCA and explicit nulls, never the sentinel 0", async () => {
        const made = await fileHall(U.jcrc);
        const row = await stored(made.id);
        expect(row.ccaID).toBeNull();
        expect(row.eventID).toBe(EV.hall);
        // A stored null, not a missing key: a `null` filter finds it.
        expect(
          await db.disposableRequest.count({
            where: { ccaID: null, id: made.id },
          }),
        ).toBe(1);
      });

      it("the filer reads it, lists it and nudges the Social director; another head does not", async () => {
        const made = await fileHall(U.admin);

        const got = await as(U.admin).get({ id: made.id });
        expect(got).toMatchObject({ hallWide: true, ccaID: null });
        expect(got.can.nudge).toBe(true);
        const list = await as(U.admin).list({});
        expect(list.items.map((r) => r.id)).toEqual([made.id]);
        expect(list.viewer.showHallWide).toBe(true);

        expect(await errorOf(as(U.headA).get({ id: made.id }))).toBe(NOT_FOUND);
        expect((await as(U.headA).list({})).items).toEqual([]);
        expect(await errorOf(as(U.headA).nudge({ id: made.id }))).toBe(
          NOT_FOUND,
        );

        const nudged = await as(U.admin).nudge({ id: made.id });
        expect(nudged.status).toBe("sent");
        expect((await noticesFor(U.social)).map((n) => n.kind)).toEqual([
          "disposable.nudge",
        ]);
      });

      it("an admin who filed one cannot read another admin's, and a resident reads nothing", async () => {
        const mine = await fileHall(U.admin);
        const theirs = await fileHall(U.jcrc);
        const list = await as(U.admin).list({});
        expect(list.items.map((r) => r.id)).toEqual([mine.id]);
        expect(await errorOf(as(U.admin).get({ id: theirs.id }))).toBe(
          NOT_FOUND,
        );
        expect(await errorOf(as(U.resident).list({}))).toMatch(/^FORBIDDEN:/);
      });

      it("the filer gets the outcome notices; heads of CCAs do not", async () => {
        const made = await fileHall(U.admin);
        await as(U.social).approve({ id: made.id, version: 0, note: "ok" });

        const mine = await noticesFor(U.admin);
        expect(mine.map((n) => n.kind)).toEqual(["disposable.approved"]);
        for (const id of [U.headA, U.headA2, U.headB]) {
          expect(await noticesFor(id)).toEqual([]);
        }

        await as(U.social).update({
          id: made.id,
          version: 1,
          ...content({ title: "Changed" }),
        } as never);
        expect((await noticesFor(U.admin)).length).toBeGreaterThan(1);
      });

      it("the Social director handles it as any other: approve, reject and delete", async () => {
        const a = await fileHall(U.jcrc, { title: "a" });
        const b = await fileHall(U.jcrc, { title: "b" });
        const c = await fileHall(U.jcrc, { title: "c" });
        expect(
          (await as(U.social).approve({ id: a.id, version: 0, note: null }))
            .status,
        ).toBe("approved");
        expect(
          (await as(U.social).reject({ id: b.id, version: 0, note: "no" }))
            .status,
        ).toBe("rejected");
        await as(U.social).delete({ id: c.id });
        expect(await db.disposableRequest.count({})).toBe(2);
      });

      it("after the filer's account is deleted it stays visible to the Social director, and to nobody else", async () => {
        const made = await fileHall(U.admin);
        await db.disposableRequest.update({
          where: { id: made.id },
          data: { createdBy: null },
        });

        expect((await as(U.social).list({})).items.map((r) => r.id)).toEqual([
          made.id,
        ]);
        expect(
          (await as(U.social).get({ id: made.id })).requestedBy,
        ).toBeNull();
        expect(await errorOf(as(U.admin).get({ id: made.id }))).toBe(NOT_FOUND);
        expect(await errorOf(as(U.headA).get({ id: made.id }))).toBe(NOT_FOUND);
        expect(
          (
            await as(U.social).approve({
              id: made.id,
              version: 0,
              note: null,
            })
          ).status,
        ).toBe("approved");
        expect(await noticesFor(U.admin)).toEqual([]);
      });

      it("the list filters by event and by hall-wide", async () => {
        const hall = await fileHall(U.jcrc);
        const cca = await as(U.headA).create(forEvent(EV.a));
        const ids = async (input: Record<string, unknown>) =>
          (await as(U.social).list(input as never)).items.map((r) => r.id);

        expect(await ids({ hallWide: true })).toEqual([hall.id]);
        expect(await ids({ eventID: EV.a })).toEqual([cca.id]);
        expect(await ids({ eventID: EV.hall })).toEqual([hall.id]);
        expect(await ids({ ccaID: CCA_A })).toEqual([cca.id]);
        expect((await ids({})).sort()).toEqual([hall.id, cca.id].sort());
        expect(
          (await as(U.headA).list({ hallWide: true } as never)).items,
        ).toEqual([]);
        expect(await ids({ eventID: EV.b })).toEqual([]);
      });
    });

    describe("the digest and the due checks with a null CCA", () => {
      it("a hall-wide request filed by a JCRC member shows in the digest and on the Social director's screen", async () => {
        const made = await as(U.jcrc).create(
          forEvent(EV.hall, { collectionDay: today }),
        );
        await as(U.social).approve({ id: made.id, version: 0, note: null });

        const digest = await as(U.social).digest();
        expect(digest.skipped).toBe(0);
        expect(digest.items).toHaveLength(1);
        expect(digest.items[0]).toMatchObject({
          id: made.id,
          hallWide: true,
          ccaName: null,
          eventTitle: `TEST event ${EV.hall}`,
          eventState: "ok",
        });

        const list = await as(U.social).list({});
        expect(list.skipped).toBe(0);
        expect(list.items.map((r) => r.id)).toEqual([made.id]);
        expect(list.items[0]).toMatchObject({
          hallWide: true,
          ccaID: null,
          status: "approved",
        });
        expect(list.items[0]!.event?.title).toBe(`TEST event ${EV.hall}`);
        expect(list.viewer.isSocialDirector).toBe(true);
      });

      it("the digest shows a canceled event's request with its state", async () => {
        const made = await as(U.headA).create(
          forEvent(EV.a, { collectionDay: today }),
        );
        await as(U.social).approve({ id: made.id, version: 0, note: null });
        await db.event.updateMany({
          where: { eventID: EV.a },
          data: { status: "canceled" },
        });
        const digest = await as(U.social).digest();
        expect(digest.items[0]).toMatchObject({
          eventState: "canceled",
          hallWide: false,
        });
        expect(await errorOf(as(U.admin).digest())).toBe(NOT_SOCIAL);
      });

      it("the daily digest notice counts a hall-wide collection", async () => {
        const NOW = new Date("2099-06-15T04:00:00Z");
        const made = await as(U.jcrc).create(forEvent(EV.hall));
        await as(U.social).approve({ id: made.id, version: 0, note: null });

        const res = await runDueCheck(db, U.social, {
          kinds: [digestKind],
          now: NOW,
        });

        expect(res.failedKinds).toEqual([]);
        const notes = await db.notification.findMany({
          where: { userID: U.social, kind: "disposable.digest" },
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]!.title).toBe("1 disposables collection today");
      });

      it("the no-director notice counts a hall-wide request waiting", async () => {
        const NOW = new Date("2099-06-01T04:00:00Z");
        await as(U.jcrc).create(forEvent(EV.hall));
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.social } });

        const res = await runDueCheck(db, U.admin, {
          kinds: [noDirectorKind],
          now: NOW,
        });

        expect(res.failedKinds).toEqual([]);
        const notes = await db.notification.findMany({
          where: { userID: U.admin, kind: "disposable.no_director" },
        });
        expect(notes).toHaveLength(1);
        expect(notes[0]!.title).toContain("1 disposable request is waiting");
      });

      it("a request with no CCA and no filer is not dropped from the digest or the list", async () => {
        const made = await as(U.jcrc).create(
          forEvent(EV.hall, { collectionDay: today }),
        );
        await as(U.social).approve({ id: made.id, version: 0, note: null });
        await db.disposableRequest.update({
          where: { id: made.id },
          data: { createdBy: null },
        });

        expect((await as(U.social).digest()).items).toHaveLength(1);
        expect((await as(U.social).list({})).items).toHaveLength(1);
      });
    });
  },
);
