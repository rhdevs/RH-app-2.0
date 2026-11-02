import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type { seenToken as SeenToken } from "../milestones/view";
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
 * INTEGRATION TESTS of milestone filing and rating (PR 16, merge proposal
 * 4.10, A53, A55, Q15) against the LOCAL development database (skipped unless
 * DATABASE_URL is the local dev database). Run this file on its own. It needs
 * create-milestone-indexes.mjs --commit to have run (the unique filing key and
 * the unique rating per filing).
 *
 * The private store is an in-memory fake (no Blob call, no credential). The
 * tests own users E99916xx, CCAs 9803 and 9804 (heads only; CCA rows are never
 * written except the two names the home entries read), events 9100001 and up,
 * proposals titled "TEST ...", positions named "TEST ...", and their
 * counters. The flag rows are put back as they were.
 */

const fake = vi.hoisted(() => {
  const files = new Map<string, { size: number; contentType: string }>();
  const state = { removeFails: false, removed: [] as string[] };
  const storage = {
    host: () => "teststore.private.blob.vercel-storage.com",
    head: (p: string) => Promise.resolve(files.get(p) ?? null),
    listBlobs: () => Promise.resolve([]),
    read: (p: string) => {
      const meta = files.get(p);
      return Promise.resolve(
        meta ? { ...meta, stream: new ReadableStream<Uint8Array>() } : null,
      );
    },
    remove: (p: string) => {
      state.removed.push(p);
      if (state.removeFails) return Promise.resolve(false);
      files.delete(p);
      return Promise.resolve(true);
    },
  };
  return { files, state, storage };
});

vi.mock("~/server/api/services/milestoneBlob", () => ({
  MILESTONE_STORAGE_NOT_CONFIGURED: "MILESTONE_STORAGE_NOT_CONFIGURED",
  evidenceStorage: fake.storage,
}));

