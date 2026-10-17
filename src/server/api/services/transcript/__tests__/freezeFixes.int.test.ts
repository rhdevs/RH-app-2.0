import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
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

/**
 * INTEGRATION TESTS of the freeze review fixes (F1, F2, F18, F19, F17, F5, F4,
 * F15) against the LOCAL development database (skipped unless DATABASE_URL is
 * localhost and the database is `rhapp_transcript_dev`; run with
 * `npm run test:db`). The seed is re-run before every test; rows a test adds
 * outside the seed's own set are removed after it.
 */

const REQUIRED_DB = "rhapp_transcript_dev";

function isLocalDevDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      ["localhost", "127.0.0.1"].includes(u.hostname) &&
      u.pathname === `/${REQUIRED_DB}`
    );
  } catch {
    return false;
  }
}

const AY = "AY2026/27";
const NEXT = "AY2027/28";

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const ADMIN = R(1, ["admin", "resident"]);
const JCRC = R(2, ["jcrc", "resident"]);
const SOCCER_HEAD = R(4, ["cca_head", "resident"]); // heads Soccer (9005)
const R09 = R(9, ["resident"]);
const R12 = R(12, ["resident"]);
const R20 = R(20, ["resident"]);
const SOCCER = 9005;
const SOCCER_MEMBERS = [
  "SEED-R04",
  "SEED-R09",
  "SEED-R12",
  "SEED-R13",
  "SEED-R18",
];
/** A CCA these tests create (and remove): not one of the seed's. */
const NEW_CCA = 9990;
const NEW_CCA_NAME = "Test Late CCA";
const GHOST = "GHOST-NO-SUCH-USER";

