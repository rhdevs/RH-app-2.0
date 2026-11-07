import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
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

// Every Blob call is replaced: no real store, no real token.
const blob = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

import { CCA_BLOB_HOST } from "~/lib/schemas/cca";
import { eventUploadPath } from "~/lib/schemas/event";
import { proposalPosterPath } from "~/lib/schemas/proposalFiles";

/**
 * INTEGRATION TESTS of proposal posters and document links against the LOCAL
 * development database (skipped unless DATABASE_URL is the local dev database;
 * run with `npm run test:db`). The tests own every row they touch: users
 * E99907xx, CCAs 9011 and 9012 (proposals and heads only; the CCA rows are
 * never written), positions named "TEST F7 ...". The flag rows are put back as
 * they were.
 */

const U = {
  head: "E9990701", // heads CCA 9011
  headOther: "E9990702", // heads CCA 9012
  dir: "E9990703", // director of 9011
  admin: "E9990704",
};
const IDS = Object.values(U);
const CCA = 9011;
const CCA_OTHER = 9012;
const CCAS = [CCA, CCA_OTHER];
const FLAGS = [
  "proposals.enabled",
  "directors.enabled",
  "notifications.enabled",
];
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const START = 1_900_000_000;

const posterOf = (proposalID: string, tail = "-aB3xY9.webp") =>
  `https://${CCA_BLOB_HOST}/${proposalPosterPath(proposalID)}${tail}`;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "proposal posters and document links (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;

    const as = (userID: string) =>
      createCaller({
        db: db as never,
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
            in: (["create", "update", "submit", "upload"] as const).flatMap(
              (a) => IDS.map((id) => `proposal.${a}:${id}`),
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
      await db.proposal.deleteMany({ where: { id: { in: ids } } });
      await db.ccaHead.deleteMany({ where: { userID: { in: IDS } } });
      const positions = await db.jcrcPosition.findMany({
        where: { name: { startsWith: "TEST F7" } },
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
    };

    const setRoles = (userID: string, roles: string[]) =>
      db.userRole.create({
        data: { userID, roles, updatedAt: new Date(), updatedBy: "test" },
      });

    /** A draft by `head`, with the fields an event needs but no files. */
    const makeDraft = async (over: Record<string, unknown> = {}) =>
      as(U.head).create({
        ccaID: CCA,
        category: "pubs",
        title: "Quiz night",
        description: "A quiz",
        blastMessage: "Come along",
        plannedStart: START,
        ...over,
      });

    const rowOf = (id: string) =>
      db.proposal.findUniqueOrThrow({ where: { id } });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      for (const key of FLAGS) {
        original[key] =
          (await db.systemFlag.findUnique({ where: { key } }))?.value ?? null;
      }
    }, 120_000);

    beforeEach(async () => {
      await clean();
      blob.del.mockReset();
      blob.del.mockResolvedValue(undefined);
      await setFlag("proposals.enabled", "on");
      await setFlag("directors.enabled", "on");
      await setFlag("notifications.enabled", "off");
      await setRoles(U.head, ["resident", "cca_head"]);
      await setRoles(U.headOther, ["resident", "cca_head"]);
      await setRoles(U.dir, ["resident", "jcrc"]);
      await setRoles(U.admin, ["resident", "admin"]);
      await db.ccaHead.create({ data: { userID: U.head, ccaID: CCA } });
      await db.ccaHead.create({
        data: { userID: U.headOther, ccaID: CCA_OTHER },
      });
      const position = await db.jcrcPosition.create({
        data: {
          name: "TEST F7 Dir",
          createdBy: "test",
          overseesAll: false,
          vetsProposals: true,
        },
      });
      await db.jcrcPositionCca.create({
        data: { positionID: position.id, ccaID: CCA, addedBy: "test" },
      });
      await db.jcrcPositionHolder.create({
        data: {
          positionID: position.id,
          userID: U.dir,
          assignedBy: U.admin,
          endsAt: null,
        },
      });
    });

    afterAll(async () => {
      if (db) {
        await clean();
        for (const key of FLAGS) await setFlag(key, original[key] ?? null);
        await db.$disconnect();
      }
    });

    describe("attaching", () => {
      it("a new draft has explicit nulls for both fields", async () => {
        const made = await makeDraft();
        expect(await rowOf(made.id)).toMatchObject({
          posterUrl: null,
          docLink: null,
        });
      });

      it("a head attaches a poster and a link through the versioned update", async () => {
        const made = await makeDraft();
        const url = posterOf(made.id);
        const saved = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: url,
          docLink: " https://docs.example.com/plan ",
        });
        expect(saved.version).toBe(made.version + 1);
        expect(await rowOf(made.id)).toMatchObject({
          posterUrl: url,
          docLink: "https://docs.example.com/plan",
          version: made.version + 1,
        });
        expect(blob.del).not.toHaveBeenCalled();
      });

      it("a link can be given when the draft is created", async () => {
        const made = await makeDraft({ docLink: "https://docs.example.com/a" });
        expect((await rowOf(made.id)).docLink).toBe(
          "https://docs.example.com/a",
        );
        expect(
          await errorOf(makeDraft({ docLink: "javascript:alert(1)" })),
        ).toMatch(/^BAD_REQUEST/);
      });

      it("refuses another proposal's poster, an Event image and a bad link, and changes nothing", async () => {
        const made = await makeDraft();
        const other = await makeDraft({ title: "Other" });
        const bad = [
          { posterUrl: posterOf(other.id) },
          {
            posterUrl: `https://${CCA_BLOB_HOST}/${eventUploadPath(1, "banner")}-a.webp`,
          },
          { posterUrl: "https://evil.example.com/a.webp" },
          { docLink: "javascript:alert(1)" },
          { docLink: "http://docs.example.com" },
          { docLink: "https://user:pw@docs.example.com" },
        ];
        for (const fields of bad) {
          expect(
            await errorOf(
              as(U.head).update({
                id: made.id,
                version: made.version,
                ...fields,
              }),
            ),
          ).toMatch(/^BAD_REQUEST/);
        }
        expect(await rowOf(made.id)).toMatchObject({
          posterUrl: null,
          docLink: null,
          version: made.version,
        });
        expect(blob.del).not.toHaveBeenCalled();
      });

      it("a person who does not head the CCA cannot attach, and gets NOT_FOUND", async () => {
        const made = await makeDraft();
        const err = await errorOf(
          as(U.headOther).update({
            id: made.id,
            version: made.version,
            posterUrl: posterOf(made.id),
          }),
        );
        expect(err).toBe("NOT_FOUND:PROPOSAL_NOT_FOUND");
        expect((await rowOf(made.id)).posterUrl).toBeNull();
      });

      it("refuses when the flag is off", async () => {
        const made = await makeDraft();
        await setFlag("proposals.enabled", "off");
        expect(
          await errorOf(
            as(U.head).update({
              id: made.id,
              version: made.version,
              docLink: "https://docs.example.com/a",
            }),
          ),
        ).toBe("FORBIDDEN:PROPOSALS_DISABLED");
      });

      it("a stale version is a conflict: nothing is written and no blob is deleted", async () => {
        const made = await makeDraft();
        const first = posterOf(made.id, "-first1.webp");
        await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: first,
        });
        const err = await errorOf(
          as(U.head).update({
            id: made.id,
            version: made.version, // stale: the other tab saved first
            posterUrl: posterOf(made.id, "-second.webp"),
          }),
        );
        expect(err).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect((await rowOf(made.id)).posterUrl).toBe(first);
        expect(blob.del).not.toHaveBeenCalled();
      });

      it("a proposal under review cannot take a new poster", async () => {
        const made = await makeDraft();
        const url = posterOf(made.id);
        const saved = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: url,
        });
        await as(U.head).submit({ id: made.id, version: saved.version });
        const locked = await rowOf(made.id);
        expect(
          await errorOf(
            as(U.head).update({
              id: made.id,
              version: locked.version,
              posterUrl: posterOf(made.id, "-late00.webp"),
            }),
          ),
        ).toBe("CONFLICT:PROPOSAL_CONFLICT");
        expect((await rowOf(made.id)).posterUrl).toBe(url);
        expect(blob.del).not.toHaveBeenCalled();
      });
    });

    describe("replacing and removing", () => {
      it("deletes the old blob after the write, once, and only the old one", async () => {
        const made = await makeDraft();
        const one = posterOf(made.id, "-one111.webp");
        const two = posterOf(made.id, "-two222.webp");
        const a = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: one,
        });
        expect(blob.del).not.toHaveBeenCalled();

        // The stand-in checks the write had already landed when it was called.
        blob.del.mockImplementation(async () => {
          expect((await rowOf(made.id)).posterUrl).toBe(two);
        });
        await as(U.head).update({
          id: made.id,
          version: a.version,
          posterUrl: two,
        });
        expect(blob.del).toHaveBeenCalledTimes(1);
        expect(blob.del).toHaveBeenCalledWith(one);
        expect((await rowOf(made.id)).posterUrl).toBe(two);
      });

      it("saving the same poster again, or other fields only, deletes nothing", async () => {
        const made = await makeDraft();
        const url = posterOf(made.id);
        const a = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: url,
        });
        const b = await as(U.head).update({
          id: made.id,
          version: a.version,
          posterUrl: url,
          title: "Renamed",
        });
        await as(U.head).update({
          id: made.id,
          version: b.version,
          description: "No poster field at all",
        });
        expect(blob.del).not.toHaveBeenCalled();
        expect((await rowOf(made.id)).posterUrl).toBe(url);
      });

      it("the same address spelled with #1, ?x or other case is refused and its blob is not deleted", async () => {
        const made = await makeDraft();
        const url = posterOf(made.id);
        const a = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: url,
        });
        for (const spelled of [
          url + "#1",
          url + "?x",
          url.replace("/proposal/", "/Proposal/"),
        ]) {
          expect(
            await errorOf(
              as(U.head).update({
                id: made.id,
                version: a.version,
                posterUrl: spelled,
              }),
            ),
          ).toMatch(/^BAD_REQUEST/);
        }
        expect(blob.del).not.toHaveBeenCalled();
        expect(await rowOf(made.id)).toMatchObject({
          posterUrl: url,
          version: a.version,
        });
      });

      it("removing the poster deletes its blob", async () => {
        const made = await makeDraft();
        const url = posterOf(made.id);
        const a = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: url,
        });
        await as(U.head).update({
          id: made.id,
          version: a.version,
          posterUrl: null,
        });
        expect(blob.del).toHaveBeenCalledExactlyOnceWith(url);
        expect((await rowOf(made.id)).posterUrl).toBeNull();
      });

      it("a failed deletion is logged and does not undo the write", async () => {
        const made = await makeDraft();
        const one = posterOf(made.id, "-one111.webp");
        const two = posterOf(made.id, "-two222.webp");
        const a = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: one,
        });
        blob.del.mockRejectedValue(new Error("store unreachable"));
        const spy = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        const b = await as(U.head).update({
          id: made.id,
          version: a.version,
          posterUrl: two,
        });
        expect(b.version).toBe(a.version + 1);
        expect((await rowOf(made.id)).posterUrl).toBe(two);
        const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(logged).toContain("proposal_blob_delete_failed");
        expect(logged).not.toContain("store unreachable");
        spy.mockRestore();
      });

      it("does not pass a stored address that is not this proposal's own to the store", async () => {
        const made = await makeDraft();
        // A row written some other way, with an address outside the prefix.
        await db.proposal.update({
          where: { id: made.id },
          data: { posterUrl: "https://elsewhere.example.com/x.webp" },
        });
        await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: null,
        });
        expect(blob.del).not.toHaveBeenCalled();
      });
    });

    describe("submit enforces the category rules", () => {
      const submitError = async (id: string) => {
        const row = await rowOf(id);
        return errorOf(as(U.head).submit({ id, version: row.version }));
      };

      it("an event without a poster or a link is refused and the draft is untouched (A20)", async () => {
        const made = await makeDraft({ category: "event" });
        const before = await rowOf(made.id);
        const err = await submitError(made.id);
        expect(err).toMatch(/^BAD_REQUEST:PROPOSAL_INCOMPLETE:/);
        expect(err).toContain("A poster");
        expect(err).toContain("A document link");
        expect(await rowOf(made.id)).toEqual(before);
        expect(
          await db.proposalStatusHistory.count({
            where: { proposalID: made.id },
          }),
        ).toBe(0);
      });

      it("an event with a poster but no link is still refused, naming only the link", async () => {
        const made = await makeDraft({ category: "event" });
        await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: posterOf(made.id),
        });
        const err = await submitError(made.id);
        expect(err).toContain("A document link");
        expect(err).not.toContain("A poster");
        expect((await rowOf(made.id)).status).toBe("draft");
      });

      it("an event with both goes to review", async () => {
        const made = await makeDraft({ category: "event" });
        const saved = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: posterOf(made.id),
          docLink: "https://docs.example.com/plan",
        });
        const moved = await as(U.head).submit({
          id: made.id,
          version: saved.version,
        });
        expect(moved.status).toBe("in_review");
        expect((await rowOf(made.id)).status).toBe("in_review");
      });

      it("merch needs a poster and a link but no date or blast message", async () => {
        const made = await makeDraft({
          category: "merch",
          blastMessage: null,
          plannedStart: null,
        });
        const err = await submitError(made.id);
        expect(err).toContain("A poster");
        expect(err).toContain("A document link");
        expect(err).not.toContain("start date");
      });

      it("welfare needs a poster and no link; decor and pubs need neither", async () => {
        const welfare = await makeDraft({ category: "welfare" });
        const err = await submitError(welfare.id);
        expect(err).toContain("A poster");
        expect(err).not.toContain("A document link");

        for (const category of ["decor", "pubs"] as const) {
          const made = await makeDraft({ category });
          expect(await submitError(made.id)).toBe("ok");
        }
      });

      it("a link stored outside the validator (a tampered row) does not count", async () => {
        const made = await makeDraft({ category: "merch" });
        await db.proposal.update({
          where: { id: made.id },
          data: {
            posterUrl: posterOf(made.id),
            docLink: "javascript:alert(1)",
          },
        });
        expect(await submitError(made.id)).toContain("A document link");
      });
    });

    describe("reading", () => {
      it("a head and the CCA's director both see the poster and the link once submitted", async () => {
        const made = await makeDraft();
        const url = posterOf(made.id);
        const saved = await as(U.head).update({
          id: made.id,
          version: made.version,
          posterUrl: url,
          docLink: "https://docs.example.com/plan",
        });
        const asHead = await as(U.head).get({ id: made.id });
        expect(asHead).toMatchObject({
          viewer: "head",
          posterUrl: url,
          docLink: "https://docs.example.com/plan",
        });

        await as(U.head).submit({ id: made.id, version: saved.version });
        const asDirector = await as(U.dir).get({ id: made.id });
        expect(asDirector).toMatchObject({
          viewer: "director",
          posterUrl: url,
          docLink: "https://docs.example.com/plan",
        });
      });

      it("a row from before this change reads as null, and another CCA's head sees nothing", async () => {
        const made = await makeDraft();
        const detail = await as(U.head).get({ id: made.id });
        expect(detail.posterUrl).toBeNull();
        expect(detail.docLink).toBeNull();
        expect(await errorOf(as(U.headOther).get({ id: made.id }))).toBe(
          "NOT_FOUND:PROPOSAL_NOT_FOUND",
        );
      });
    });
  },
);