const U = {
  headA: "E9991601",
  headA2: "E9991602",
  headB: "E9991603",
  dirA: "E9991604",
  dirB: "E9991605",
  other: "E9991606", // a position that does not vet proposals
  jcrc: "E9991607",
  admin: "E9991608",
  resident: "E9991609",
  both: "E9991610", // heads and directs 9803
  dirA2: "E9991611", // a second director of 9803
};
const IDS = Object.values(U);
const A = 9803;
const B = 9804;
const FLAGS = [
  "milestones.enabled",
  "directors.enabled",
  "notifications.enabled",
];
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const NOT_FOUND = "NOT_FOUND:MILESTONE_NOT_FOUND";
const NOT_OPEN = "PRECONDITION_FAILED:MILESTONE_NOT_OPEN";
const FROZEN = "CONFLICT:MILESTONE_FROZEN";
const CONFLICT = "CONFLICT:MILESTONE_CONFLICT";
const CHECK_FAILED = "FORBIDDEN:MILESTONE_ACCESS_CHECK_FAILED";
const DISABLED = "FORBIDDEN:MILESTONES_DISABLED";
const EV0 = 9_100_000;
const HOUR = 3600;
const DAY_MS = 86_400_000;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "milestones (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let runDueCheck: typeof RunDueCheck;
    let resetCache: () => void;
    let seenToken: typeof SeenToken;
    const original: Record<string, string | null> = {};
    let ip = 0;
    let seq = 0;
    let evSeq = 0;

    const nowSec = () => Math.floor(Date.now() / 1000);
    const base = (userID: string, roles = EVERYTHING, client = db) =>
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
        headers: new Headers({ "x-forwarded-for": `203.0.113.${(ip += 1)}` }),
      });
    const as = (u: string, client = db) =>
      base(u, EVERYTHING, client).milestone;
    const inbox = (u: string) => base(u).notifications;

    const setFlag = async (key: string, value: string | null) => {
      if (value === null) await db.systemFlag.deleteMany({ where: { key } });
      else {
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
        where: {
          key: {
            in: ["file", "attach", "detach", "rate", "browse"].flatMap((a) =>
              IDS.map((i) => `milestone.${a}:${i}`),
            ),
          },
        },
      });
      await db.rateLimit.deleteMany({
        where: { key: { in: IDS.map((i) => `notifications.dueCheck:${i}`) } },
      });
      await db.notification.deleteMany({ where: { userID: { in: IDS } } });
      await db.milestoneAssessment.deleteMany({
        where: { ccaID: { in: [A, B] } },
      });
      await db.milestoneEvidence.deleteMany({
        where: { ccaID: { in: [A, B] } },
      });
      await db.milestoneSubmission.deleteMany({
        where: { ccaID: { in: [A, B] } },
      });
      await db.event.deleteMany({ where: { eventID: { gte: EV0 } } });
      await db.proposal.deleteMany({
        where: { title: { startsWith: "TEST " } },
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
      await db.user.deleteMany({ where: { email: { startsWith: "e99916" } } });
      await db.cCA.deleteMany({ where: { ccaID: { in: [A, B] } } });
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
      });

    const makePosition = async (
      name: string,
      holder: string,
      opts: { vets: boolean; ccaIDs: number[] },
    ) => {
      const p = await db.jcrcPosition.create({
        data: {
          name: `TEST ${name}`,
          createdBy: "test",
          vetsProposals: opts.vets,
          handlesDisposables: false,
        },
      });
      for (const ccaID of opts.ccaIDs) {
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
    const withFailingRead = (table: string): PrismaClient => {
      const boom = () => Promise.reject(new Error("db down"));
      return proxied(db, (prop) =>
        prop === table
          ? { findFirst: boom, findMany: boom, findUnique: boom, count: boom }
          : undefined,
      );
    };

    /** An event that ended `hoursAgo` hours ago (published, CCA A, by default). */
    const makeEvent = async (
      over: {
        status?: string;
        ccaID?: number | null;
        startTime?: number | null;
        endTime?: number | null;
        hoursAgo?: number;
      } = {},
    ) => {
      evSeq += 1;
      const end = nowSec() - (over.hoursAgo ?? 5) * HOUR;
      const eventID = EV0 + evSeq;
      await db.event.create({
        data: {
          eventID,
          createdBy: U.headA,
          title: `TEST event ${evSeq}`,
          status: over.status ?? "published",
          ccaID: over.ccaID === undefined ? A : over.ccaID,
          startTime: over.startTime === undefined ? end - HOUR : over.startTime,
          endTime: over.endTime === undefined ? end : over.endTime,
        },
      });
      return { kind: "event" as const, eventID };
    };

    const makeProposal = async (status = "finished", hoursAgo = 5) => {
      const end = nowSec() - hoursAgo * HOUR;
      const p = await db.proposal.create({
        data: {
          ccaID: A,
          createdBy: U.headA,
          category: "other",
          title: "TEST proposal",
          description: "d",
          status,
          plannedStart: end - HOUR,
          plannedEnd: end,
          eventID: null,
        },
      });
      return { kind: "proposal" as const, proposalID: p.id };
    };

    const seedPhoto = async (
      ccaID = A,
      over: { createdAt?: Date; submissionID?: string | null } = {},
    ) => {
      seq += 1;
      const pathname = `milestone-evidence/${ccaID}/evidence-f${seq}.webp`;
      fake.files.set(pathname, { size: 1000, contentType: "image/webp" });
      return db.milestoneEvidence.create({
        data: {
          ccaID,
          pathname,
          contentType: "image/webp",
          size: 1000,
          uploadedBy: U.headA,
          submissionID: over.submissionID ?? null,
          createdAt: over.createdAt ?? new Date(),
        },
      });
    };

    /** A director rates the filing exactly as they loaded it (B151). */
    const rate = async (
      userID: string,
      input: {
        ref: Parameters<ReturnType<typeof as>["rate"]>[0]["ref"];
        score: number;
        text: string;
      },
      client = db,
    ) => {
      const sub = await db.milestoneSubmission.findUnique({
        where: {
          milestoneKey:
            input.ref.kind === "event"
              ? `event:${input.ref.eventID}`
              : `proposal:${input.ref.proposalID.toLowerCase()}`,
        },
        select: { id: true, version: true },
      });
      const seen = sub ? seenToken(sub.id, sub.version) : "0".repeat(16);
      return as(userID, client).rate({ ...input, seen });
    };

    type Ref = Awaited<ReturnType<typeof makeEvent>>;
    /** Head A files a rating and one photo. Returns the filing version. */
    const file = async (
      ref: Ref | Awaited<ReturnType<typeof makeProposal>>,
    ) => {
      const saved = await as(U.headA).saveRating({
        ref,
        expectedVersion: null,
        score: 4,
        text: "Went well",
      });
      const photo = await seedPhoto();
      const attached = await as(U.headA).attach({
        ref,
        expectedVersion: saved.version,
        evidenceIDs: [photo.id],
      });
      return { version: attached.version, photo };
    };

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      ({ runDueCheck } = await import("~/server/api/services/dueCheck/runner"));
      ({ seenToken } = await import("../milestones/view"));
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
      fake.files.clear();
      fake.state.removeFails = false;
      fake.state.removed.length = 0;
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.headA, U.headA2, U.headB]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.both, ["resident", "cca_head", "jcrc"]);
      for (const id of [U.dirA, U.dirA2, U.dirB, U.other, U.jcrc]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.resident, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, A],
        [U.headA2, A],
        [U.headB, B],
        [U.both, A],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await db.cCA.createMany({
        data: [A, B].map((ccaID) => ({
          ccaID,
          ccaName: `Test CCA ${ccaID}`,
          category: "Test",
        })),
      });
      await makePosition("Dir A", U.dirA, { vets: true, ccaIDs: [A] });
      await makePosition("Dir A2", U.dirA2, { vets: true, ccaIDs: [A] });
      await makePosition("Dir B", U.dirB, { vets: true, ccaIDs: [B] });
      await makePosition("Dir Both", U.both, { vets: true, ccaIDs: [A] });
      await makePosition("Other A", U.other, { vets: false, ccaIDs: [A] });
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("when a milestone opens (A53)", () => {
      it.each([
        "draft",
        "submitted",
        "changes_requested",
        "declined",
        "canceled",
      ])(
        "a %s event never takes a filing, whatever its dates",
        async (status) => {
          const ref = await makeEvent({ status });
          expect(
            await errorOf(
              as(U.headA).saveRating({
                ref,
                expectedVersion: null,
                score: 3,
                text: "x",
              }),
            ),
          ).toBe(NOT_OPEN);
          expect(
            await errorOf(rate(U.dirA, { ref, score: 3, text: "x" })),
          ).toBe(NOT_OPEN);
        },
      );

      it("a published CCA event whose end passed takes a filing", async () => {
        const ref = await makeEvent();
        const res = await as(U.headA).saveRating({
          ref,
          expectedVersion: null,
          score: 5,
          text: "Great",
        });
        expect(res.version).toBe(1);
      });

      it("a hall-wide event can never take one, and answers as a missing row", async () => {
        const ref = await makeEvent({ ccaID: null });
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe(NOT_FOUND);
      });

      it("with no endTime the start time is the end", async () => {
        const ref = await makeEvent({
          endTime: null,
          startTime: nowSec() - 2 * HOUR,
        });
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe("ok");
      });

      it("an event with neither time never opens one", async () => {
        const ref = await makeEvent({ startTime: null, endTime: null });
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe(NOT_OPEN);
      });

      it("a future end is not open yet", async () => {
        const ref = await makeEvent({ hoursAgo: -3 });
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe(NOT_OPEN);
      });

      it("a finished proposal with no event takes one; an unfinished one does not", async () => {
        const done = await makeProposal("finished");
        const open = await makeProposal("cleared");
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref: done,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe("ok");
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref: open,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe(NOT_OPEN);
      });

      it("one filing per event, however it is reached", async () => {
        const ref = await makeEvent();
        await as(U.headA).saveRating({
          ref,
          expectedVersion: null,
          score: 3,
          text: "x",
        });
        expect(
          await errorOf(
            as(U.headA2).saveRating({
              ref,
              expectedVersion: null,
              score: 2,
              text: "y",
            }),
          ),
        ).toBe(CONFLICT);
        expect(
          await db.milestoneSubmission.count({ where: { ccaID: A } }),
        ).toBe(1);
      });
    });

    describe("who may file, rate and read", () => {
      it("only a current head files; everyone else is refused as not found", async () => {
        const ref = await makeEvent();
        for (const u of [
          U.dirA,
          U.other,
          U.jcrc,
          U.admin,
          U.resident,
          U.headB,
          U.dirB,
        ]) {
          expect(
            await errorOf(
              as(u).saveRating({
                ref,
                expectedVersion: null,
                score: 3,
                text: "x",
              }),
            ),
            u,
          ).toBe(NOT_FOUND);
        }
      });

      it("only a current director rates; heads, admins, JCRC, other positions and other CCAs' directors are refused", async () => {
        const ref = await makeEvent();
        await file(ref);
        for (const u of [
          U.headA,
          U.headA2,
          U.admin,
          U.jcrc,
          U.other,
          U.dirB,
          U.headB,
          U.resident,
        ]) {
          expect(await errorOf(rate(u, { ref, score: 3, text: "x" })), u).toBe(
            NOT_FOUND,
          );
        }
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(0);
      });

      it("only that CCA's heads and directors read a milestone or its year", async () => {
        const ref = await makeEvent();
        for (const u of [U.headA, U.dirA, U.both]) {
          expect(await errorOf(as(u).get({ ref })), u).toBe("ok");
          expect(await errorOf(as(u).year({ ccaID: A })), u).toBe("ok");
        }
        for (const u of [
          U.headB,
          U.dirB,
          U.other,
          U.jcrc,
          U.admin,
          U.resident,
        ]) {
          expect(await errorOf(as(u).get({ ref })), u).toBe(NOT_FOUND);
          expect(await errorOf(as(u).year({ ccaID: A })), u).toBe(NOT_FOUND);
        }
      });

      it("a former head loses access at once, and so does a former director", async () => {
        const ref = await makeEvent();
        await file(ref);
        await db.ccaHead.deleteMany({ where: { userID: U.headA } });
        expect(await errorOf(as(U.headA).get({ ref }))).toBe(NOT_FOUND);
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: 2,
              score: 1,
              text: "x",
            }),
          ),
        ).toBe(NOT_FOUND);
        await db.jcrcPositionHolder.deleteMany({ where: { userID: U.dirA } });
        expect(await errorOf(rate(U.dirA, { ref, score: 3, text: "x" }))).toBe(
          NOT_FOUND,
        );
        expect(await errorOf(as(U.dirA).year({ ccaID: A }))).toBe(NOT_FOUND);
      });

      it("a failed guard read refuses and writes nothing", async () => {
        const ref = await makeEvent();
        const down = withFailingRead("ccaHead");
        expect(
          await errorOf(
            as(U.headA, down).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe(CHECK_FAILED);
        expect(await errorOf(as(U.headA, down).get({ ref }))).toBe(
          CHECK_FAILED,
        );
        expect(await errorOf(as(U.headA, down).year({ ccaID: A }))).toBe(
          CHECK_FAILED,
        );
        const dirDown = withFailingRead("jcrcPositionHolder");
        await file(ref);
        expect(
          await errorOf(rate(U.dirA, { ref, score: 3, text: "x" }, dirDown)),
        ).toBe(CHECK_FAILED);
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(0);
      });

      it("the flag off refuses everything but `enabled`", async () => {
        const ref = await makeEvent();
        await setFlag("milestones.enabled", null);
        expect((await as(U.headA).enabled()).enabled).toBe(false);
        expect(await errorOf(as(U.headA).get({ ref }))).toBe(DISABLED);
        expect(await errorOf(as(U.headA).mine())).toBe(DISABLED);
        expect(await errorOf(rate(U.dirA, { ref, score: 3, text: "x" }))).toBe(
          DISABLED,
        );
      });

      it("input is checked: score 1 to 5, bounded text", async () => {
        const ref = await makeEvent();
        for (const score of [0, 6, 2.5]) {
          expect(
            await errorOf(
              as(U.headA).saveRating({
                ref,
                expectedVersion: null,
                score,
                text: "x",
              }),
            ),
          ).toMatch(/^BAD_REQUEST/);
        }
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "a".repeat(601),
            }),
          ),
        ).toMatch(/^BAD_REQUEST/);
      });
    });

    describe("blindness (Q15, A55) in the response shape", () => {
      it("a director sees no head rating, no version and no hint, before rating", async () => {
        const ref = await makeEvent();
        await file(ref);
        const seen = await as(U.dirA).get({ ref });
        expect("head" in seen).toBe(false);
        expect("version" in seen).toBe(false);
        expect("assessment" in seen).toBe(false);
        expect(JSON.stringify(seen)).not.toContain("Went well");
        expect(seen.evidence).toHaveLength(1);
        expect(seen.canRate).toBe(true);
      });

      it("a director's view is the same whether or not the head has rated", async () => {
        const rated = await makeEvent();
        await file(rated);
        const photoOnly = await makeEvent();
        const photo = await seedPhoto();
        await as(U.headA).attach({
          ref: photoOnly,
          expectedVersion: null,
          evidenceIDs: [photo.id],
        });
        const a = await as(U.dirA).get({ ref: rated });
        const b = await as(U.dirA).get({ ref: photoOnly });
        expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
      });

      it("a head who never rated sees the director's rating once the filing is frozen (B150)", async () => {
        const ref = await makeEvent();
        const photo = await seedPhoto();
        // Another head attached a photo; head A has not rated.
        await as(U.headA2).attach({
          ref,
          expectedVersion: null,
          evidenceIDs: [photo.id],
        });
        await rate(U.dirA, { ref, score: 2, text: "Thin" });
        const seen = await as(U.headA).get({ ref });
        expect(seen.locked).toBe(true);
        expect(seen.assessment).toMatchObject({ score: 2, text: "Thin" });
        expect(seen.head ?? null).toBeNull();
        const year = await as(U.headA).year({ ccaID: A });
        expect(year.items[0]?.assessment).toMatchObject({ score: 2 });
      });

      it("before the director rates, a head learns nothing of a rating", async () => {
        const ref = await makeEvent();
        const photo = await seedPhoto();
        await as(U.headA2).attach({
          ref,
          expectedVersion: null,
          evidenceIDs: [photo.id],
        });
        const seen = await as(U.headA).get({ ref });
        expect(seen.locked).toBe(false);
        expect("assessment" in seen).toBe(false);
      });

      it("only a director is handed the token for the filing they loaded (B151)", async () => {
        const ref = await makeEvent();
        await file(ref);
        const asDirector = await as(U.dirA).get({ ref });
        expect(asDirector.seen).toMatch(/^[0-9a-f]{16}$/);
        expect(JSON.stringify(asDirector)).not.toContain("Went well");
        const asHead = await as(U.headA).get({ ref });
        expect("seen" in asHead).toBe(false);
      });

      it("once both are in, both see both", async () => {
        const ref = await makeEvent();
        await file(ref);
        await rate(U.dirA, { ref, score: 3, text: "Fair" });
        for (const u of [U.headA, U.dirA]) {
          const seen = await as(u).get({ ref });
          expect(seen.head).toMatchObject({ score: 4, text: "Went well" });
          expect(seen.assessment).toMatchObject({
            score: 3,
            text: "Fair",
            selfRated: false,
          });
        }
      });

      it("the yearly view follows the same rule", async () => {
        const ref = await makeEvent();
        await file(ref);
        const year = await as(U.dirA).year({ ccaID: A });
        expect(JSON.stringify(year)).not.toContain("Went well");
        expect(year.items[0]).not.toHaveProperty("head");
      });
    });

    describe("freezing and concurrency", () => {
      it("after the director submits, the head's filing is frozen", async () => {
        const ref = await makeEvent();
        const { version, photo } = await file(ref);
        await rate(U.dirA, { ref, score: 3, text: "Fair" });
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: version + 1,
              score: 5,
              text: "z",
            }),
          ),
        ).toMatch(/^CONFLICT:MILESTONE_(FROZEN|CONFLICT)$/);
        const latest = (await as(U.headA).get({ ref })).version!;
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: latest,
              score: 5,
              text: "z",
            }),
          ),
        ).toBe(FROZEN);
        const more = await seedPhoto();
        expect(
          await errorOf(
            as(U.headA).attach({
              ref,
              expectedVersion: latest,
              evidenceIDs: [more.id],
            }),
          ),
        ).toBe(FROZEN);
        expect(
          await errorOf(
            as(U.headA).detach({
              ref,
              expectedVersion: latest,
              evidenceID: photo.id,
            }),
          ),
        ).toBe(FROZEN);
        expect(
          await db.milestoneEvidence.count({
            where: { submissionID: { not: null } },
          }),
        ).toBe(1);
        expect(
          await errorOf(rate(U.dirA2, { ref, score: 1, text: "again" })),
        ).toBe("CONFLICT:MILESTONE_ALREADY_RATED");
      });

      it("two heads creating the filing at once: one wins, the other is told to reload", async () => {
        const ref = await makeEvent();
        const results = await Promise.all([
          errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: null,
              score: 3,
              text: "a",
            }),
          ),
          errorOf(
            as(U.headA2).saveRating({
              ref,
              expectedVersion: null,
              score: 4,
              text: "b",
            }),
          ),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === CONFLICT)).toHaveLength(1);
        expect(
          await db.milestoneSubmission.count({ where: { ccaID: A } }),
        ).toBe(1);
      });

      it("two heads saving the same version at once: no silent lost write", async () => {
        const ref = await makeEvent();
        const first = await as(U.headA).saveRating({
          ref,
          expectedVersion: null,
          score: 3,
          text: "a",
        });
        const results = await Promise.all([
          errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: first.version,
              score: 4,
              text: "b",
            }),
          ),
          errorOf(
            as(U.headA2).saveRating({
              ref,
              expectedVersion: first.version,
              score: 5,
              text: "c",
            }),
          ),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === CONFLICT)).toHaveLength(1);
        const row = await db.milestoneSubmission.findFirstOrThrow({
          where: { ccaID: A },
        });
        expect(row.version).toBe(first.version + 1);
      });

      it("two directors rating at once: one rating", async () => {
        const ref = await makeEvent();
        await file(ref);
        const results = await Promise.all([
          errorOf(rate(U.dirA, { ref, score: 3, text: "a" })),
          errorOf(rate(U.dirA2, { ref, score: 2, text: "b" })),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.find((r) => r !== "ok")).toMatch(
          /^CONFLICT:MILESTONE_(ALREADY_RATED|CONFLICT)$/,
        );
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(1);
      });

      it("a director cannot rate a filing with no photo", async () => {
        const ref = await makeEvent();
        await as(U.headA).saveRating({
          ref,
          expectedVersion: null,
          score: 3,
          text: "x",
        });
        expect(await errorOf(rate(U.dirA, { ref, score: 3, text: "x" }))).toBe(
          "PRECONDITION_FAILED:MILESTONE_NOTHING_TO_RATE",
        );
        const row = await db.milestoneSubmission.findFirstOrThrow({
          where: { ccaID: A },
        });
        expect(row.frozenAt).toBeNull();
      });

      it("a director who also heads the CCA may rate it, with a visible label", async () => {
        const ref = await makeEvent();
        await file(ref);
        await rate(U.both, { ref, score: 5, text: "Mine" });
        const seen = await as(U.headA).get({ ref });
        expect(seen.assessment).toMatchObject({ score: 5, selfRated: true });
      });
    });

    describe("attaching photos (B127)", () => {
      it("refuses another CCA's photo, an attached one, and one past the margin", async () => {
        const ref = await makeEvent();
        const other = await seedPhoto(B);
        expect(
          await errorOf(
            as(U.headA).attach({
              ref,
              expectedVersion: null,
              evidenceIDs: [other.id],
            }),
          ),
        ).toBe("NOT_FOUND:EVIDENCE_NOT_FOUND");

        const taken = await seedPhoto(A, { submissionID: "someone-else" });
        expect(
          await errorOf(
            as(U.headA).attach({
              ref,
              expectedVersion: null,
              evidenceIDs: [taken.id],
            }),
          ),
        ).toBe("CONFLICT:EVIDENCE_ALREADY_ATTACHED");

        const old = await seedPhoto(A, {
          createdAt: new Date(Date.now() - 6.5 * DAY_MS),
        });
        expect(
          await errorOf(
            as(U.headA).attach({
              ref,
              expectedVersion: null,
              evidenceIDs: [old.id],
            }),
          ),
        ).toBe("BAD_REQUEST:EVIDENCE_TOO_OLD");
        expect(
          await db.milestoneSubmission.count({ where: { ccaID: A } }),
        ).toBe(0);
        expect(
          await db.milestoneEvidence.count({
            where: { id: other.id, submissionID: null },
          }),
        ).toBe(1);
      });

      it("a photo attaches to one filing only", async () => {
        const one = await makeEvent();
        const two = await makeEvent();
        const photo = await seedPhoto();
        await as(U.headA).attach({
          ref: one,
          expectedVersion: null,
          evidenceIDs: [photo.id],
        });
        expect(
          await errorOf(
            as(U.headA).attach({
              ref: two,
              expectedVersion: null,
              evidenceIDs: [photo.id],
            }),
          ),
        ).toBe("CONFLICT:EVIDENCE_ALREADY_ATTACHED");
      });

      it("two attaches of one photo at once: one wins and no filing is left over", async () => {
        const one = await makeEvent();
        const two = await makeEvent();
        const photo = await seedPhoto();
        const results = await Promise.all([
          errorOf(
            as(U.headA).attach({
              ref: one,
              expectedVersion: null,
              evidenceIDs: [photo.id],
            }),
          ),
          errorOf(
            as(U.headA2).attach({
              ref: two,
              expectedVersion: null,
              evidenceIDs: [photo.id],
            }),
          ),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(
          await db.milestoneSubmission.count({ where: { ccaID: A } }),
        ).toBe(1);
      });

      it("a head removes evidence while unfrozen: row in the transaction, file after (B153)", async () => {
        const ref = await makeEvent();
        const { version, photo } = await file(ref);
        await as(U.headA).detach({
          ref,
          expectedVersion: version,
          evidenceID: photo.id,
        });
        expect(
          await db.milestoneEvidence.count({ where: { id: photo.id } }),
        ).toBe(0);
        expect(fake.state.removed).toContain(photo.pathname);
      });

      it("a store that cannot delete the file does not undo the detach: the sweep collects it (B153)", async () => {
        const ref = await makeEvent();
        const { version, photo } = await file(ref);
        fake.state.removeFails = true;
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        expect(
          await errorOf(
            as(U.headA).detach({
              ref,
              expectedVersion: version,
              evidenceID: photo.id,
            }),
          ),
        ).toBe("ok");
        expect(
          await db.milestoneEvidence.count({ where: { id: photo.id } }),
        ).toBe(0);
        expect(fake.files.has(photo.pathname)).toBe(true);
        expect(log.mock.calls.map((c) => String(c[0])).join(" ")).toContain(
          "milestone_blob_remove_failed",
        );
        log.mockRestore();
      });

      it("detach first, then rate: the rating of an emptied filing is refused", async () => {
        const ref = await makeEvent();
        const { version, photo } = await file(ref);
        await as(U.headA).detach({
          ref,
          expectedVersion: version,
          evidenceID: photo.id,
        });
        expect(await errorOf(rate(U.dirA, { ref, score: 3, text: "x" }))).toBe(
          "PRECONDITION_FAILED:MILESTONE_NOTHING_TO_RATE",
        );
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(0);
      });

      it("rate first, then detach: the rated filing keeps its photo and its file", async () => {
        const ref = await makeEvent();
        const { version, photo } = await file(ref);
        await rate(U.dirA, { ref, score: 3, text: "Fair" });
        fake.state.removed.length = 0;
        expect(
          await errorOf(
            as(U.headA).detach({
              ref,
              expectedVersion: version,
              evidenceID: photo.id,
            }),
          ),
        ).toBe(FROZEN);
        expect(
          await db.milestoneEvidence.count({ where: { id: photo.id } }),
        ).toBe(1);
        expect(fake.state.removed).toEqual([]);
      });

      it("a rating that lands between the detach's read and its write wins: nothing is stripped", async () => {
        const ref = await makeEvent();
        const { version, photo } = await file(ref);
        // The detach reads the filing as unfrozen; the director then rates.
        const stale = proxied(db, (prop) =>
          prop === "milestoneSubmission"
            ? {
                findUnique: async (args: never) => {
                  const row = await db.milestoneSubmission.findUnique(args);
                  await rate(U.dirA, { ref, score: 3, text: "Fair" });
                  return row;
                },
                updateMany: db.milestoneSubmission.updateMany.bind(
                  db.milestoneSubmission,
                ),
              }
            : undefined,
        );
        fake.state.removed.length = 0;
        const out = await errorOf(
          as(U.headA, stale).detach({
            ref,
            expectedVersion: version,
            evidenceID: photo.id,
          }),
        );
        expect(out).toMatch(/^CONFLICT:MILESTONE_(FROZEN|CONFLICT)$/);
        expect(
          await db.milestoneEvidence.count({ where: { id: photo.id } }),
        ).toBe(1);
        expect(fake.state.removed).toEqual([]);
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(1);
      });

      it("the serving route's access check still works for attached items", async () => {
        const ref = await makeEvent();
        const { photo } = await file(ref);
        const reader = await import("~/server/api/services/milestones/read");
        for (const u of [U.headA, U.dirA]) {
          expect(
            await errorOf(reader.authorizeEvidenceRead(db, u, photo.id)),
            u,
          ).toBe("ok");
        }
        expect(
          await errorOf(reader.authorizeEvidenceRead(db, U.headB, photo.id)),
        ).toBe("NOT_FOUND:EVIDENCE_NOT_FOUND");
      });
    });

    describe("canceled after filing", () => {
      it("keeps the record, accepts nothing more, and stops the reminder", async () => {
        const ref = await makeEvent();
        const { version } = await file(ref);
        await db.event.update({
          where: { eventID: ref.eventID },
          data: { status: "canceled" },
        });
        const seen = await as(U.headA).get({ ref });
        expect(seen.state).toBe("canceled");
        expect(seen.head).toMatchObject({ score: 4 });
        expect(seen.canFile).toBe(false);
        expect(
          await errorOf(
            as(U.headA).saveRating({
              ref,
              expectedVersion: version,
              score: 1,
              text: "x",
            }),
          ),
        ).toBe(NOT_OPEN);
        expect(await errorOf(rate(U.dirA, { ref, score: 3, text: "x" }))).toBe(
          NOT_OPEN,
        );
        expect(
          (await as(U.dirA).year({ ccaID: A })).items.map((i) => i.canceled),
        ).toEqual([true]);
        await runDueCheck(db, U.dirA, { now: new Date() });
        expect(await db.notification.count({ where: { userID: U.dirA } })).toBe(
          0,
        );
      });

      it("a canceled event with nothing filed is not listed", async () => {
        await makeEvent({ status: "canceled" });
        expect((await as(U.headA).year({ ccaID: A })).items).toEqual([]);
      });
    });

    describe("the yearly view", () => {
      const secOf = (iso: string) => Math.floor(Date.parse(iso) / 1000);

      it("derives the year from the date in Singapore time, at the boundary", async () => {
        const late = await makeEvent({
          endTime: secOf("2026-07-31T15:59:59Z"),
          startTime: secOf("2026-07-31T14:00:00Z"),
        });
        const early = await makeEvent({
          endTime: secOf("2026-07-31T16:00:00Z"),
          startTime: secOf("2026-07-31T15:00:00Z"),
        });
        const y25 = await as(U.headA).year({ ccaID: A, year: "AY2025/26" });
        const y26 = await as(U.headA).year({ ccaID: A, year: "AY2026/27" });
        expect(y25.items.map((i) => i.ref)).toEqual([late]);
        expect(y26.items.map((i) => i.ref)).toEqual([early]);
        expect(y25.viewer).toEqual({ head: true, director: false });
      });

      it("lists filed and waiting items with no totals, and bounds each year", async () => {
        const filed = await makeEvent({ hoursAgo: 5 });
        await file(filed);
        await makeEvent({ hoursAgo: 8 });
        const view = await as(U.headA).year({ ccaID: A });
        expect(view.items.map((i) => i.filed).sort()).toEqual([false, true]);
        expect(Object.keys(view).sort()).toEqual(
          ["capped", "ccaID", "items", "skipped", "viewer", "year"].sort(),
        );
        expect(view.capped).toBe(false);
      });

      it("counts and skips a bad stored row", async () => {
        const ref = await makeEvent();
        await db.milestoneSubmission.create({
          data: {
            milestoneKey: `event:${ref.eventID}`,
            ccaID: A,
            eventID: ref.eventID,
            proposalID: null,
            headScore: 9,
            headText: "bad",
            version: 1,
          },
        });
        const view = await as(U.headA).year({ ccaID: A });
        expect(view.items).toEqual([]);
        expect(view.skipped).toBe(1);
      });
    });

    describe("reminders (A51, A50)", () => {
      const kind = "milestone.waiting";

      it("one notice per person per Singapore day, with two tabs, counting what waits", async () => {
        await makeEvent();
        await makeEvent({ hoursAgo: 9 });
        const now = new Date();
        const results = await Promise.all([
          runDueCheck(db, U.headA, { now }),
          runDueCheck(db, U.headA, { now }),
        ]);
        expect(results.reduce((n, r) => n + r.written, 0)).toBe(1);
        const rows = await db.notification.findMany({
          where: { userID: U.headA, kind },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.title).toBe("2 milestones are waiting");
        expect(rows[0]!.body).toBe(
          "2 to file in the last 90 days. Older ones are on the yearly view.",
        );
        await runDueCheck(db, U.headA, { now });
        expect(
          await db.notification.count({ where: { userID: U.headA, kind } }),
        ).toBe(1);
      });

      it("a director is told what to rate, only once a photo is in", async () => {
        const ref = await makeEvent();
        await runDueCheck(db, U.dirA, { now: new Date() });
        expect(await db.notification.count({ where: { userID: U.dirA } })).toBe(
          0,
        );
        await file(ref);
        await runDueCheck(db, U.dirA, { now: new Date() });
        const row = await db.notification.findFirstOrThrow({
          where: { userID: U.dirA },
        });
        expect(row.body).toBe(
          "1 to rate in the last 90 days. Older ones are on the yearly view.",
        );
      });

      it("nothing due gets nothing; rated, canceled and not-yet-ended items do not count", async () => {
        const rated = await makeEvent();
        await file(rated);
        await rate(U.dirA, { ref: rated, score: 3, text: "ok" });
        await makeEvent({ status: "canceled" });
        await makeEvent({ hoursAgo: -4 });
        await makeEvent({ ccaID: null });
        for (const u of [U.headA, U.dirA, U.headB, U.resident, U.admin]) {
          const res = await runDueCheck(db, u, { now: new Date() });
          expect(res.failedKinds).toEqual([]);
        }
        expect(
          await db.notification.count({ where: { userID: { in: IDS }, kind } }),
        ).toBe(0);
      });

      it("writes nothing while the flag is off", async () => {
        await makeEvent();
        await setFlag("milestones.enabled", "off");
        await runDueCheck(db, U.headA, { now: new Date() });
        expect(
          await db.notification.count({ where: { userID: U.headA } }),
        ).toBe(0);
      });

      it("a failed read logs the kind and writes nothing", async () => {
        await makeEvent();
        const res = await runDueCheck(withFailingRead("event"), U.headA, {
          now: new Date(),
        });
        expect(res.failedKinds).toContain("milestones");
        expect(
          await db.notification.count({ where: { userID: U.headA } }),
        ).toBe(0);
      });

      it("the unread count still writes nothing", async () => {
        await makeEvent();
        const ops: string[] = [];
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
        const res = await base(
          U.headA,
          EVERYTHING,
          spying,
        ).notifications.unreadCount();
        expect(res.count).toBe(0);
        expect(ops.filter((o) => !/\.(find|count|aggregate)/.test(o))).toEqual(
          [],
        );
        expect(
          await db.notification.count({ where: { userID: U.headA } }),
        ).toBe(0);
        expect(inbox).toBeTypeOf("function");
      });
    });

    describe("the home entries", () => {
      it("lists each CCA a person heads or directs with what is waiting", async () => {
        await makeEvent();
        const mine = await as(U.both).mine();
        expect(mine.rows).toEqual([
          {
            ccaID: A,
            ccaName: `Test CCA ${A}`,
            head: true,
            director: true,
            toFile: 1,
            toRate: 0,
          },
        ]);
        expect((await as(U.resident).mine()).rows).toEqual([]);
      });
    });

    describe("review fixes (B149 to B152)", () => {
      const eventClaim = (proposalID: string, ageMs = 0) =>
        db.proposal.update({
          where: { id: proposalID },
          data: {
            eventID: 123_456_001,
            eventClaimedAt: new Date(Date.now() - ageMs),
          },
        });

      it("a proposal with an Event claim takes no filing, fresh or abandoned", async () => {
        const fresh = await makeProposal();
        await eventClaim(fresh.proposalID);
        const stale = await makeProposal();
        await eventClaim(stale.proposalID, 10 * 60_000);
        for (const ref of [fresh, stale]) {
          expect(
            await errorOf(
              as(U.headA).saveRating({
                ref,
                expectedVersion: null,
                score: 4,
                text: "x",
              }),
            ),
          ).toBe(NOT_OPEN);
          expect(
            await db.milestoneSubmission.count({
              where: { milestoneKey: `proposal:${ref.proposalID}` },
            }),
          ).toBe(0);
        }
      });

      it("a claim that lands right after the first look takes the new filing back out", async () => {
        const ref = await makeProposal();
        const photo = await seedPhoto();
        // The open check sees no claim; the check after the filing commits does.
        let looks = 0;
        const late = proxied(db, (prop) =>
          prop === "proposal"
            ? {
                findUnique: async (args: never) => {
                  looks += 1;
                  if (looks === 2) await eventClaim(ref.proposalID);
                  return db.proposal.findUnique(args);
                },
              }
            : undefined,
        );
        expect(
          await errorOf(
            as(U.headA, late).attach({
              ref,
              expectedVersion: null,
              evidenceIDs: [photo.id],
            }),
          ),
        ).toBe(NOT_OPEN);
        expect(
          await db.milestoneSubmission.count({
            where: { milestoneKey: `proposal:${ref.proposalID}` },
          }),
        ).toBe(0);
        expect(
          (
            await db.milestoneEvidence.findUniqueOrThrow({
              where: { id: photo.id },
            })
          ).submissionID,
        ).toBeNull();
      });

      it("a director cannot rate a filing that changed since they loaded it, and can after reloading", async () => {
        const ref = await makeEvent();
        const { version } = await file(ref);
        const loaded = await as(U.dirA).get({ ref });
        await as(U.headA).saveRating({
          ref,
          expectedVersion: version,
          score: 1,
          text: "Second thoughts",
        });
        expect(
          await errorOf(
            as(U.dirA).rate({ ref, seen: loaded.seen!, score: 3, text: "x" }),
          ),
        ).toBe(CONFLICT);
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(0);
        const fresh = await as(U.dirA).get({ ref });
        expect(fresh.seen).not.toBe(loaded.seen);
        await as(U.dirA).rate({ ref, seen: fresh.seen!, score: 3, text: "ok" });
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(1);
      });

      it("a head's save between the director's check and the freeze is refused too", async () => {
        const ref = await makeEvent();
        const { version } = await file(ref);
        const loaded = await as(U.dirA).get({ ref });
        const racing = proxied(db, (prop) =>
          prop === "milestoneSubmission"
            ? {
                findUnique: async (args: never) => {
                  const row = await db.milestoneSubmission.findUnique(args);
                  await as(U.headA).saveRating({
                    ref,
                    expectedVersion: version,
                    score: 2,
                    text: "Changed",
                  });
                  return row;
                },
                updateMany: db.milestoneSubmission.updateMany.bind(
                  db.milestoneSubmission,
                ),
              }
            : undefined,
        );
        expect(
          await errorOf(
            as(U.dirA, racing).rate({
              ref,
              seen: loaded.seen!,
              score: 3,
              text: "x",
            }),
          ),
        ).toBe(CONFLICT);
        expect(
          await db.milestoneAssessment.count({ where: { ccaID: A } }),
        ).toBe(0);
      });

      it("a person who is both head and director counts once per milestone", async () => {
        const ref = await makeEvent();
        const photo = await seedPhoto();
        await as(U.headA2).attach({
          ref,
          expectedVersion: null,
          evidenceIDs: [photo.id],
        });
        const res = await runDueCheck(db, U.both, { now: new Date() });
        expect(res.written).toBe(1);
        const row = await db.notification.findFirstOrThrow({
          where: { userID: U.both, kind: "milestone.waiting" },
        });
        expect(row.title).toBe("1 milestone is waiting");
        expect(row.body).toBe(
          "1 to file, 1 to rate in the last 90 days. Older ones are on the yearly view.",
        );
      });

      it("counts a milestone that ended 89 days ago and not one that ended 91 days ago", async () => {
        await makeEvent({ hoursAgo: 91 * 24 });
        await runDueCheck(db, U.headA, { now: new Date() });
        expect(
          await db.notification.count({ where: { userID: U.headA } }),
        ).toBe(0);
        await makeEvent({ hoursAgo: 89 * 24 });
        await db.rateLimit.deleteMany({
          where: { key: `notifications.dueCheck:${U.headA}` },
        });
        await runDueCheck(db, U.headA, { now: new Date() });
        const row = await db.notification.findFirstOrThrow({
          where: { userID: U.headA },
        });
        expect(row.title).toBe("1 milestone is waiting");
      });

      it("says at least, and logs only a count, when a scan cap is hit", async () => {
        const end = nowSec() - 5 * HOUR;
        await db.event.createMany({
          data: Array.from({ length: 301 }, (_, i) => ({
            eventID: EV0 + 5000 + i,
            createdBy: U.headA,
            title: `TEST event cap ${i}`,
            status: "published",
            ccaID: A,
            startTime: end - HOUR,
            endTime: end,
          })),
        });
        const log = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        await runDueCheck(db, U.headA, { now: new Date() });
        const row = await db.notification.findFirstOrThrow({
          where: { userID: U.headA },
        });
        expect(row.title).toBe("at least 300 milestones are waiting");
        const logged = log.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain(
          '{"evt":"milestone_reminder_capped","waiting":300}',
        );
        expect(logged).not.toContain("TEST event");
        log.mockRestore();
        const mine = await as(U.headA).mine();
        expect(mine.capped).toBe(true);
      });
    });

    describe("account deletion", () => {
      it("keeps the CCA's record, clears the names and leaves no power", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "../userAdmin"
        );
        const ref = await makeEvent();
        await file(ref);
        await rate(U.dirA, { ref, score: 3, text: "Fair" });
        const head = await db.user.create({
          data: { email: "e9991601@u.nus.edu", userID: U.headA },
        });
        const result = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, head.id),
          U.admin,
        );
        expect(result.deleted).toMatchObject({ milestoneHeadCleared: 1 });
        expect(
          await db.milestoneSubmission.findFirstOrThrow({
            where: { ccaID: A },
          }),
        ).toMatchObject({ headBy: null, headScore: 4, headText: "Went well" });
        const director = await db.user.create({
          data: { email: "e9991604@u.nus.edu", userID: U.dirA },
        });
        const res2 = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, director.id),
          U.admin,
        );
        expect(res2.deleted).toMatchObject({ milestoneAssessorCleared: 1 });
        expect(
          await db.milestoneAssessment.findFirstOrThrow({
            where: { ccaID: A },
          }),
        ).toMatchObject({ assessedBy: null, score: 3 });
        expect(await db.milestoneEvidence.count({ where: { ccaID: A } })).toBe(
          1,
        );
      });
    });
  },
);
