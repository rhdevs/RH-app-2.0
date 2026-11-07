import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import type * as ReadModule from "~/server/api/services/milestones/read";
import type * as WriteModule from "~/server/api/services/milestones/write";
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
 * INTEGRATION TESTS of private milestone evidence (F21) against the LOCAL
 * development database (skipped unless DATABASE_URL is the local dev database;
 * run `npm run test:db`). Run this file on its own. It needs the index script
 * (create-milestone-indexes.mjs --commit) to have run, for the unique pathname.
 *
 * The private store is replaced by an in-memory fake (no Blob call is made, no
 * credential is read). The tests own every row they touch: users E99915xx,
 * CCAs 9803 and 9804 (heads and evidence only; the CCA rows are never
 * written), positions named "TEST ...", and every `milestone.*` counter. The
 * flag rows are put back as they were.
 */

const fake = vi.hoisted(() => {
  const host = "teststore.private.blob.vercel-storage.com";
  const files = new Map<
    string,
    { size: number; contentType: string; uploadedAt?: Date }
  >();
  const state = {
    removeFails: false,
    removed: [] as string[],
    heads: 0,
    lists: [] as { prefix: string; limit: number }[],
    listFails: false,
  };
  const storage = {
    host: () => host,
    head: (pathname: string) => {
      state.heads += 1;
      return Promise.resolve(files.get(pathname) ?? null);
    },
    // Like the real module: bounded by `limit`, and an empty list on a fault.
    listBlobs: (prefix: string, limit: number) => {
      state.lists.push({ prefix, limit });
      if (state.listFails) return Promise.resolve([]);
      return Promise.resolve(
        [...files.entries()]
          .filter(([pathname]) => pathname.startsWith(prefix))
          .slice(0, limit)
          .map(([pathname, meta]) => ({
            pathname,
            uploadedAt: meta.uploadedAt ?? new Date(),
          })),
      );
    },
    read: (pathname: string) => {
      const meta = files.get(pathname);
      return Promise.resolve(
        meta ? { ...meta, stream: new ReadableStream<Uint8Array>() } : null,
      );
    },
    remove: (pathname: string) => {
      state.removed.push(pathname);
      if (state.removeFails) return Promise.resolve(false);
      files.delete(pathname);
      return Promise.resolve(true);
    },
  };
  return { host, files, state, storage };
});

vi.mock("~/server/api/services/milestoneBlob", () => ({
  MILESTONE_STORAGE_NOT_CONFIGURED: "MILESTONE_STORAGE_NOT_CONFIGURED",
  evidenceStorage: fake.storage,
}));

const U = {
  headA: "E9991501", // heads 9803
  headA2: "E9991502", // heads 9803
  headB: "E9991503", // heads 9804
  dirA: "E9991504", // director of 9803
  dirB: "E9991505", // director of 9804
  other: "E9991506", // holds a position that does not vet proposals
  jcrc: "E9991507", // jcrc, no position
  admin: "E9991508",
  scrc: "E9991509",
  resident: "E9991510",
  both: "E9991511", // heads 9803 and directs 9803
};
const IDS = Object.values(U);
const A = 9803;
const B = 9804;
const FLAGS = ["milestones.enabled", "directors.enabled"];
const EVERYTHING = ["resident", "admin", "jcrc", "cca_head", "scrc"];
const NOT_HEAD = "FORBIDDEN:NOT_EVIDENCE_HEAD";
const NOT_FOUND = "NOT_FOUND:EVIDENCE_NOT_FOUND";
const CHECK_FAILED = "FORBIDDEN:MILESTONE_ACCESS_CHECK_FAILED";
const DISABLED = "FORBIDDEN:MILESTONES_DISABLED";
const RATE = /^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const urlOf = (ccaID: number, name = "evidence-aB3dE5", ext = "webp") =>
  `https://${fake.host}/milestone-evidence/${ccaID}/${name}.${ext}`;
