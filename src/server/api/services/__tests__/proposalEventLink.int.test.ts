import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type * as EventLinkModule from "../proposals/eventLink";
import type * as EventsModule from "../events";
import type * as ProposalsFlagModule from "../proposals/flag";
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
 * INTEGRATION TESTS of the proposal-to-Event link (merge proposal 4.7; A32,
 * A33, A34, A39) against the LOCAL development database (skipped unless
 * DATABASE_URL is the local dev database; run `npm run test:db`). Run this
 * file on its own.
 *
 * The tests own every row they touch: users E99908xx, CCAs 9011 and 9012
 * (proposals, heads, positions and Events only; the CCA rows are never
 * written), positions named "TEST ...", every `proposal.*` notice. The four
 * flag rows are put back as they were. The Event counter only ever moves
 * forward, which is harmless.
 */

const U = {
  headA: "E9990801", // heads CCA 9011, writes the proposals
  headA2: "E9990802", // also heads CCA 9011
  headB: "E9990803", // heads CCA 9012
  dirA: "E9990804", // director of 9011
  dirHead: "E9990805", // director of 9011 AND head of 9011
  admin: "E9990806",
  resident: "E9990807",
};
const IDS = Object.values(U);
const CCA_A = 9011;
const CCA_B = 9012;
const CCAS = [CCA_A, CCA_B];
const FLAGS = [
  "proposals.enabled",
  "directors.enabled",
  "notifications.enabled",
  "events.enabled",
];
/** Session roles that claim every power: the server must not believe them. */
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const ALL_ACTIONS = [
  "create",
  "update",
  "submit",
  "upload",
  "approve",
  "return",
  "finish",
  "createEvent",
];
const NOT_FOUND = "NOT_FOUND:PROPOSAL_NOT_FOUND";
const START = 1_900_000_000;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "proposal to Event link (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let link: typeof EventLinkModule;
    let events: typeof EventsModule;
    let proposalsFlag: typeof ProposalsFlagModule;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;

    const callerFor = (
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
      });
    const as = (userID: string, roles?: string[], client?: PrismaClient) =>
      callerFor(userID, roles, client).proposal;

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
      events.resetEventsFlagCache();
      // proposals.enabled is cached for a few seconds as well.
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

    const clean = async () => {
      await db.rateLimit.deleteMany({
        where: {
          key: {
            in: ALL_ACTIONS.flatMap((a) =>
              IDS.map((id) => `proposal.${a}:${id}`),
            ),
          },
        },
      });
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
      await db.event.deleteMany({
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
          OR: [{ userID: { in: IDS } }, { kind: { startsWith: "proposal." } }],
        },
      });
      await db.roleAuditLog.deleteMany({
        where: {
          OR: [
            { actorUserID: { in: IDS } },
            { targetUserID: { in: IDS } },
            { action: "proposal.transition", targetCcaID: { in: CCAS } },
            { targetCcaID: { in: CCAS }, action: "event.delete" },
          ],
        },
      });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
      });

    const makePosition = async (
      name: string,
      ccaID: number,
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

    /** A delegate whose named methods are replaced; the rest pass through. */
    const delegateWith = (
      name: "proposal" | "event" | "counter",
      replaced: Record<string, (...a: never[]) => unknown>,
    ) => {
      const target = db[name] as unknown as Record<string, unknown>;
      return new Proxy(target, {
        get(t, p) {
          const swap = replaced[String(p)];
          if (swap) return swap;
          const v = Reflect.get(t, p, t) as unknown;
          return typeof v === "function"
            ? (v as (...a: unknown[]) => unknown).bind(t)
            : v;
        },
      });
    };

    /**
     * A database where the compare-and-set on Proposal waits until `parties`
     * callers have all reached it. Everything before it (the reads, the
     * dangling check, the id allocation) has therefore been passed by every
     * caller before any of them writes.
     */
    const barrierDb = (parties: number) => {
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timer = setTimeout(release, 8_000);
      const client = proxied(db, (prop) =>
        prop === "proposal"
          ? delegateWith("proposal", {
              updateMany: async (args: never) => {
                arrived += 1;
                if (arrived >= parties) release();
                await gate;
                clearTimeout(timer);
                return db.proposal.updateMany(args);
              },
            })
          : undefined,
      );
      return { client, arrived: () => arrived };
    };

    /** A database where creating an Event row fails. */
    const withFailingEventCreate = (): PrismaClient =>
      proxied(db, (prop) =>
        prop === "event"
          ? delegateWith("event", {
              create: () => Promise.reject(new Error("boom")),
            })
          : undefined,
      );

    /** A database where ONE flag key's read fails. */
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

    const captureErrors = () => {
      const spy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      return {
        text: () => spy.mock.calls.map((c) => String(c[0])).join("\n"),
        restore: () => spy.mockRestore(),
      };
    };

    type Opts = {
      willBeEvent?: boolean;
      to?: "in_review" | "cleared";
      creator?: string;
      ccaID?: number;
      blastMessage?: string | null;
      plannedStart?: number | null;
      plannedEnd?: number | null;
      /** Written straight onto the row before the director sees it. */
      patch?: Record<string, unknown>;
      approveWith?: PrismaClient;
    };

    /** A proposal written and approved through the real procedures. */
    const stage = async (opts: Opts = {}) => {
      const creator = opts.creator ?? U.headA;
      const made = await as(creator).create({
        ccaID: opts.ccaID ?? CCA_A,
        category: "pubs",
        title: "  Pub night  ",
        description: "A night out",
        blastMessage: opts.blastMessage ?? null,
        plannedStart: opts.plannedStart ?? null,
        plannedEnd: opts.plannedEnd ?? null,
        willBeEvent: opts.willBeEvent ?? true,
      });
      const sent = await as(creator).submit({ id: made.id, version: 0 });
      if (opts.patch) {
        await db.proposal.update({
          where: { id: made.id },
          data: opts.patch as never,
        });
      }
      if (opts.to === "in_review")
        return { id: made.id, version: sent.version };
      const done = await as(U.dirA, EVERYTHING, opts.approveWith).approve({
        id: made.id,
        version: sent.version,
      });
      return { id: made.id, version: done.version };
    };

    /** A proposal sent for review, ready for the director's approve call. */
    const submitted = async (willBeEvent: boolean) => {
      const s = await stage({ willBeEvent, to: "in_review" });
      return { id: s.id, version: s.version };
    };

    const eventsOf = () =>
      db.event.findMany({
        where: { OR: [{ ccaID: { in: CCAS } }, { createdBy: { in: IDS } }] },
      });
    /** Make a claim look old: past the window, so it counts as a failed create. */
    const ageClaim = (id: string) =>
      db.proposal.update({
        where: { id },
        data: { eventClaimedAt: new Date(Date.now() - 3 * 60_000) },
      });
    const rowOf = (id: string) =>
      db.proposal.findUniqueOrThrow({ where: { id } });
    const draftNotices = () =>
      db.notification.findMany({
        where: { kind: "proposal.event_drafted", userID: { in: IDS } },
      });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      link = await import("../proposals/eventLink");
      events = await import("../events");
      proposalsFlag = await import("../proposals/flag");
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      for (const key of FLAGS) await setFlag(key, "on");
      await setRoles(U.dirA, ["resident", "jcrc"]);
      await setRoles(U.dirHead, ["resident", "jcrc", "cca_head"]);
      for (const id of [U.headA, U.headA2, U.headB]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.resident, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, CCA_A],
        [U.headA2, CCA_A],
        [U.headB, CCA_B],
        [U.dirHead, CCA_A],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Link Dir A", CCA_A, U.dirA);
      await makePosition("Link Dir Head", CCA_A, U.dirHead);
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("approving with the field on (A33, A39)", () => {
      it("creates exactly one unpublished draft with the named fields and none of the excluded ones", async () => {
        const stored = await stage({
          blastMessage: "  Come along!  ",
          plannedStart: START,
          plannedEnd: START + 3600,
          patch: {
            posterUrl: "https://example.test/poster.png",
            docLink: "https://docs.example.com/plan",
          },
        });
        const rows = await eventsOf();
        expect(rows).toHaveLength(1);
        const event = rows[0]!;
        const proposal = await rowOf(stored.id);
        expect(proposal.status).toBe("cleared");
        expect(proposal.eventID).toBe(event.eventID);

        expect(event.status).toBe("draft");
        expect(event.publishedAt ?? null).toBeNull();
        expect(event.bookingID ?? null).toBeNull();
        expect(event.ccaID).toBe(CCA_A);
        expect(event.createdBy).toBe(U.headA);
        expect(event.title).toBe("Pub night");
        expect(event.description).toBe("A night out");
        expect(event.startTime).toBe(START);
        expect(event.endTime).toBe(START + 3600);
        expect(event.publicDescription).toBe("Come along!");
        // Not copied: the poster, the facility choices and the document link.
        expect(event.bannerUrl).toBeNull();
        expect(event.location).toBeNull();
        expect(event.facilityID).toBeNull();
        expect(event.capacity).toBeNull();
        expect(event.photoUrls).toEqual([]);
        expect(JSON.stringify(event)).not.toContain("example");
        expect(JSON.stringify(event)).not.toContain("pubs");
      });

      it("copies times only when both are set and the end is after the start", async () => {
        const onlyStart = await stage({ plannedStart: START });
        const equal = await stage({
          plannedStart: START,
          plannedEnd: START + 60,
          patch: { plannedEnd: START },
        });
        const a = await rowOf(onlyStart.id);
        const b = await rowOf(equal.id);
        const [first, second] = await Promise.all(
          [a, b].map((p) =>
            db.event.findUniqueOrThrow({ where: { eventID: p.eventID! } }),
          ),
        );
        for (const e of [first!, second!]) {
          expect(e.startTime).toBeNull();
          expect(e.endTime).toBeNull();
          expect(e.publicDescription).toBeNull();
        }
      });

      it("tells the CCA's heads, with a link to the draft", async () => {
        const stored = await stage();
        const proposal = await rowOf(stored.id);
        const notices = await draftNotices();
        expect(notices.map((n) => n.userID).sort()).toEqual(
          [U.headA, U.headA2, U.dirHead].sort(),
        );
        for (const n of notices) {
          expect(n.href).toBe(`/cca/${CCA_A}/events/${proposal.eventID}`);
        }
      });

      it("never publishes and never books", async () => {
        const stored = await stage();
        const proposal = await rowOf(stored.id);
        const event = await db.event.findUniqueOrThrow({
          where: { eventID: proposal.eventID! },
        });
        expect(event.status).toBe("draft");
      });

      it("makes nothing when the field is off, and the button then makes exactly one", async () => {
        const stored = await stage({ willBeEvent: false });
        expect(await eventsOf()).toHaveLength(0);
        expect((await rowOf(stored.id)).eventID).toBeNull();

        const first = await as(U.headA).createEvent({ id: stored.id });
        expect(first.created).toBe(true);
        const again = await as(U.headA2).createEvent({ id: stored.id });
        expect(again.created).toBe(false);
        expect(again.eventID).toBe(first.eventID);
        expect(await eventsOf()).toHaveLength(1);
      });
    });

    describe("repeats, retries and races create nothing more (A33)", () => {
      it("running the automatic step again changes nothing", async () => {
        const stored = await stage();
        await link.draftEventAfterApproval(db, stored.id);
        await link.draftEventAfterApproval(db, stored.id);
        expect(await eventsOf()).toHaveLength(1);
        expect(await draftNotices()).toHaveLength(3);
      });

      it("a second approval is refused and creates nothing", async () => {
        const stored = await stage();
        const refused = await errorOf(
          as(U.dirA).approve({ id: stored.id, version: stored.version }),
        );
        expect(refused).not.toBe("ok");
        expect(await eventsOf()).toHaveLength(1);
      });

      it("two buttons that both pass the read before either writes create one draft", async () => {
        const stored = await stage({ willBeEvent: false });
        const barrier = barrierDb(2);
        const results = await Promise.all([
          link.createEventFromProposal(barrier.client, U.headA, stored.id),
          link.createEventFromProposal(barrier.client, U.headA2, stored.id),
        ]);
        expect(barrier.arrived()).toBe(2);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        const rows = await eventsOf();
        expect(rows).toHaveLength(1);
        expect((await rowOf(stored.id)).eventID).toBe(rows[0]!.eventID);
      });

      it("the automatic step and a simultaneous button create one draft between them", async () => {
        // Approved while events were off, so nothing exists yet.
        await setFlag("events.enabled", null);
        const stored = await stage({ willBeEvent: true });
        expect(await eventsOf()).toHaveLength(0);
        await setFlag("events.enabled", "on");

        const barrier = barrierDb(2);
        const [, pressed] = await Promise.all([
          link.draftEventAfterApproval(barrier.client, stored.id),
          link.createEventFromProposal(barrier.client, U.headA, stored.id),
        ]);
        expect(barrier.arrived()).toBe(2);
        const rows = await eventsOf();
        expect(rows).toHaveLength(1);
        expect((await rowOf(stored.id)).eventID).toBe(rows[0]!.eventID);
        expect(typeof pressed.created).toBe("boolean");
      });

      it("two buttons racing on a dangling pointer create one draft", async () => {
        const stored = await stage({ willBeEvent: false });
        await db.proposal.update({
          where: { id: stored.id },
          data: { eventID: 987_654_321 },
        });
        const barrier = barrierDb(2);
        const results = await Promise.all([
          link.createEventFromProposal(barrier.client, U.headA, stored.id),
          link.createEventFromProposal(barrier.client, U.headA2, stored.id),
        ]);
        expect(barrier.arrived()).toBe(2);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        const rows = await eventsOf();
        expect(rows).toHaveLength(1);
        expect((await rowOf(stored.id)).eventID).toBe(rows[0]!.eventID);
        expect(rows[0]!.eventID).not.toBe(987_654_321);
      });
    });

    describe("a missing eventID key and a stored null", () => {
      const keyPresent = async (id: string) => {
        const res = (await db.$runCommandRaw({
          find: "Proposal",
          filter: { _id: { $oid: id } },
        })) as { cursor: { firstBatch: Array<Record<string, unknown>> } };
        return "eventID" in res.cursor.firstBatch[0]!;
      };

      it("handles a stored null", async () => {
        const stored = await stage({ willBeEvent: false });
        expect(await keyPresent(stored.id)).toBe(true);
        expect((await rowOf(stored.id)).eventID).toBeNull();
        const made = await as(U.headA).createEvent({ id: stored.id });
        expect(made.created).toBe(true);
        expect(await eventsOf()).toHaveLength(1);
      });

      it("handles a row with no eventID key at all", async () => {
        const stored = await stage({ willBeEvent: false });
        await db.$runCommandRaw({
          update: "Proposal",
          updates: [
            { q: { _id: { $oid: stored.id } }, u: { $unset: { eventID: "" } } },
          ],
        });
        expect(await keyPresent(stored.id)).toBe(false);
        const made = await as(U.headA).createEvent({ id: stored.id });
        expect(made.created).toBe(true);
        expect(await keyPresent(stored.id)).toBe(true);
        expect(await eventsOf()).toHaveLength(1);
        const again = await as(U.headA).createEvent({ id: stored.id });
        expect(again.created).toBe(false);
        expect(await eventsOf()).toHaveLength(1);
      });

      it("the automatic step also creates for a row with no key", async () => {
        await setFlag("events.enabled", null);
        const stored = await stage({ willBeEvent: true });
        await db.$runCommandRaw({
          update: "Proposal",
          updates: [
            { q: { _id: { $oid: stored.id } }, u: { $unset: { eventID: "" } } },
          ],
        });
        await setFlag("events.enabled", "on");
        await link.draftEventAfterApproval(db, stored.id);
        expect(await eventsOf()).toHaveLength(1);
      });
    });

    describe("a failed Event create leaves a dangling id that the button recovers", () => {
      it("the button's own failure dangles, the proposal says so, and a second press makes the draft", async () => {
        const stored = await stage({ willBeEvent: false });
        const quiet = captureErrors();
        const failed = await errorOf(
          as(U.headA, EVERYTHING, withFailingEventCreate()).createEvent({
            id: stored.id,
          }),
        );
        quiet.restore();
        expect(failed).not.toBe("ok");
        expect(await eventsOf()).toHaveLength(0);
        const dangling = (await rowOf(stored.id)).eventID;
        expect(dangling).not.toBeNull();

        // Within the window it reads as being made, and the button writes nothing.
        const fresh = await as(U.headA).get({ id: stored.id });
        expect(fresh.eventBeingMade).toBe(true);
        expect(fresh.eventMissing).toBe(false);
        expect(fresh.canCreateEvent).toBe(false);
        expect(await errorOf(as(U.headA).createEvent({ id: stored.id }))).toBe(
          "CONFLICT:EVENT_BEING_MADE",
        );
        expect((await rowOf(stored.id)).eventID).toBe(dangling);
        await ageClaim(stored.id);

        const seen = await as(U.headA).get({ id: stored.id });
        expect(seen.event).toBeNull();
        expect(seen.eventMissing).toBe(true);
        expect(seen.eventBeingMade).toBe(false);
        expect(seen.canCreateEvent).toBe(true);

        const fixed = await as(U.headA).createEvent({ id: stored.id });
        expect(fixed.created).toBe(true);
        expect(fixed.eventID).not.toBe(dangling);
        expect(await eventsOf()).toHaveLength(1);
        const after = await as(U.headA).get({ id: stored.id });
        expect(after.eventMissing).toBe(false);
        expect(after.event?.eventID).toBe(fixed.eventID);
        expect(after.canCreateEvent).toBe(false);
      });

      it("a failure in the automatic step leaves the approval committed and logs only the error name", async () => {
        const quiet = captureErrors();
        const stored = await stage({
          approveWith: withFailingEventCreate(),
        });
        const log = quiet.text();
        quiet.restore();
        const row = await rowOf(stored.id);
        expect(row.status).toBe("cleared");
        expect(row.eventID).not.toBeNull();
        expect(await eventsOf()).toHaveLength(0);
        const history = await db.proposalStatusHistory.findMany({
          where: { proposalID: stored.id, toStatus: "cleared" },
        });
        expect(history).toHaveLength(1);
        expect(log).toContain("proposal_event_draft_failed");
        expect(log).not.toContain("boom");
        expect(await draftNotices()).toHaveLength(0);

        // The button recovers it once the claim is past the window.
        await ageClaim(stored.id);
        const fixed = await as(U.headA).createEvent({ id: stored.id });
        expect(fixed.created).toBe(true);
        expect(await eventsOf()).toHaveLength(1);
      });

      it("a failed id allocation also leaves the approval alone", async () => {
        const quiet = captureErrors();
        const failingCounter = proxied(db, (prop) =>
          prop === "counter"
            ? delegateWith("counter", {
                update: () => Promise.reject(new Error("boom")),
              })
            : undefined,
        );
        const stored = await stage({ approveWith: failingCounter });
        quiet.restore();
        const row = await rowOf(stored.id);
        expect(row.status).toBe("cleared");
        expect(row.eventID).toBeNull();
        expect(await eventsOf()).toHaveLength(0);
        const fixed = await as(U.headA).createEvent({ id: stored.id });
        expect(fixed.created).toBe(true);
      });

      it("a failed draft notice does not undo the draft", async () => {
        const quiet = captureErrors();
        const failingNotices = proxied(db, (prop) =>
          prop === "notification" ? delegateWithNotification() : undefined,
        );
        function delegateWithNotification() {
          return {
            createMany: () => Promise.reject(new Error("boom")),
          };
        }
        const stored = await stage({ approveWith: failingNotices });
        quiet.restore();
        expect(await eventsOf()).toHaveLength(1);
        expect((await rowOf(stored.id)).status).toBe("cleared");
      });
    });

    describe("a claim between the claim and the create (A33)", () => {
      /** A database whose Event create waits for `release`, and says when reached. */
      const slowCreate = () => {
        let release!: () => void;
        let reached!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const arrived = new Promise<void>((r) => (reached = r));
        const client = proxied(db, (prop) =>
          prop === "event"
            ? delegateWith("event", {
                create: async (args: never) => {
                  reached();
                  await gate;
                  return db.event.create(args);
                },
              })
            : undefined,
        );
        return { client, release, arrived };
      };

      it("a second press during the first create writes nothing and leaves one linked Event", async () => {
        const stored = await stage({ willBeEvent: false });
        const slow = slowCreate();
        const first = link.createEventFromProposal(
          slow.client,
          U.headA,
          stored.id,
        );
        await slow.arrived; // claimed, not yet created
        const claimed = (await rowOf(stored.id)).eventID;
        expect(claimed).not.toBeNull();
        const during = await errorOf(
          as(U.headA2).createEvent({ id: stored.id }),
        );
        expect(during).toBe("CONFLICT:EVENT_BEING_MADE");
        expect((await rowOf(stored.id)).eventID).toBe(claimed);
        slow.release();
        const made = await first;
        expect(made.created).toBe(true);
        const rows = await eventsOf();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.eventID).toBe(claimed);
        expect((await rowOf(stored.id)).eventID).toBe(claimed);
      });

      it("the automatic step during a button's create also writes nothing", async () => {
        await setFlag("events.enabled", null);
        const stored = await stage({ willBeEvent: true });
        await setFlag("events.enabled", "on");
        const slow = slowCreate();
        const first = link.createEventFromProposal(
          slow.client,
          U.headA,
          stored.id,
        );
        await slow.arrived;
        expect(await link.draftEventAfterApproval(db, stored.id)).toBe(
          "in_progress",
        );
        slow.release();
        await first;
        expect(await eventsOf()).toHaveLength(1);
      });

      it("a claim past the window is recovered, and a legacy row with no claim time counts as old", async () => {
        const stored = await stage({ willBeEvent: false });
        await db.proposal.update({
          where: { id: stored.id },
          data: { eventID: 123_456_789, eventClaimedAt: new Date() },
        });
        expect(await errorOf(as(U.headA).createEvent({ id: stored.id }))).toBe(
          "CONFLICT:EVENT_BEING_MADE",
        );
        await ageClaim(stored.id);
        const fixed = await as(U.headA).createEvent({ id: stored.id });
        expect(fixed.created).toBe(true);
        expect(fixed.eventID).not.toBe(123_456_789);
        expect(await eventsOf()).toHaveLength(1);

        // Legacy: a dangling id and no claim time at all.
        const legacy = await stage({ willBeEvent: false });
        await db.$runCommandRaw({
          update: "Proposal",
          updates: [
            {
              q: { _id: { $oid: legacy.id } },
              u: {
                $set: { eventID: 123_456_788 },
                $unset: { eventClaimedAt: "" },
              },
            },
          ],
        });
        const seen = await as(U.headA).get({ id: legacy.id });
        expect(seen.eventMissing).toBe(true);
        expect(seen.eventBeingMade).toBe(false);
        const again = await as(U.headA).createEvent({ id: legacy.id });
        expect(again.created).toBe(true);
        expect(await eventsOf()).toHaveLength(2);
      });
    });

    describe("what the approval reports, and the finished state", () => {
      it("reports created, and not_requested when the field is off", async () => {
        const made = await as(U.dirA).approve(await submitted(true));
        expect(made.eventDraft).toBe("created");
        const off = await as(U.dirA).approve(await submitted(false));
        expect(off.eventDraft).toBe("not_requested");
      });

      it("reports events_off without a draft", async () => {
        await setFlag("events.enabled", null);
        const r = await as(U.dirA).approve(await submitted(true));
        expect(r.eventDraft).toBe("events_off");
      });

      it("reports failed, logs the error name, and tells the heads to press Create event", async () => {
        const quiet = captureErrors();
        const r = await as(
          U.dirA,
          EVERYTHING,
          withFailingEventCreate(),
        ).approve(await submitted(true));
        const log = quiet.text();
        quiet.restore();
        expect(r.status).toBe("cleared");
        expect(r.eventDraft).toBe("failed");
        expect(log).not.toContain("boom");
        const notices = await db.notification.findMany({
          where: { kind: "proposal.event_draft_failed", userID: { in: IDS } },
        });
        expect(notices.map((n) => n.userID).sort()).toEqual(
          [U.headA, U.headA2, U.dirHead].sort(),
        );
        const view = await as(U.dirA).get({ id: r.id });
        expect(view.eventBeingMade).toBe(true);
      });

      it("reports no_owner and still notices the heads", async () => {
        const sub = await submitted(true);
        await db.proposal.update({
          where: { id: sub.id },
          data: { createdBy: null },
        });
        const quiet = captureErrors();
        const r = await as(U.dirA).approve(sub);
        quiet.restore();
        expect(r.eventDraft).toBe("no_owner");
        expect(
          await db.notification.count({
            where: { kind: "proposal.event_draft_failed", userID: U.headA },
          }),
        ).toBe(1);
      });

      it("a failed notice about a failed draft does not undo the approval", async () => {
        const quiet = captureErrors();
        const broken = proxied(db, (prop) =>
          prop === "event"
            ? delegateWith("event", {
                create: () => Promise.reject(new Error("boom")),
              })
            : prop === "notification"
              ? { createMany: () => Promise.reject(new Error("boom")) }
              : undefined,
        );
        const r = await as(U.dirA, EVERYTHING, broken).approve(
          await submitted(true),
        );
        quiet.restore();
        expect(r.status).toBe("cleared");
        expect(r.eventDraft).toBe("failed");
      });

      it("logs a skip, with the proposal id, when the status has moved", async () => {
        const stored = await stage({ willBeEvent: true });
        await as(U.dirA).finish({ id: stored.id, version: stored.version });
        const quiet = captureErrors();
        const outcome = await link.draftEventAfterApproval(db, stored.id);
        const log = quiet.text();
        quiet.restore();
        expect(outcome).toBe("skipped");
        expect(log).toContain("proposal_event_draft_skipped");
        expect(log).toContain(stored.id);
      });

      it("the button works on a finished proposal; the automatic step does not", async () => {
        await setFlag("events.enabled", null);
        const stored = await stage({ willBeEvent: true });
        const done = await as(U.dirA).finish({
          id: stored.id,
          version: stored.version,
        });
        expect(done.status).toBe("finished");
        await setFlag("events.enabled", "on");
        expect(await link.draftEventAfterApproval(db, stored.id)).toBe(
          "skipped",
        );
        expect(await eventsOf()).toHaveLength(0);
        const seen = await as(U.headA).get({ id: stored.id });
        expect(seen.canCreateEvent).toBe(true);
        const made = await as(U.headA).createEvent({ id: stored.id });
        expect(made.created).toBe(true);
        expect(await eventsOf()).toHaveLength(1);
      });
    });

    describe("deleteDraft leaves a readable proposal and a working button (A34)", () => {
      it("says the draft is gone and makes a new one", async () => {
        const stored = await stage();
        const first = (await rowOf(stored.id)).eventID!;
        const mine = await as(U.headA).get({ id: stored.id });
        expect(mine.event?.eventID).toBe(first);
        expect(mine.eventMissing).toBe(false);

        await callerFor(U.headA, ["resident", "cca_head"]).event.deleteDraft({
          eventID: first,
        });
        expect(await eventsOf()).toHaveLength(0);
        // The claim is still young, so the proposal says it is being made.
        const young = await as(U.headA).get({ id: stored.id });
        expect(young.eventBeingMade).toBe(true);
        expect(await errorOf(as(U.headA).createEvent({ id: stored.id }))).toBe(
          "CONFLICT:EVENT_BEING_MADE",
        );
        expect(await eventsOf()).toHaveLength(0);
        await ageClaim(stored.id);

        const after = await as(U.headA).get({ id: stored.id });
        expect(after.status).toBe("cleared");
        expect(after.event).toBeNull();
        expect(after.eventMissing).toBe(true);
        expect(after.canCreateEvent).toBe(true);
        // Still readable by the director, who is told the draft is gone.
        const director = await as(U.dirA).get({ id: stored.id });
        expect(director.eventMissing).toBe(true);
        expect(director.canCreateEvent).toBe(false);

        const again = await as(U.headA).createEvent({ id: stored.id });
        expect(again.created).toBe(true);
        expect(again.eventID).not.toBe(first);
        expect(await eventsOf()).toHaveLength(1);
      });
    });

    describe("while events.enabled is off", () => {
      it("approval succeeds, with no draft and no draft notice", async () => {
        await setFlag("events.enabled", null);
        const stored = await stage();
        const row = await rowOf(stored.id);
        expect(row.status).toBe("cleared");
        expect(row.eventID).toBeNull();
        expect(await eventsOf()).toHaveLength(0);
        expect(await draftNotices()).toHaveLength(0);
        // The ordinary approval notice still went out.
        expect(
          await db.notification.count({
            where: { kind: "proposal.approved", userID: U.headA },
          }),
        ).toBe(1);
      });

      it("the button is refused, and the proposal offers no button", async () => {
        await setFlag("events.enabled", null);
        const stored = await stage({ willBeEvent: false });
        expect(await errorOf(as(U.headA).createEvent({ id: stored.id }))).toBe(
          "FORBIDDEN:EVENTS_DISABLED",
        );
        const seen = await as(U.headA).get({ id: stored.id });
        expect(seen.eventsEnabled).toBe(false);
        expect(seen.canCreateEvent).toBe(false);
        expect(await eventsOf()).toHaveLength(0);
      });
    });

    describe("who may press Create event", () => {
      it("refuses a head of another CCA, a non-head and a director who is not a head, and creates nothing", async () => {
        const stored = await stage({ willBeEvent: false });
        for (const who of [U.headB, U.admin, U.resident, U.dirA]) {
          expect(
            await errorOf(as(who).createEvent({ id: stored.id })),
            who,
          ).toBe(NOT_FOUND);
        }
        expect(await eventsOf()).toHaveLength(0);
        expect((await rowOf(stored.id)).eventID).toBeNull();
      });

      it("allows a director who also heads the CCA, and the draft is theirs", async () => {
        const stored = await stage({ willBeEvent: false });
        const made = await as(U.dirHead).createEvent({ id: stored.id });
        expect(made.created).toBe(true);
        const [event] = await eventsOf();
        // Owned by whoever pressed, not by the proposal's creator.
        expect(event!.createdBy).toBe(U.dirHead);
      });

      it("makes the head who pressed the button the owner, not the creator (#130)", async () => {
        const stored = await stage({ willBeEvent: false });
        await as(U.headA2).createEvent({ id: stored.id });
        const [event] = await eventsOf();
        expect(event!.createdBy).toBe(U.headA2);
        expect(event!.createdBy).not.toBe(U.headA);
      });

      it("refuses an unknown id the same way as another CCA's", async () => {
        expect(
          await errorOf(as(U.headA).createEvent({ id: "0".repeat(24) })),
        ).toBe(NOT_FOUND);
      });

      it("refuses a proposal that is not approved", async () => {
        const stored = await stage({ to: "in_review", willBeEvent: false });
        expect(await errorOf(as(U.headA).createEvent({ id: stored.id }))).toBe(
          "PRECONDITION_FAILED:PROPOSAL_NOT_APPROVED",
        );
        expect(await eventsOf()).toHaveLength(0);
      });

      it("refuses when a flag cannot be read (fail closed)", async () => {
        const stored = await stage({ willBeEvent: false });
        events.resetEventsFlagCache();
        expect(
          await errorOf(
            as(
              U.headA,
              EVERYTHING,
              withFailingFlag("events.enabled"),
            ).createEvent({
              id: stored.id,
            }),
          ),
        ).toBe("FORBIDDEN:EVENTS_DISABLED");
        events.resetEventsFlagCache();
        expect(
          await errorOf(
            as(
              U.headA,
              EVERYTHING,
              withFailingFlag("proposals.enabled"),
            ).createEvent({
              id: stored.id,
            }),
          ),
        ).toBe("FORBIDDEN:PROPOSALS_DISABLED");
        expect(await eventsOf()).toHaveLength(0);
        expect((await rowOf(stored.id)).eventID).toBeNull();
      });

      it("refuses when the head check cannot be read", async () => {
        const stored = await stage({ willBeEvent: false });
        const down = proxied(db, (prop) =>
          prop === "ccaHead"
            ? { findFirst: () => Promise.reject(new Error("db down")) }
            : undefined,
        );
        const quiet = captureErrors();
        expect(
          await errorOf(
            as(U.headA, EVERYTHING, down).createEvent({ id: stored.id }),
          ),
        ).toBe("FORBIDDEN:PROPOSAL_ACCESS_CHECK_FAILED");
        quiet.restore();
        expect(await eventsOf()).toHaveLength(0);
      });

      it("refuses while proposals.enabled is off", async () => {
        const stored = await stage({ willBeEvent: false });
        await setFlag("proposals.enabled", null);
        expect(await errorOf(as(U.headA).createEvent({ id: stored.id }))).toBe(
          "FORBIDDEN:PROPOSALS_DISABLED",
        );
      });
    });

    describe("an account that was deleted (B16)", () => {
      it("makes no draft automatically, and the button makes the pressing head the owner", async () => {
        await setFlag("events.enabled", null);
        const stored = await stage({ willBeEvent: true });
        await db.proposal.update({
          where: { id: stored.id },
          data: { createdBy: null },
        });
        await setFlag("events.enabled", "on");
        const quiet = captureErrors();
        await link.draftEventAfterApproval(db, stored.id);
        quiet.restore();
        expect(await eventsOf()).toHaveLength(0);
        expect((await rowOf(stored.id)).eventID).toBeNull();

        const seen = await as(U.headA).get({ id: stored.id });
        expect(seen.canCreateEvent).toBe(true);
        await as(U.headA).createEvent({ id: stored.id });
        const [event] = await eventsOf();
        expect(event!.createdBy).toBe(U.headA);
      });
    });

    describe("an author who no longer heads the CCA (#130)", () => {
      it("makes no draft automatically and tells the heads; the button makes the pressing head the owner", async () => {
        const sub = await submitted(true);
        await db.ccaHead.deleteMany({
          where: { ccaID: CCA_A, userID: U.headA },
        });
        const quiet = captureErrors();
        const r = await as(U.dirA).approve(sub);
        quiet.restore();
        expect(r.eventDraft).toBe("no_owner");
        expect(await eventsOf()).toHaveLength(0);
        expect((await rowOf(sub.id)).eventID).toBeNull();
        expect(
          await db.notification.count({
            where: { kind: "proposal.event_draft_failed", userID: U.headA2 },
          }),
        ).toBe(1);

        await as(U.headA2).createEvent({ id: sub.id });
        const [event] = await eventsOf();
        expect(event!.createdBy).toBe(U.headA2);
      });
    });

    describe("what a reader of a proposal sees of the Event", () => {
      it("is the id, status and title and nothing else, and not the raw pointer", async () => {
        const stored = await stage();
        for (const who of [U.headA, U.dirA]) {
          const seen = await as(who).get({ id: stored.id });
          expect(Object.keys(seen.event ?? {}).sort()).toEqual([
            "eventID",
            "status",
            "title",
          ]);
          expect(seen.event?.status).toBe("draft");
          expect(seen.event?.title).toBe("Pub night");
          expect("eventID" in seen).toBe(false);
        }
        const head = await as(U.headA).get({ id: stored.id });
        const director = await as(U.dirA).get({ id: stored.id });
        expect(head.viewer).toBe("head");
        expect(director.viewer).toBe("director");
        expect(director.canCreateEvent).toBe(false);
      });
    });

    describe("the field itself", () => {
      it("defaults by category, and the head can change it until the proposal is submitted", async () => {
        const eventKind = await as(U.headA).create({
          ccaID: CCA_A,
          category: "event",
          title: "Concert",
        });
        const pubs = await as(U.headA).create({
          ccaID: CCA_A,
          category: "pubs",
          title: "Pub",
        });
        expect((await as(U.headA).get({ id: eventKind.id })).willBeEvent).toBe(
          true,
        );
        expect((await as(U.headA).get({ id: pubs.id })).willBeEvent).toBe(
          false,
        );

        const saved = await as(U.headA).update({
          id: pubs.id,
          version: pubs.version,
          willBeEvent: true,
        });
        expect((await as(U.headA).get({ id: pubs.id })).willBeEvent).toBe(true);
        expect(saved.version).toBe(pubs.version + 1);

        // A stale version cannot flip it.
        expect(
          await errorOf(
            as(U.headA).update({
              id: pubs.id,
              version: pubs.version,
              willBeEvent: false,
            }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
      });

      it("is locked once the proposal is in review", async () => {
        const stored = await stage({ to: "in_review" });
        expect(
          await errorOf(
            as(U.headA).update({
              id: stored.id,
              version: stored.version,
              willBeEvent: false,
            }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
      });

      it("reads as off for a row from before the field existed", async () => {
        const stored = await stage({ to: "in_review", willBeEvent: true });
        await db.$runCommandRaw({
          update: "Proposal",
          updates: [
            {
              q: { _id: { $oid: stored.id } },
              u: { $unset: { willBeEvent: "" } },
            },
          ],
        });
        expect((await as(U.headA).get({ id: stored.id })).willBeEvent).toBe(
          false,
        );
      });
    });

    describe("events never need a proposal (A32)", () => {
      it("a head creates an Event with proposals off and no proposal rows", async () => {
        await setFlag("proposals.enabled", null);
        expect(
          await db.proposal.count({ where: { ccaID: { in: CCAS } } }),
        ).toBe(0);
        const made = await callerFor(U.headA, [
          "resident",
          "cca_head",
        ]).event.create({
          ccaID: CCA_A,
          title: "No proposal here",
          description: "d",
        });
        const row = await db.event.findUniqueOrThrow({
          where: { eventID: made.eventID },
        });
        expect(row.status).toBe("draft");
        expect(row.title).toBe("No proposal here");
        // Written with every explicit null the shared helper keeps.
        expect(row.publicDescription).toBeNull();
        expect(row.bannerUrl).toBeNull();
      });
    });
  },
);