const MAR_2027 = new Date("2027-03-11T04:00:00Z");
const JUL_2027 = new Date("2027-07-20T04:00:00Z");
const AUG_2027 = new Date("2027-08-10T04:00:00Z");
const SEP_2027 = new Date("2027-09-10T04:00:00Z");
const NOV_2027 = new Date("2027-11-15T04:00:00Z");

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "freeze review fixes (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let freeze: typeof import("../freeze");
    let periods: typeof import("../periods");
    let loader: typeof import("../loader");
    let ipCounter = 0;

    const asOn = (
      database: PrismaClient,
      who: { id: string; roles: string[] } | null,
    ) =>
      createCaller({
        db: database,
        session: who
          ? ({
              user: {
                userID: who.id,
                roles: who.roles,
                eligible: true,
                hasMatric: true,
                credentialsStale: false,
              },
              expires: new Date(Date.now() + 3600_000).toISOString(),
            } as never)
          : null,
        headers: new Headers({
          "x-forwarded-for": `203.0.113.${(ipCounter += 1) % 250}`,
        }),
      });
    const as = (who: { id: string; roles: string[] } | null) => asOn(db, who);

    const errorOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return `${e.code}:${e.message}`;
      }
      return "ok";
    };

    const reseed = () =>
      execFileSync(process.execPath, ["scripts/dev/seed-transcript.mjs"], {
        stdio: "pipe",
      });

    /** Rows a test adds outside the seed's own CCAs and people. */
    const cleanExtras = async () => {
      await db.ccaYearFreeze.deleteMany({ where: { ccaID: NEW_CCA } });
      await db.transcriptRosterEntry.deleteMany({ where: { ccaID: NEW_CCA } });
      await db.ccaHead.deleteMany({ where: { ccaID: NEW_CCA } });
      await db.userCCA.deleteMany({
        where: { OR: [{ ccaID: NEW_CCA }, { userID: GHOST }] },
      });
      await db.cCA.deleteMany({ where: { ccaID: NEW_CCA } });
    };

    beforeAll(async () => {
      reseed();
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      freeze = await import("../freeze");
      periods = await import("../periods");
      loader = await import("../loader");
    }, 120_000);

    beforeEach(() => {
      reseed();
    }, 120_000);

    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanExtras();
    });

    afterAll(async () => {
      if (db) {
        await cleanExtras();
        reseed();
        await db.$disconnect();
      }
    }, 120_000);

    const activeFreezes = (ccaID: number) =>
      db.ccaYearFreeze.findMany({
        where: { ccaID, ...loader.NOT_UNFROZEN },
        orderBy: { academicYear: "asc" },
      });

    const frozenKeys = async (ccaID: number, academicYear: string) =>
      (
        await db.transcriptRosterEntry.findMany({
          where: { ccaID, academicYear, frozen: true },
        })
      )
        .map((e) => e.userID)
        .sort();

    const heads = async (ccaID: number) =>
      (await db.ccaHead.findMany({ where: { ccaID } }))
        .map((h) => h.userID)
        .sort();

    /**
     * A client whose freeze transaction loses a race: just before the frozen
     * roster entries are inserted, a head's save writes an entry for one of
     * those members (outside the transaction). `times` races, then none.
     */
    const racing = (times: number): PrismaClient => {
      let left = times;
      return new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "$transaction") {
            return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
              (
                target.$transaction as unknown as (
                  f: (tx: PrismaClient) => Promise<unknown>,
                  o?: unknown,
                ) => Promise<unknown>
              )(
                (tx) =>
                  fn(
                    new Proxy(tx, {
                      get(t, p, r) {
                        const model: unknown = Reflect.get(t, p, r);
                        if (p !== "transcriptRosterEntry") return model;
                        return new Proxy(model as object, {
                          get(m, mp, mr) {
                            const real: unknown = Reflect.get(m, mp, mr);
                            if (mp !== "createMany") return real;
                            return async (args: {
                              data: Array<Record<string, unknown>>;
                            }) => {
                              if (left > 0 && args.data.length > 0) {
                                left -= 1;
                                const row = args.data[0]!;
                                await target.transcriptRosterEntry.create({
                                  data: {
                                    academicYear: row.academicYear as string,
                                    userID: row.userID as string,
                                    ccaID: row.ccaID as number,
                                    extraContribution: "Saved by the head",
                                    frozen: false,
                                    updatedBy: SOCCER_HEAD.id,
                                    updatedAt: new Date(),
                                  },
                                });
                              }
                              return (
                                real as (a: unknown) => Promise<unknown>
                              ).call(m, args);
                            };
                          },
                        });
                      },
                    }) as PrismaClient,
                  ),
                opts,
              );
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as PrismaClient;
    };

    /* ---- F1: a roster save between the read and the write ---------------- */
    describe("F1: a freeze racing a head's save", () => {
      // Every Soccer member is then a NEW frozen entry, so the race can hit.
      const clearSoccerEntries = () =>
        db.transcriptRosterEntry.deleteMany({
          where: { ccaID: SOCCER, academicYear: AY },
        });

      it("runs again from a fresh read and ends frozen, keeping the head's save", async () => {
        await clearSoccerEntries();
        const result = await freeze.freezeCca(racing(1), {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
          now: MAR_2027,
        });

        expect(result).toMatchObject({ kind: "frozen", academicYear: AY });
        expect(await activeFreezes(SOCCER)).toHaveLength(1);
        expect(await frozenKeys(SOCCER, AY)).toEqual(SOCCER_MEMBERS);
        // The entry the head saved meanwhile is the one that was frozen.
        const saved = await db.transcriptRosterEntry.findMany({
          where: {
            ccaID: SOCCER,
            academicYear: AY,
            extraContribution: "Saved by the head",
          },
        });
        expect(saved).toHaveLength(1);
        expect(saved[0]!.frozen).toBe(true);
      });

      it("never reports 'unchanged' with nothing frozen: it throws, and the head change is refused", async () => {
        await clearSoccerEntries();
        const flaky = racing(10);

        await expect(
          freeze.freezeCca(flaky, {
            ccaID: SOCCER,
            reason: "handover",
            actorUserID: SOCCER_HEAD.id,
            now: MAR_2027,
          }),
        ).rejects.toSatisfy((e: unknown) => {
          // The last try lost the race again: a FREEZE_RACE, or the raw write
          // conflict or duplicate key it came from. Never a quiet "unchanged".
          const err = e as { message?: string; code?: string };
          return (
            (err.message ?? "").includes("FREEZE_RACE") ||
            ["P2002", "P2034"].includes(err.code ?? "")
          );
        });
        expect(await activeFreezes(SOCCER)).toHaveLength(0);

        await clearSoccerEntries();
        expect(
          await errorOf(
            asOn(racing(10), SOCCER_HEAD).cca.handoverHeads({
              ccaID: SOCCER,
              newHeadUserIDs: [R09.id],
            }),
          ),
        ).toBe("PRECONDITION_FAILED:TRANSCRIPT_FREEZE_FAILED");
        expect(await heads(SOCCER)).toEqual([SOCCER_HEAD.id]);
        expect(await activeFreezes(SOCCER)).toHaveLength(0);
      });
    });

    /* ---- F2: a CCA created after a year is published ---------------------- */
    describe("F2: never a published year", () => {
      const publishAY = async () => {
        const c = as(JCRC).transcript;
        await c.periods.close({ academicYear: AY });
        await c.periods.publish({ academicYear: AY });
      };
      const addNewCca = async () => {
        await db.cCA.create({
          data: {
            ccaID: NEW_CCA,
            ccaName: NEW_CCA_NAME,
            category: "Committees",
          },
        });
        await db.ccaHead.create({
          data: { userID: R12.id, ccaID: NEW_CCA, grantedAt: MAR_2027 },
        });
        await db.userCCA.create({ data: { userID: R20.id, ccaID: NEW_CCA } });
      };
      const involvement = async (userID: string, academicYear: string) =>
        (
          await as(JCRC).transcript.preview({ userID, academicYear })
        ).transcript.pages
          .flatMap((p) => (p.kind === "main" ? p.sections : []))
          .flatMap((s) =>
            s.kind === "involvements" ? s.rows.map((r) => r.ccaName) : [],
          );

      it("lets a head of a new CCA be revoked, and freezes the next unpublished year instead", async () => {
        await publishAY();
        await addNewCca();
        expect(await involvement(R20.id, AY)).not.toContain(NEW_CCA_NAME);

        // Today (AY2026/27, published): the next year is a future one, so
        // nothing is frozen and the head change goes ahead.
        await as(ADMIN).admin.revokeCcaHead({
          userID: R12.id,
          ccaID: NEW_CCA,
        });
        expect(await heads(NEW_CCA)).toEqual([]);
        expect(await activeFreezes(NEW_CCA)).toHaveLength(0);

        // In September 2027 a head change freezes AY2027/28, not AY2026/27.
        await db.ccaHead.create({
          data: { userID: R12.id, ccaID: NEW_CCA, grantedAt: MAR_2027 },
        });
        await freeze.freezeBeforeHeadChange(db, {
          ccaID: NEW_CCA,
          reason: "head_removed",
          actorUserID: ADMIN.id,
          removing: [R12.id],
          now: SEP_2027,
        });
        expect(
          (await activeFreezes(NEW_CCA)).map((f) => f.academicYear),
        ).toEqual([NEXT]);
        expect(await frozenKeys(NEW_CCA, AY)).toEqual([]);

        // The published year's transcripts are unchanged.
        expect(await involvement(R20.id, AY)).not.toContain(NEW_CCA_NAME);
      });
    });

    /* ---- F18: a late handover after Close year ---------------------------- */
    describe("F18: the late-handover rule", () => {
      it("does not freeze again after Close year until a head has changed; the next change does", async () => {
        const closed = await periods.closeYear(db, AY, ADMIN.id, JUL_2027);
        expect(closed.closed).toBe(true);
        expect((await activeFreezes(SOCCER))[0]).toMatchObject({
          academicYear: AY,
          reason: "close_year",
        });

        // 10 August 2027: the outgoing head hands over. Nothing freezes.
        await expect(
          freeze.freezeBeforeHeadChange(db, {
            ccaID: SOCCER,
            reason: "handover",
            actorUserID: SOCCER_HEAD.id,
            keepOnly: [R09.id],
            now: AUG_2027,
          }),
        ).resolves.toBeUndefined();
        expect(
          (await activeFreezes(SOCCER)).map((f) => f.academicYear),
        ).toEqual([AY]);
        // The head change itself: R09 is appointed on 10 August.
        await db.ccaHead.deleteMany({ where: { ccaID: SOCCER } });
        await db.ccaHead.create({
          data: { userID: R09.id, ccaID: SOCCER, grantedAt: AUG_2027 },
        });

        // A second handover later in AY2027/28 freezes AY2027/28.
        await freeze.freezeBeforeHeadChange(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: R09.id,
          keepOnly: [R20.id],
          now: NOV_2027,
        });
        const rows = await activeFreezes(SOCCER);
        expect(rows.map((f) => [f.academicYear, f.reason])).toEqual([
          [AY, "close_year"],
          [NEXT, "handover"],
        ]);
      });

      it("still lets a head lock the list (the rule is for head changes only)", async () => {
        await periods.closeYear(db, AY, ADMIN.id, JUL_2027);
        const locked = await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "lock",
          actorUserID: SOCCER_HEAD.id,
          now: AUG_2027,
        });
        expect(locked).toMatchObject({ kind: "frozen", academicYear: NEXT });
      });
    });

    /* ---- F19: members the resolver could not match ------------------------ */
    describe("F19: unmatched members", () => {
      it("stores and returns how many members could not be matched", async () => {
        await db.userCCA.create({ data: { userID: GHOST, ccaID: SOCCER } });
        const result = await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "lock",
          actorUserID: SOCCER_HEAD.id,
          now: MAR_2027,
        });
        expect(result).toMatchObject({ kind: "frozen", unresolvedCount: 1 });
        expect((await activeFreezes(SOCCER))[0]?.unresolvedCount).toBe(1);

        const list = await as(ADMIN).transcript.freezes.list({
          academicYear: AY,
        });
        expect(list.rows.find((r) => r.ccaID === SOCCER)?.unresolvedCount).toBe(
          1,
        );
      });

      it("adds them up in the Close year result", async () => {
        await db.userCCA.create({ data: { userID: GHOST, ccaID: SOCCER } });
        const closed = await periods.closeYear(db, AY, ADMIN.id, JUL_2027);
        expect(closed.unresolved).toBeGreaterThanOrEqual(1);
      });
    });

    /* ---- F17: what an Unfreeze would change -------------------------------- */
    describe("F17: the Unfreeze preview", () => {
      it("lists who would be dropped and who added if the CCA were frozen again", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "lock",
          actorUserID: SOCCER_HEAD.id,
          now: MAR_2027,
        });
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: R12.id },
        });
        await db.userCCA.create({ data: { userID: R20.id, ccaID: SOCCER } });

        const preview = await as(ADMIN).transcript.freezes.unfreezePreview({
          academicYear: AY,
          ccaID: SOCCER,
        });
        expect(preview.dropped.map((p) => p.userID)).toEqual([R12.id]);
        expect(preview.added.map((p) => p.userID)).toEqual([R20.id]);
        expect(preview.dropped[0]!.name).not.toBe("");

        expect(
          await errorOf(
            as(SOCCER_HEAD).transcript.freezes.unfreezePreview({
              academicYear: AY,
              ccaID: SOCCER,
            }),
          ),
        ).toMatch(/^FORBIDDEN/);
      });
    });

    /* ---- F5: why a CCA failed to freeze ------------------------------------ */
    describe("F5: failure reasons", () => {
      it("returns and logs the code of a CCA whose freeze failed", async () => {
        const logged = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        const failing = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
                (
                  target.$transaction as unknown as (
                    f: (tx: PrismaClient) => Promise<unknown>,
                    o?: unknown,
                  ) => Promise<unknown>
                )(
                  (tx) =>
                    fn(
                      new Proxy(tx, {
                        get(t, p, r) {
                          const model: unknown = Reflect.get(t, p, r);
                          if (p !== "ccaYearFreeze") return model;
                          return new Proxy(model as object, {
                            get(m, mp, mr) {
                              const real: unknown = Reflect.get(m, mp, mr);
                              if (mp !== "upsert") return real;
                              return (args: {
                                where: {
                                  academicYear_ccaID: { ccaID: number };
                                };
                              }) => {
                                if (
                                  args.where.academicYear_ccaID.ccaID === SOCCER
                                ) {
                                  throw Object.assign(new Error("boom"), {
                                    code: "P2010",
                                  });
                                }
                                return (
                                  real as (a: unknown) => Promise<unknown>
                                ).call(m, args);
                              };
                            },
                          });
                        },
                      }) as PrismaClient,
                    ),
                  opts,
                );
            }
            const value: unknown = Reflect.get(target, prop, receiver);
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as PrismaClient;

        const result = await periods.closeYear(failing, AY, ADMIN.id, JUL_2027);
        expect(result.closed).toBe(false);
        expect(result.failures).toEqual([
          { name: "Soccer (MALE)", code: "P2010" },
        ]);
        expect(result.failedNames).toEqual(["Soccer (MALE)"]);
        const lines = logged.mock.calls.map((c) => String(c[0]));
        const line = lines.find((l) => l.includes("transcript_freeze_failed"));
        expect(line).toBeDefined();
        expect(JSON.parse(line!)).toMatchObject({
          ccaID: SOCCER,
          academicYear: AY,
          code: "P2010",
        });
      });
    });

    /* ---- F4 / F15: Lock and the handover warning --------------------------- */
    describe("F4 and F15: nothing to lock, and when a handover freezes", () => {
      it("refuses a lock that would freeze nothing, and says whether a handover freezes", async () => {
        const head = as(SOCCER_HEAD).transcriptManage.roster;
        const before = await head.term({ ccaID: SOCCER });
        expect(before).toMatchObject({
          willFreezeOnHandover: true,
          handoverFreezeYear: AY,
        });

        expect(await errorOf(head.lock({ ccaID: SOCCER }))).toBe("ok");
        // Now the working year is next year: a future one, nothing to lock.
        expect(await errorOf(head.lock({ ccaID: SOCCER }))).toBe(
          "CONFLICT:NOTHING_TO_LOCK",
        );
        const after = await head.term({ ccaID: SOCCER });
        expect(after).toMatchObject({
          termAcademicYear: NEXT,
          willFreezeOnHandover: false,
          handoverFreezeYear: null,
        });
      });
    });
  },
);