const pathOf = (ccaID: number, name = "evidence-aB3dE5", ext = "webp") =>
  `milestone-evidence/${ccaID}/${name}.${ext}`;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "milestone evidence (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let service: typeof WriteModule;
    let reader: typeof ReadModule;
    const original: Record<string, string | null> = {};
    let ipCounter = 0;
    let seq = 0;

    const caller = (
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
      });
    const as = (u: string, roles?: string[], client?: PrismaClient) =>
      caller(u, roles, client).milestoneEvidence;

    const setFlag = async (key: string, value: string | null) => {
      if (value === null) await db.systemFlag.deleteMany({ where: { key } });
      else {
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
            in: ["upload", "record", "remove", "view"].flatMap((a) =>
              IDS.map((i) => `milestone.${a}:${i}`),
            ),
          },
        },
      });
      await db.milestoneEvidence.deleteMany({
        where: { OR: [{ ccaID: { in: [A, B] } }, { uploadedBy: { in: IDS } }] },
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
      await db.user.deleteMany({ where: { email: { startsWith: "e99915" } } });
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
    const failingTable = () => {
      const boom = () => Promise.reject(new Error("db down"));
      return {
        findFirst: boom,
        findMany: boom,
        findUnique: boom,
        count: boom,
      };
    };
    const withFailingRead = (table: string): PrismaClient =>
      proxied(db, (prop) => (prop === table ? failingTable() : undefined));

    /** A stored photo and its row, both seeded directly. */
    const seed = async (
      ccaID: number,
      over: {
        createdAt?: Date;
        submissionID?: string | null;
        uploadedBy?: string | null;
      } = {},
    ) => {
      seq += 1;
      const pathname = pathOf(ccaID, `evidence-seed${seq}`);
      fake.files.set(pathname, { size: 1000, contentType: "image/webp" });
      return db.milestoneEvidence.create({
        data: {
          ccaID,
          pathname,
          contentType: "image/webp",
          size: 1000,
          uploadedBy: over.uploadedBy === undefined ? U.headA : over.uploadedBy,
          submissionID: over.submissionID ?? null,
          createdAt: over.createdAt ?? new Date(),
        },
      });
    };
    const put = (
      ccaID: number,
      size = 5000,
      contentType = "image/webp",
      name = "evidence-aB3dE5",
      ext = "webp",
    ) => {
      fake.files.set(pathOf(ccaID, name, ext), { size, contentType });
      return urlOf(ccaID, name, ext);
    };
    const rows = (ccaID = A) =>
      db.milestoneEvidence.count({ where: { ccaID } });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      service = await import("~/server/api/services/milestones/write");
      reader = await import("~/server/api/services/milestones/read");
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
      fake.state.heads = 0;
      fake.state.lists.length = 0;
      fake.state.listFails = false;
      for (const key of FLAGS) await setFlag(key, "on");
      for (const id of [U.headA, U.headA2, U.headB]) {
        await setRoles(id, ["resident", "cca_head"]);
      }
      await setRoles(U.both, ["resident", "cca_head", "jcrc"]);
      for (const id of [U.dirA, U.dirB, U.other, U.jcrc]) {
        await setRoles(id, ["resident", "jcrc"]);
      }
      await setRoles(U.admin, ["resident", "admin"]);
      await setRoles(U.scrc, ["resident", "scrc"]);
      await setRoles(U.resident, ["resident"]);
      for (const [userID, ccaID] of [
        [U.headA, A],
        [U.headA2, A],
        [U.headB, B],
        [U.both, A],
      ] as const) {
        await db.ccaHead.create({ data: { userID, ccaID } });
      }
      await makePosition("Dir A", U.dirA, { vets: true, ccaIDs: [A] });
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

    describe("the flag", () => {
      it("is off when absent, odd or unreadable, and everything refuses", async () => {
        const row = await seed(A);
        for (const value of [null, "off", "ON", ""]) {
          await setFlag("milestones.enabled", value);
          expect((await as(U.headA).enabled()).enabled).toBe(false);
          expect(await errorOf(as(U.headA).list({ ccaID: A }))).toBe(DISABLED);
          expect(
            await errorOf(as(U.headA).record({ ccaID: A, url: put(A) })),
          ).toBe(DISABLED);
          expect(await errorOf(as(U.headA).remove({ id: row.id }))).toBe(
            DISABLED,
          );
          expect(
            await errorOf(
              service.authorizeEvidenceUpload(
                db,
                fake.storage,
                U.headA,
                pathOf(A, "evidence"),
              ),
            ),
          ).toMatch(/MILESTONES_DISABLED/);
          expect(
            await errorOf(reader.authorizeEvidenceRead(db, U.headA, row.id)),
          ).toBe(NOT_FOUND);
          expect(
            await errorOf(reader.authorizeEvidenceRead(db, U.dirA, row.id)),
          ).toBe(NOT_FOUND);
        }
        expect(fake.state.heads).toBe(0);
        expect(fake.state.removed).toEqual([]);
      });

      it("a failed flag read counts as off", async () => {
        const down = withFailingRead("systemFlag");
        expect((await as(U.headA, EVERYTHING, down).enabled()).enabled).toBe(
          false,
        );
        expect(
          await errorOf(as(U.headA, EVERYTHING, down).list({ ccaID: A })),
        ).toBe(DISABLED);
      });
    });

    describe("who may act", () => {
      it("a head of the CCA lists, records and removes", async () => {
        const url = put(A);
        const saved = await as(U.headA).record({ ccaID: A, url });
        expect(saved).toMatchObject({ contentType: "image/webp", size: 5000 });
        expect(Object.keys(saved).sort()).toEqual([
          "contentType",
          "createdAt",
          "id",
          "size",
        ]);
        const listed = await as(U.headA).list({ ccaID: A });
        expect(listed.map((r) => r.id)).toEqual([saved.id]);
        // Another head of the same CCA sees and removes it too.
        expect(await as(U.headA2).list({ ccaID: A })).toHaveLength(1);
        expect(await as(U.headA2).remove({ id: saved.id })).toEqual({
          removed: true,
        });
        expect(await rows()).toBe(0);
        expect(fake.state.removed).toEqual([pathOf(A)]);
      });

      it("nobody else lists, records, uploads or removes", async () => {
        const row = await seed(A);
        const refused = [
          U.headB, // heads another CCA
          U.dirA, // a director may view, nothing else
          U.dirB,
          U.other,
          U.jcrc,
          U.admin,
          U.scrc,
          U.resident,
        ];
        for (const who of refused) {
          expect(await errorOf(as(who).list({ ccaID: A }))).toBe(NOT_HEAD);
          expect(await errorOf(as(who).record({ ccaID: A, url: put(A) }))).toBe(
            NOT_HEAD,
          );
          expect(await errorOf(as(who).remove({ id: row.id }))).toBe(NOT_FOUND);
          expect(
            await errorOf(
              service.authorizeEvidenceUpload(
                db,
                fake.storage,
                who,
                pathOf(A, "evidence"),
              ),
            ),
          ).toMatch(/NOT_EVIDENCE_HEAD/);
        }
        expect(await rows()).toBe(1);
        expect(fake.state.removed).toEqual([]);
      });

      it("a session that claims cca_head without a head row is refused", async () => {
        expect(
          await errorOf(
            as(U.resident, ["resident", "cca_head"]).list({ ccaID: A }),
          ),
        ).toBe(NOT_HEAD);
      });

      it("a person removed as head is refused on the next call", async () => {
        await db.ccaHead.deleteMany({ where: { userID: U.headA2 } });
        expect(await errorOf(as(U.headA2).list({ ccaID: A }))).toBe(NOT_HEAD);
        expect(
          await errorOf(
            service.authorizeEvidenceUpload(
              db,
              fake.storage,
              U.headA2,
              pathOf(A, "evidence"),
            ),
          ),
        ).toMatch(/NOT_EVIDENCE_HEAD/);
      });

      it("a removal of a missing id and of another CCA's id answer the same", async () => {
        const row = await seed(B, { uploadedBy: U.headB });
        const missing = "0".repeat(24);
        const other = await errorOf(as(U.headA).remove({ id: row.id }));
        const none = await errorOf(as(U.headA).remove({ id: missing }));
        expect(other).toBe(NOT_FOUND);
        expect(none).toBe(NOT_FOUND);
        expect(await rows(B)).toBe(1);
      });

      it("a guard read that fails refuses and changes nothing", async () => {
        const down = withFailingRead("ccaHead");
        const row = await seed(A);
        expect(
          await errorOf(as(U.headA, EVERYTHING, down).list({ ccaID: A })),
        ).toBe(CHECK_FAILED);
        expect(
          await errorOf(
            as(U.headA, EVERYTHING, down).record({ ccaID: A, url: put(A) }),
          ),
        ).toBe(CHECK_FAILED);
        expect(
          await errorOf(as(U.headA, EVERYTHING, down).remove({ id: row.id })),
        ).toBe(CHECK_FAILED);
        expect(
          await errorOf(
            service.authorizeEvidenceUpload(
              down,
              fake.storage,
              U.headA,
              pathOf(A, "evidence"),
            ),
          ),
        ).toBe(CHECK_FAILED);
        expect(await rows()).toBe(1);
        expect(fake.state.removed).toEqual([]);
      });
    });

    describe("viewing (authorizeEvidenceRead)", () => {
      it("a head and a director of the CCA may view; everyone else gets one refusal", async () => {
        const row = await seed(A);
        for (const who of [U.headA, U.headA2, U.dirA, U.both]) {
          expect(await reader.authorizeEvidenceRead(db, who, row.id)).toEqual({
            pathname: row.pathname,
            contentType: "image/webp",
            size: 1000,
          });
        }
        for (const who of [
          U.headB,
          U.dirB,
          U.other,
          U.jcrc,
          U.admin,
          U.scrc,
          U.resident,
        ]) {
          expect(
            await errorOf(reader.authorizeEvidenceRead(db, who, row.id)),
          ).toBe(NOT_FOUND);
        }
      });

      it("a missing id, a malformed id and another CCA's id are the same refusal", async () => {
        const row = await seed(B, { uploadedBy: U.headB });
        for (const id of [
          row.id,
          "0".repeat(24),
          "not-an-id",
          "",
          `${row.id}0`,
          "../etc/passwd",
        ]) {
          expect(
            await errorOf(reader.authorizeEvidenceRead(db, U.headA, id)),
          ).toBe(NOT_FOUND);
        }
      });

      it("a director is refused when directors.enabled is off; a head is not", async () => {
        const row = await seed(A);
        await setFlag("directors.enabled", "off");
        expect(
          await errorOf(reader.authorizeEvidenceRead(db, U.dirA, row.id)),
        ).toBe(NOT_FOUND);
        expect(
          await reader.authorizeEvidenceRead(db, U.headA, row.id),
        ).toMatchObject({ size: 1000 });
      });

      it("a director whose position ended is refused", async () => {
        const row = await seed(A);
        await db.jcrcPositionHolder.updateMany({
          where: { userID: U.dirA },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        expect(
          await errorOf(reader.authorizeEvidenceRead(db, U.dirA, row.id)),
        ).toBe(NOT_FOUND);
      });

      it("a guard read that fails refuses", async () => {
        const row = await seed(A);
        expect(
          await errorOf(
            reader.authorizeEvidenceRead(
              withFailingRead("ccaHead"),
              U.headA,
              row.id,
            ),
          ),
        ).toBe(CHECK_FAILED);
        expect(
          await errorOf(
            reader.authorizeEvidenceRead(
              withFailingRead("jcrcPositionHolder"),
              U.dirA,
              row.id,
            ),
          ),
        ).toBe(CHECK_FAILED);
      });

      it("the view budget is spent only after access is proven", async () => {
        const row = await seed(A);
        for (let i = 0; i < 3; i += 1) {
          await errorOf(reader.authorizeEvidenceRead(db, U.admin, row.id));
        }
        expect(
          await db.rateLimit.count({
            where: { key: `milestone.view:${U.admin}` },
          }),
        ).toBe(0);
        await reader.authorizeEvidenceRead(db, U.headA, row.id);
        expect(
          await db.rateLimit.count({
            where: { key: `milestone.view:${U.headA}` },
          }),
        ).toBe(1);
      });
    });

    describe("the upload check", () => {
      const authorize = (userID: string, pathname: string, now?: Date) =>
        service.authorizeEvidenceUpload(
          db,
          fake.storage,
          userID,
          pathname,
          now,
        );

      it("accepts the server's own pathname for the caller's CCA", async () => {
        expect(await authorize(U.headA, pathOf(A, "evidence"))).toEqual({
          ccaID: A,
        });
      });

      it("refuses any other name, folder or type", async () => {
        for (const path of [
          pathOf(A, "evidence-xyz"),
          pathOf(A, "evidence", "svg"),
          pathOf(A, "evidence", "gif"),
          "event/9803/evidence.webp",
          "milestone-evidence/9803/../9804/evidence.webp",
          "milestone-evidence/9803/evidence.webp?x=1",
          "milestone-evidence/9803/evidence.webp#x",
          "milestone-evidence/9803/%2e%2e/evidence.webp",
          "",
        ]) {
          expect(await errorOf(authorize(U.headA, path))).toMatch(
            /BAD_PATHNAME/,
          );
        }
      });

      it("refuses another CCA's folder even when the caller heads a different CCA", async () => {
        expect(
          await errorOf(authorize(U.headA, pathOf(B, "evidence"))),
        ).toMatch(/NOT_EVIDENCE_HEAD/);
      });

      it("refuses once the CCA holds the cap of unattached photos", async () => {
        const cap = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_MAX_UNATTACHED;
        for (let i = 0; i < cap; i += 1) await seed(A);
        expect(
          await errorOf(authorize(U.headA, pathOf(A, "evidence"))),
        ).toMatch(/EVIDENCE_TOO_MANY/);
        // Photos already attached to a submission do not count.
        await db.milestoneEvidence.updateMany({
          where: { ccaID: A },
          data: { submissionID: "sub-1" },
        });
        expect(await authorize(U.headA, pathOf(A, "evidence"))).toEqual({
          ccaID: A,
        });
      });

      it("the 41st token in an hour is rate limited", async () => {
        for (let i = 0; i < 40; i += 1) {
          await authorize(U.headA, pathOf(A, "evidence"));
        }
        expect(
          await errorOf(authorize(U.headA, pathOf(A, "evidence"))),
        ).toMatch(RATE);
      });

      it("a refused person does not spend the budget", async () => {
        for (let i = 0; i < 3; i += 1) {
          await errorOf(authorize(U.admin, pathOf(A, "evidence")));
        }
        expect(
          await db.rateLimit.count({
            where: { key: `milestone.upload:${U.admin}` },
          }),
        ).toBe(0);
      });
    });

    describe("recording an upload", () => {
      it("takes size and type from the store, never from the browser", async () => {
        const url = put(A, 12_345, "image/webp");
        const saved = await as(U.headA).record({ ccaID: A, url });
        expect(saved.size).toBe(12_345);
        const stored = await db.milestoneEvidence.findUniqueOrThrow({
          where: { id: saved.id },
        });
        expect(stored).toMatchObject({
          ccaID: A,
          pathname: pathOf(A),
          uploadedBy: U.headA,
          submissionID: null,
          contentType: "image/webp",
        });
      });

      it("refuses an address that is not exactly a file in the private store", async () => {
        put(A);
        for (const url of [
          `https://other.private.blob.vercel-storage.com/${pathOf(A)}`,
          `https://teststore.public.blob.vercel-storage.com/${pathOf(A)}`,
          `${urlOf(A)}?x=1`,
          `${urlOf(A)}#x`,
          `https://${fake.host}/milestone-evidence/${A}/../${B}/evidence-aB3dE5.webp`,
          `https://${fake.host}/milestone-evidence/${A}/a%2Fb.webp`,
          `http://${fake.host}/${pathOf(A)}`,
          `https://u:p@${fake.host}/${pathOf(A)}`,
          pathOf(A),
          "",
        ]) {
          expect(await errorOf(as(U.headA).record({ ccaID: A, url }))).toMatch(
            /BAD_REQUEST|too_small/,
          );
        }
        expect(await rows()).toBe(0);
        expect(fake.state.removed).toEqual([]);
      });

      it("refuses another CCA's folder without touching the file", async () => {
        const url = put(B);
        expect(await errorOf(as(U.headA).record({ ccaID: A, url }))).toBe(
          "BAD_REQUEST:EVIDENCE_BAD_FILE",
        );
        expect(fake.files.has(pathOf(B))).toBe(true);
        expect(fake.state.removed).toEqual([]);
        expect(await rows(A)).toBe(0);
        expect(await rows(B)).toBe(0);
      });

      it("refuses a file that is not in the store", async () => {
        expect(
          await errorOf(as(U.headA).record({ ccaID: A, url: urlOf(A) })),
        ).toBe("BAD_REQUEST:EVIDENCE_NOT_UPLOADED");
      });

      it("deletes and refuses a file with a bad type, a mismatched type or a bad size", async () => {
        const bad: Array<[number, string, string, string]> = [
          [5000, "image/svg+xml", "evidence-b1", "webp"],
          [5000, "text/html", "evidence-b2", "webp"],
          [5000, "image/png", "evidence-b3", "webp"], // type does not match the name
          [0, "image/webp", "evidence-b4", "webp"],
          [4 * 1024 * 1024 + 1, "image/webp", "evidence-b5", "webp"],
        ];
        for (const [size, type, name, ext] of bad) {
          const url = put(A, size, type, name, ext);
          expect(await errorOf(as(U.headA).record({ ccaID: A, url }))).toBe(
            "BAD_REQUEST:EVIDENCE_BAD_FILE",
          );
          expect(fake.files.has(pathOf(A, name, ext))).toBe(false);
        }
        expect(await rows()).toBe(0);
      });

      it("accepts the three allowed types at the size limit", async () => {
        const limit = 4 * 1024 * 1024;
        for (const [type, ext] of [
          ["image/webp", "webp"],
          ["image/png", "png"],
          ["image/jpeg", "jpg"],
        ] as const) {
          const url = put(A, limit, type, `evidence-ok-${ext}`, ext);
          expect(await as(U.headA).record({ ccaID: A, url })).toMatchObject({
            contentType: type,
            size: limit,
          });
        }
      });

      it("refuses a second record of the same file", async () => {
        const url = put(A);
        await as(U.headA).record({ ccaID: A, url });
        expect(await errorOf(as(U.headA2).record({ ccaID: A, url }))).toBe(
          "CONFLICT:EVIDENCE_DUPLICATE",
        );
        expect(await rows()).toBe(1);
        expect(fake.files.has(pathOf(A))).toBe(true);
      });

      it("the unique index turns a racing duplicate into the same refusal", async () => {
        const url = put(A);
        const results = await Promise.all([
          errorOf(as(U.headA).record({ ccaID: A, url })),
          errorOf(as(U.headA2).record({ ccaID: A, url })),
        ]);
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r !== "ok")).toEqual([
          "CONFLICT:EVIDENCE_DUPLICATE",
        ]);
        expect(await rows()).toBe(1);
      });

      it("at the cap, refuses and leaves the file for cleanup", async () => {
        const cap = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_MAX_UNATTACHED;
        for (let i = 0; i < cap; i += 1) await seed(A);
        const url = put(A);
        expect(await errorOf(as(U.headA).record({ ccaID: A, url }))).toBe(
          "CONFLICT:EVIDENCE_TOO_MANY",
        );
        // Not deleted: a racing record of this address may point a row at it.
        expect(fake.files.has(pathOf(A))).toBe(true);
        expect(fake.state.removed).toEqual([]);
        expect(await rows()).toBe(cap);
      });

      it("two records of one file near the cap never leave a row without its file", async () => {
        const cap = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_MAX_UNATTACHED;
        for (let i = 0; i < cap - 1; i += 1) await seed(A);
        const url = put(A);
        const results = await Promise.all([
          errorOf(as(U.headA).record({ ccaID: A, url })),
          errorOf(as(U.headA2).record({ ccaID: A, url })),
        ]);
        // One wins. The other meets the unique index or the cap, whichever
        // the timing gives; neither may delete the file the winner points at.
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(
          results.filter((r) => r !== "ok" && !/DUPLICATE|TOO_MANY/.test(r)),
        ).toEqual([]);
        expect(fake.files.has(pathOf(A))).toBe(true);
        expect(fake.state.removed).toEqual([]);
        expect(
          await db.milestoneEvidence.count({ where: { pathname: pathOf(A) } }),
        ).toBe(1);
      });

      it("a refused record at the cap can be retried once room is made", async () => {
        const cap = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_MAX_UNATTACHED;
        const first = await seed(A);
        for (let i = 1; i < cap; i += 1) await seed(A);
        const url = put(A);
        await errorOf(as(U.headA).record({ ccaID: A, url }));
        await as(U.headA).remove({ id: first.id });
        expect(await errorOf(as(U.headA).record({ ccaID: A, url }))).toBe("ok");
      });

      it("the 41st record in an hour is rate limited", async () => {
        for (let i = 0; i < 40; i += 1) {
          await errorOf(as(U.headA).record({ ccaID: A, url: urlOf(A) }));
        }
        expect(
          await errorOf(as(U.headA).record({ ccaID: A, url: urlOf(A) })),
        ).toMatch(RATE);
      });
    });

    describe("lazy cleanup", () => {
      const old = () => new Date(Date.now() - 8 * DAY_MS);

      it("clears this CCA's stale unattached photos, row first, on a later upload", async () => {
        const stale = await seed(A, { createdAt: old() });
        const fresh = await seed(A);
        const attached = await seed(A, {
          createdAt: old(),
          submissionID: "sub-1",
        });
        const otherCca = await seed(B, {
          createdAt: old(),
          uploadedBy: U.headB,
        });
        await service.authorizeEvidenceUpload(
          db,
          fake.storage,
          U.headA,
          pathOf(A, "evidence"),
        );
        expect(fake.state.removed).toEqual([stale.pathname]);
        expect(fake.files.has(stale.pathname)).toBe(false);
        const left = await db.milestoneEvidence.findMany({
          where: { ccaID: { in: [A, B] } },
          select: { id: true },
        });
        expect(left.map((r) => r.id).sort()).toEqual(
          [fresh.id, attached.id, otherCca.id].sort(),
        );
      });

      it("is bounded per call", async () => {
        const batch = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_CLEANUP_BATCH;
        for (let i = 0; i < batch + 3; i += 1) {
          await seed(A, { createdAt: old() });
        }
        const cleared = await service.cleanupStaleEvidence(db, fake.storage, A);
        expect(cleared).toBe(batch);
        expect(await rows()).toBe(3);
      });

      it("clears the oldest first", async () => {
        const oldest = await seed(A, {
          createdAt: new Date(Date.now() - 30 * DAY_MS),
        });
        const batch = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_CLEANUP_BATCH;
        for (let i = 0; i < batch; i += 1) {
          await seed(A, { createdAt: new Date(Date.now() - 9 * DAY_MS) });
        }
        await service.cleanupStaleEvidence(db, fake.storage, A);
        expect(fake.state.removed[0]).toBe(oldest.pathname);
      });

      it("a failed file delete does not block the upload: the row is gone and the file is left for the orphan sweep (#136)", async () => {
        const stale = await seed(A, { createdAt: old() });
        // The file is as old as its row, so the orphan sweep will take it.
        fake.files.set(stale.pathname, {
          size: 1000,
          contentType: "image/webp",
          uploadedAt: old(),
        });
        fake.state.removeFails = true;
        expect(
          await service.authorizeEvidenceUpload(
            db,
            fake.storage,
            U.headA,
            pathOf(A, "evidence"),
          ),
        ).toEqual({ ccaID: A });
        expect(
          await db.milestoneEvidence.findUnique({ where: { id: stale.id } }),
        ).toBeNull();
        expect(fake.files.has(stale.pathname)).toBe(true);
        // The next upload, with the store working again, removes the orphan.
        fake.state.removeFails = false;
        await service.authorizeEvidenceUpload(
          db,
          fake.storage,
          U.headA,
          pathOf(A, "evidence"),
        );
        expect(fake.files.has(stale.pathname)).toBe(false);
      });

      /** A db where the stale photo gets attached right after it was read. */
      const attachesAfterRead = (id: string): PrismaClient =>
        proxied(db, (prop) =>
          prop === "milestoneEvidence"
            ? new Proxy(db.milestoneEvidence, {
                get(t, p) {
                  const v = Reflect.get(t, p) as unknown;
                  if (p !== "findMany") {
                    return typeof v === "function"
                      ? (v as (...x: unknown[]) => unknown).bind(t)
                      : v;
                  }
                  return async (...args: unknown[]) => {
                    const found = await (
                      v as (...x: unknown[]) => Promise<unknown>
                    ).apply(t, args);
                    await db.milestoneEvidence.update({
                      where: { id },
                      data: { submissionID: "sub-raced" },
                    });
                    return found;
                  };
                },
              })
            : undefined,
        );

      it("a photo attached between the read and the delete keeps its row and its file (#136)", async () => {
        const stale = await seed(A, { createdAt: old() });
        const cleared = await service.cleanupStaleEvidence(
          attachesAfterRead(stale.id),
          fake.storage,
          A,
        );
        expect(cleared).toBe(0);
        const row = await db.milestoneEvidence.findUnique({
          where: { id: stale.id },
        });
        expect(row?.submissionID).toBe("sub-raced");
        expect(fake.files.has(stale.pathname)).toBe(true);
        expect(fake.state.removed).toEqual([]);
      });

      it("deletes the row before the file (#136)", async () => {
        const stale = await seed(A, { createdAt: old() });
        let rowGoneWhenFileRemoved: boolean | null = null;
        const spying = {
          remove: async (pathname: string) => {
            rowGoneWhenFileRemoved =
              (await db.milestoneEvidence.findUnique({
                where: { id: stale.id },
              })) === null;
            return fake.storage.remove(pathname);
          },
        };
        expect(await service.cleanupStaleEvidence(db, spying, A)).toBe(1);
        expect(rowGoneWhenFileRemoved).toBe(true);
      });

      it("a CCA full of stale photos can still upload", async () => {
        const cap = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_MAX_UNATTACHED;
        const batch = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_CLEANUP_BATCH;
        for (let i = 0; i < cap; i += 1) await seed(A, { createdAt: old() });
        expect(
          await service.authorizeEvidenceUpload(
            db,
            fake.storage,
            U.headA,
            pathOf(A, "evidence"),
          ),
        ).toEqual({ ccaID: A });
        expect(await rows()).toBe(cap - batch);
      });

      it("does not run for a person who may not upload", async () => {
        await seed(A, { createdAt: old() });
        await errorOf(
          service.authorizeEvidenceUpload(
            db,
            fake.storage,
            U.admin,
            pathOf(A, "evidence"),
          ),
        );
        expect(fake.state.removed).toEqual([]);
        expect(await rows()).toBe(1);
      });
    });

    describe("lazy cleanup of files with no row", () => {
      const old = () => new Date(Date.now() - 8 * DAY_MS);
      const orphan = (
        ccaID: number,
        name: string,
        uploadedAt: Date,
        ext = "webp",
      ) => {
        const pathname = pathOf(ccaID, name, ext);
        fake.files.set(pathname, {
          size: 1000,
          contentType: "image/webp",
          uploadedAt,
        });
        return pathname;
      };
      const upload = () =>
        service.authorizeEvidenceUpload(
          db,
          fake.storage,
          U.headA,
          pathOf(A, "evidence"),
        );

      it("removes an old file that has no row, on a later upload", async () => {
        const gone = orphan(A, "evidence-orphan1", old());
        expect(await upload()).toEqual({ ccaID: A });
        expect(fake.state.removed).toEqual([gone]);
        expect(fake.files.has(gone)).toBe(false);
        expect(fake.state.lists).toEqual([
          {
            prefix: `milestone-evidence/${A}/`,
            limit: (await import("~/lib/schemas/milestoneEvidence"))
              .EVIDENCE_ORPHAN_SCAN_MAX,
          },
        ]);
      });

      it("keeps a recent file with no row (its record may still be coming)", async () => {
        const fresh = orphan(A, "evidence-orphan2", new Date());
        const nearly = orphan(
          A,
          "evidence-orphan3",
          new Date(Date.now() - 6 * DAY_MS),
        );
        await upload();
        expect(fake.state.removed).toEqual([]);
        expect(fake.files.has(fresh)).toBe(true);
        expect(fake.files.has(nearly)).toBe(true);
      });

      it("keeps the file of any row, attached or not, however old the file", async () => {
        const unattached = await seed(A);
        const attached = await seed(A, {
          createdAt: old(),
          submissionID: "sub-1",
        });
        for (const row of [unattached, attached]) {
          fake.files.set(row.pathname, {
            size: 1000,
            contentType: "image/webp",
            uploadedAt: old(),
          });
        }
        await upload();
        expect(fake.state.removed).toEqual([]);
        expect(fake.files.has(unattached.pathname)).toBe(true);
        expect(fake.files.has(attached.pathname)).toBe(true);
        expect(await rows()).toBe(2);
      });

      it("looks only in this CCA's folder and only at our evidence names", async () => {
        const other = orphan(B, "evidence-orphan4", old());
        const odd = orphan(A, "notes", old(), "txt");
        const gone = orphan(A, "evidence-orphan5", old());
        await upload();
        expect(fake.state.removed).toEqual([gone]);
        expect(fake.files.has(other)).toBe(true);
        expect(fake.files.has(odd)).toBe(true);
      });

      it("removes at most one batch per upload", async () => {
        const batch = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_CLEANUP_BATCH;
        for (let i = 0; i < batch + 4; i += 1) {
          orphan(A, `evidence-many${i}`, old());
        }
        await upload();
        expect(fake.state.removed).toHaveLength(batch);
        expect(fake.files.size).toBe(4);
      });

      it("looks at no more files than the scan bound", async () => {
        const max = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_ORPHAN_SCAN_MAX;
        const cleared = await service.cleanupOrphanEvidence(
          db,
          {
            remove: fake.storage.remove,
            // A store that ignores the limit still cannot make it read more:
            // the first `max` files are recent, the 50 after them are old.
            listBlobs: () =>
              Promise.resolve(
                Array.from({ length: max + 50 }, (_v, i) => ({
                  pathname: pathOf(A, `evidence-bound${i}`),
                  uploadedAt: i < max ? new Date() : old(),
                })),
              ),
          },
          A,
        );
        expect(cleared).toBe(0);
        expect(fake.state.removed).toEqual([]);
      });

      it("a failed listing does not block the upload", async () => {
        const kept = orphan(A, "evidence-orphan6", old());
        fake.state.listFails = true;
        expect(await upload()).toEqual({ ccaID: A });
        expect(fake.state.removed).toEqual([]);
        expect(fake.files.has(kept)).toBe(true);
      });

      it("a failed delete leaves the file for the next upload", async () => {
        const kept = orphan(A, "evidence-orphan7", old());
        fake.state.removeFails = true;
        expect(await upload()).toEqual({ ccaID: A });
        expect(fake.files.has(kept)).toBe(true);
        fake.state.removeFails = false;
        await upload();
        expect(fake.files.has(kept)).toBe(false);
      });

      it("does not run for a person who may not upload", async () => {
        orphan(A, "evidence-orphan8", old());
        await errorOf(
          service.authorizeEvidenceUpload(
            db,
            fake.storage,
            U.admin,
            pathOf(A, "evidence"),
          ),
        );
        expect(fake.state.lists).toEqual([]);
        expect(fake.state.removed).toEqual([]);
      });

      it("a file left by a full-CCA record is swept once it is old enough", async () => {
        const cap = (await import("~/lib/schemas/milestoneEvidence"))
          .EVIDENCE_MAX_UNATTACHED;
        for (let i = 0; i < cap; i += 1) await seed(A);
        const url = put(A);
        await errorOf(as(U.headA).record({ ccaID: A, url }));
        expect(fake.files.has(pathOf(A))).toBe(true);
        await db.milestoneEvidence.deleteMany({ where: { ccaID: A } });
        fake.files.set(pathOf(A), {
          size: 5000,
          contentType: "image/webp",
          uploadedAt: old(),
        });
        await upload();
        expect(fake.files.has(pathOf(A))).toBe(false);
      });
    });

    describe("removing", () => {
      it("deletes the file first, then the row", async () => {
        const row = await seed(A);
        await as(U.headA).remove({ id: row.id });
        expect(fake.state.removed).toEqual([row.pathname]);
        expect(await rows()).toBe(0);
      });

      it("keeps the row when the store cannot delete the file (the message is sanitized)", async () => {
        const row = await seed(A);
        fake.state.removeFails = true;
        expect(await errorOf(as(U.headA).remove({ id: row.id }))).toBe(
          "INTERNAL_SERVER_ERROR:Something went wrong.",
        );
        expect(await rows()).toBe(1);
      });

      it("refuses a photo attached to a submission", async () => {
        const row = await seed(A, { submissionID: "sub-1" });
        expect(await errorOf(as(U.headA).remove({ id: row.id }))).toBe(
          "CONFLICT:EVIDENCE_ATTACHED",
        );
        expect(await rows()).toBe(1);
        expect(fake.state.removed).toEqual([]);
      });

      it("a malformed id is refused by the input check", async () => {
        expect(await errorOf(as(U.headA).remove({ id: "nope" }))).toMatch(
          /^BAD_REQUEST/,
        );
      });

      it("the list shows only unattached photos, newest first, with no address", async () => {
        const first = await seed(A, { createdAt: new Date(Date.now() - 2000) });
        const second = await seed(A, {
          createdAt: new Date(Date.now() - 1000),
        });
        await seed(A, { submissionID: "sub-1" });
        const listed = await as(U.headA).list({ ccaID: A });
        expect(listed.map((r) => r.id)).toEqual([second.id, first.id]);
        expect(JSON.stringify(listed)).not.toMatch(
          /pathname|milestone-evidence|blob\.vercel|https?:/,
        );
      });
    });

    describe("account deletion", () => {
      it("keeps the CCA's evidence and clears the uploader", async () => {
        const { loadAdminUserTarget, deleteUserAccountCascade } = await import(
          "../userAdmin"
        );
        const user = await db.user.create({
          data: { email: "e9991501@u.nus.edu", userID: U.headA },
        });
        const mine = await seed(A, { uploadedBy: U.headA });
        const theirs = await seed(A, { uploadedBy: U.headA2 });
        const result = await deleteUserAccountCascade(
          db,
          await loadAdminUserTarget(db, user.id),
          U.admin,
        );
        expect(result.deleted).toMatchObject({
          milestoneEvidenceUploaderCleared: 1,
        });
        expect(
          await db.milestoneEvidence.findUniqueOrThrow({
            where: { id: mine.id },
          }),
        ).toMatchObject({
          uploadedBy: null,
          ccaID: A,
          pathname: mine.pathname,
        });
        expect(
          await db.milestoneEvidence.findUniqueOrThrow({
            where: { id: theirs.id },
          }),
        ).toMatchObject({ uploadedBy: U.headA2 });
        expect(fake.state.removed).toEqual([]);
      });
    });
  },
);
