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
import { useAy2026Clock } from "./ayClock";

/**
 * INTEGRATION TESTS of the one-step year (collecting -> Open transcripts)
 * against the LOCAL development database (skipped unless DATABASE_URL is
 * localhost and the database is `rhapp_transcript_dev`; run with
 * `npm run test:db`). The seed is re-run before every test, so each starts
 * from the same baseline and head changes cannot leak.
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
/** Soccer's seeded members, before any test changes them. */
const SOCCER_MEMBERS = [
  "SEED-R04",
  "SEED-R09",
  "SEED-R12",
  "SEED-R13",
  "SEED-R18",
];

const SEP_2027 = new Date("2027-09-10T04:00:00Z");

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "the year lifecycle (local database)",
  { timeout: 120_000 },
  () => {
    useAy2026Clock();

    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let freeze: typeof import("../freeze");
    let periods: typeof import("../periods");
    let retention: typeof import("../retention");
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
          "x-forwarded-for": `203.0.113.${(ipCounter += 1)}`,
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

    beforeAll(async () => {
      reseed();
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      freeze = await import("../freeze");
      periods = await import("../periods");
      retention = await import("../retention");
      loader = await import("../loader");
    }, 120_000);

    beforeEach(() => {
      reseed();
    }, 120_000);

    afterAll(async () => {
      if (db) {
        reseed();
        await db.$disconnect();
      }
    }, 120_000);

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

    const involvementNames = (
      transcript: Awaited<
        ReturnType<ReturnType<typeof as>["transcript"]["preview"]>
      >["transcript"],
    ) =>
      transcript.pages
        .flatMap((p) => (p.kind === "main" ? p.sections : []))
        .flatMap((s) =>
          s.kind === "involvements" ? s.rows.map((r) => r.ccaName) : [],
        );

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A moment inside AY2026/27, when the year may be opened. */
    const APR_2027 = new Date("2027-04-15T04:00:00Z");
    const GHOST = "GHOST-NO-SUCH-USER";

    const lockCount = (academicYear = AY) =>
      db.ccaYearFreeze.count({
        where: { academicYear, ...loader.NOT_UNFROZEN },
      });
    const statusOf = async (academicYear = AY) =>
      (await db.transcriptPeriod.findUnique({ where: { academicYear } }))
        ?.status ?? null;
    const names = (userID: string, ay: string) =>
      as(JCRC)
        .transcript.preview({ userID, academicYear: ay })
        .then((r) => involvementNames(r.transcript));

    /* ---- (A) the removed procedures ------------------------------------- */
    describe("what is gone", () => {
      it("has no Close, Publish, Reopen, Back to collecting, Freeze remaining, Unfreeze, Lock or term", async () => {
        const { appRouter } = await import("~/server/api/root");
        const procedures = Object.keys(
          (appRouter as unknown as { _def: { procedures: object } })._def
            .procedures,
        );
        expect(procedures).toContain("transcript.periods.open");
        for (const gone of [
          "transcript.periods.close",
          "transcript.periods.publish",
          "transcript.periods.reopen",
          "transcript.periods.backToCollecting",
          "transcript.periods.freezeRemaining",
          "transcript.periods.unfrozenNames",
          "transcript.periods.unfrozenCount",
          "transcript.freezes.unfreeze",
          "transcript.freezes.unfreezePreview",
          "transcriptManage.roster.lock",
          "transcriptManage.roster.term",
        ]) {
          expect(procedures, gone).not.toContain(gone);
        }
      });
    });

    /* ---- (B) head changes never lock anything -------------------------- */
    describe("head changes", () => {
      it("a head's handover locks nothing", async () => {
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [R09.id],
        });
        expect(await heads(SOCCER)).toEqual([R09.id]);
        expect(await db.ccaYearFreeze.count()).toBe(0);
      });

      it("an admin revoke or transfer locks nothing", async () => {
        await as(ADMIN).admin.grantCcaHead({ userID: R09.id, ccaID: SOCCER });
        await as(ADMIN).admin.revokeCcaHead({
          userID: SOCCER_HEAD.id,
          ccaID: SOCCER,
        });
        await as(ADMIN).admin.transferCcaHead({
          fromUserID: R09.id,
          toUserID: R12.id,
          ccaID: SOCCER,
        });
        expect(await heads(SOCCER)).toEqual([R12.id]);
        expect(await db.ccaYearFreeze.count()).toBe(0);
      });
    });

    /* ---- (C) Open transcripts ------------------------------------------- */
    describe("Open transcripts", () => {
      it("locks every CCA's list as it is, then opens the year, recording who", async () => {
        const result = await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        const ccas = await db.cCA.count();
        expect(result).toMatchObject({
          opened: true,
          lockedNow: ccas,
          relocked: 0,
          failures: [],
        });
        expect(await lockCount()).toBe(ccas);
        const period = await db.transcriptPeriod.findUniqueOrThrow({
          where: { academicYear: AY },
        });
        expect(period).toMatchObject({
          status: "published",
          publishedBy: JCRC.id,
        });
        expect(period.publishedAt?.toISOString()).toBe(APR_2027.toISOString());
        expect(await frozenKeys(SOCCER, AY)).toEqual(SOCCER_MEMBERS);
      });

      it("is for JCRC and admin only (live roles)", async () => {
        for (const who of [SOCCER_HEAD, R12]) {
          expect(
            await errorOf(
              as(who).transcript.periods.open({ academicYear: AY }),
            ),
          ).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
        }
        // A session claiming jcrc for someone whose LIVE roles are resident.
        expect(
          await errorOf(
            as({ id: R12.id, roles: ["jcrc"] }).transcript.periods.open({
              academicYear: AY,
            }),
          ),
        ).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
        expect(await lockCount()).toBe(0);
        expect(await statusOf()).toBe("collecting");
      });

      it("never opens a future year, and never opens a year twice", async () => {
        expect(
          await errorOf(periods.openTranscripts(db, NEXT, JCRC.id, APR_2027)),
        ).toBe("PRECONDITION_FAILED:YEAR_NOT_STARTED");
        await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        expect(
          await errorOf(periods.openTranscripts(db, AY, JCRC.id, APR_2027)),
        ).toBe("CONFLICT:ALREADY_PUBLISHED");
      });

      it("refuses a past year that is still collecting, and locks nothing", async () => {
        // From 1 August the member lists are the next year's: never saved into AY.
        expect(
          await errorOf(periods.openTranscripts(db, AY, JCRC.id, SEP_2027)),
        ).toBe("PRECONDITION_FAILED:YEAR_ENDED");
        expect(await lockCount()).toBe(0);
        expect(await statusOf()).not.toBe("published");
      });

      it("refuses a past year at the procedure too, and allows the current one", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(SEP_2027);
          expect(
            await errorOf(
              as(JCRC).transcript.periods.open({ academicYear: AY }),
            ),
          ).toBe("PRECONDITION_FAILED:YEAR_ENDED");
          expect(await lockCount()).toBe(0);

          vi.setSystemTime(APR_2027);
          expect(
            await errorOf(
              as(JCRC).transcript.periods.open({ academicYear: NEXT }),
            ),
          ).toBe("PRECONDITION_FAILED:YEAR_NOT_STARTED");
          const opened = await as(JCRC).transcript.periods.open({
            academicYear: AY,
          });
          expect(opened.opened).toBe(true);
          expect(await statusOf()).toBe("published");
        } finally {
          vi.useRealTimers();
        }
      });

      /**
       * The database, except that the lock of `ccaID` fails ONCE inside its
       * transaction (at the lock record), as a network blip would.
       */
      const failingOnceFor = (ccaID: number): PrismaClient => {
        const state = { failOnce: true };
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
                          if (p !== "ccaYearFreeze") return model;
                          return new Proxy(model as object, {
                            get(m, mp, mr) {
                              const real: unknown = Reflect.get(m, mp, mr);
                              if (mp !== "upsert") {
                                return typeof real === "function"
                                  ? (real as (...a: unknown[]) => unknown).bind(
                                      m,
                                    )
                                  : real;
                              }
                              return (args: {
                                where: {
                                  academicYear_ccaID: { ccaID: number };
                                };
                              }) => {
                                if (
                                  state.failOnce &&
                                  args.where.academicYear_ccaID.ccaID === ccaID
                                ) {
                                  state.failOnce = false;
                                  throw Object.assign(
                                    new Error(`boom for ${R12.id}`),
                                    { code: "P2010" },
                                  );
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

      it("stays collecting if one CCA fails, says which and why, logs no message text, and finishes on the next run", async () => {
        const logged = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        // Soccer's lock fails once, inside its transaction.
        const failing = failingOnceFor(SOCCER);

        const first = await periods.openTranscripts(
          failing,
          AY,
          JCRC.id,
          APR_2027,
        );
        const ccas = await db.cCA.count();
        expect(first.opened).toBe(false);
        expect(first.failures).toEqual([
          { name: "Soccer (MALE)", code: "P2010" },
        ]);
        expect(first.lockedNow).toBe(ccas - 1);
        expect(await statusOf()).toBe("collecting");
        // Residents see nothing yet.
        expect(await as(R12).transcript.mine.get({ academicYear: AY })).toEqual(
          { status: "not_open", academicYear: AY },
        );

        // The log line: ccaID, year, code and error name; no message, no ids.
        const line = logged.mock.calls
          .map((c) => String(c[0]))
          .find((l) => l.includes("transcript_lock_failed"))!;
        expect(JSON.parse(line)).toEqual({
          evt: "transcript_lock_failed",
          ccaID: SOCCER,
          academicYear: AY,
          code: "P2010",
          name: "Error",
        });
        expect(line).not.toContain("boom");
        expect(line).not.toContain(R12.id);

        // Running it again locks EVERY CCA again from its current list,
        // replacing the locks of the first run, and opens the year.
        const second = await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        expect(second).toMatchObject({
          opened: true,
          lockedNow: ccas,
          relocked: ccas - 1,
          failures: [],
        });
        expect(await statusOf()).toBe("published");
      });

      it("a rerun after a part-way Open locks every CCA again, so a head's edits in between are published", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        // The head has saved nothing for themself, so the first run fills in
        // the default "Head" for them.
        await db.transcriptRosterEntry.deleteMany({
          where: { academicYear: AY, ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        // RVC Special Projects fails; Soccer is locked by the first run.
        const first = await periods.openTranscripts(
          failingOnceFor(9001),
          AY,
          JCRC.id,
          APR_2027,
        );
        expect(first.opened).toBe(false);
        expect(await frozenKeys(SOCCER, AY)).toEqual(SOCCER_MEMBERS);
        expect(
          await db.transcriptRosterEntry.findFirst({
            where: { academicYear: AY, ccaID: SOCCER, userID: SOCCER_HEAD.id },
          }),
        ).toMatchObject({ roleLabel: "Head", frozen: true });

        // Still collecting: the head keeps working on Soccer's records and list.
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: R12.id,
          roleLabel: "Captain",
          extraContribution: "Ran the Sunday drills.",
        });
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: "SEED-R13" },
        });
        await db.userCCA.create({ data: { userID: R20.id, ccaID: SOCCER } });
        // And hands over: SEED-R04 stays a member, but is no longer the head.
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [R09.id],
        });
        // The head's screen shows the live list with the saved choices only,
        // never a default the first run filled in.
        const screen = await as(
          R(9, ["cca_head", "resident"]),
        ).transcriptManage.roster.list({ ccaID: SOCCER, academicYear: AY });
        const r04 = screen.rows.find((r) => r.userID === SOCCER_HEAD.id);
        expect(r04).toMatchObject({ roleLabel: null, isHead: false });
        expect(r04?.effective.roleLabel).toBeNull();

        const second = await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        const ccas = await db.cCA.count();
        expect(second).toMatchObject({
          opened: true,
          lockedNow: ccas,
          relocked: ccas - 1,
        });

        // The published Soccer list is today's, with the head's edit in it.
        expect(await frozenKeys(SOCCER, AY)).toEqual(
          [...SOCCER_MEMBERS.filter((k) => k !== "SEED-R13"), R20.id].sort(),
        );
        const soccerRow = async (userID: string) => {
          const r = await as(JCRC).transcript.preview({
            userID,
            academicYear: AY,
          });
          return r.transcript.pages
            .flatMap((p) => (p.kind === "main" ? p.sections : []))
            .flatMap((s) => (s.kind === "involvements" ? s.rows : []))
            .find((row) => row.ccaName === "Soccer (MALE)");
        };
        expect((await soccerRow(R12.id))?.role).toBe("Captain");
        expect(await soccerRow("SEED-R13")).toBeUndefined();
        expect(await soccerRow(R20.id)).toBeDefined();
        // The old head's "Head" was the first run's default, not a choice.
        expect((await soccerRow(SOCCER_HEAD.id))?.role || null).toBeNull();
        expect((await soccerRow(R09.id))?.role).toBe("Head");
        const lock = await db.ccaYearFreeze.findFirstOrThrow({
          where: { academicYear: AY, ccaID: SOCCER },
        });
        expect(lock.memberCount).toBe(SOCCER_MEMBERS.length);
        expect(
          await db.ccaYearFreeze.count({
            where: { academicYear: AY, ccaID: SOCCER },
          }),
        ).toBe(1);
      });

      it("a head's save to a CCA this Open run already locked keeps the resolved defaults, so the published row says Head (R1)", async () => {
        // The head has saved nothing for themself: "Head" is only the default.
        await db.transcriptRosterEntry.deleteMany({
          where: { academicYear: AY, ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          academicYear: AY,
          actorUserID: JCRC.id,
          now: APR_2027,
        });
        // Still collecting: the head adds their Additional Contributions.
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: SOCCER_HEAD.id,
          extraContribution: "Booked the pitches all year.",
        });
        const entry = () =>
          db.transcriptRosterEntry.findFirstOrThrow({
            where: { academicYear: AY, ccaID: SOCCER, userID: SOCCER_HEAD.id },
          });
        // Still locked, with resolved values; the real choices kept aside.
        expect(await entry()).toMatchObject({
          frozen: true,
          roleLabel: "Head",
          roleDuration: "full",
          duration: "full",
          extraContribution: "Booked the pitches all year.",
          preFreeze: {
            roleLabel: null,
            roleDuration: null,
            duration: null,
            extraContribution: "Booked the pitches all year.",
          },
        });
        // The head's screen shows the saved choices, not the filled-in Head.
        const screen = await as(SOCCER_HEAD).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });
        expect(
          screen.rows.find((r) => r.userID === SOCCER_HEAD.id),
        ).toMatchObject({
          roleLabel: null,
          extraContribution: "Booked the pitches all year.",
        });

        // A later rerun of the lock still starts from the head's real choices.
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          academicYear: AY,
          actorUserID: JCRC.id,
          now: APR_2027,
        });
        expect((await entry()).preFreeze).toMatchObject({
          roleLabel: null,
          extraContribution: "Booked the pitches all year.",
        });

        // The run then claims the year without locking Soccer again.
        await db.transcriptPeriod.upsert({
          where: { academicYear: AY },
          create: { academicYear: AY, status: "published" },
          update: { status: "published" },
        });
        const r = await as(JCRC).transcript.preview({
          userID: SOCCER_HEAD.id,
          academicYear: AY,
        });
        const soccer = r.transcript.pages
          .flatMap((p) => (p.kind === "main" ? p.sections : []))
          .flatMap((s) => (s.kind === "involvements" ? s.rows : []))
          .find((row) => row.ccaName === "Soccer (MALE)");
        expect(soccer?.role).toBe("Head");
        expect(soccer?.extraContribution).toBe("Booked the pitches all year.");
      });

      it("reports members the roster could not match", async () => {
        await db.userCCA.create({ data: { userID: GHOST, ccaID: SOCCER } });
        try {
          const result = await periods.openTranscripts(
            db,
            AY,
            JCRC.id,
            APR_2027,
          );
          expect(result.unresolved).toBeGreaterThanOrEqual(1);
          const soccer = await db.ccaYearFreeze.findFirstOrThrow({
            where: { academicYear: AY, ccaID: SOCCER },
          });
          expect(soccer.unresolvedCount).toBe(1);
          expect(soccer.memberCount).toBe(SOCCER_MEMBERS.length);
          const list = await as(ADMIN).transcript.freezes.list({
            academicYear: AY,
          });
          expect(
            list.rows.find((r) => r.ccaID === SOCCER)?.unresolvedCount,
          ).toBe(1);
        } finally {
          await db.userCCA.deleteMany({ where: { userID: GHOST } });
        }
      });
    });

    /* ---- (D) which member list a transcript reads ------------------------ */
    describe("member lists", () => {
      it("reads the live list while collecting: a member removed is gone", async () => {
        expect(await names(R12.id, AY)).toContain("Soccer (MALE)");
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: R12.id },
        });
        expect(await names(R12.id, AY)).not.toContain("Soccer (MALE)");
      });

      it("after opening, removing a member from the live CCA does not change the published transcript", async () => {
        await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        const before = await as(R12).transcript.mine.get({ academicYear: AY });

        // The August application period clears the CCA and recruits afresh.
        await db.userCCA.deleteMany({ where: { ccaID: SOCCER } });
        await db.userCCA.create({ data: { userID: R20.id, ccaID: SOCCER } });

        const after = await as(R12).transcript.mine.get({ academicYear: AY });
        expect(after).toEqual(before);
        expect(await names(R12.id, AY)).toContain("Soccer (MALE)");
        expect(await names(R20.id, AY)).not.toContain("Soccer (MALE)");
        // The new recruit counts toward the next (collecting) year.
        expect(await names(R20.id, NEXT)).toContain("Soccer (MALE)");
      });
    });

    /* ---- (D2) a handover before Open (P6) -------------------------------- */
    describe("a handover before Open", () => {
      const soccerRole = async (userID: string) => {
        const r = await as(JCRC).transcript.preview({
          userID,
          academicYear: AY,
        });
        const row = r.transcript.pages
          .flatMap((p) => (p.kind === "main" ? p.sections : []))
          .flatMap((s) => (s.kind === "involvements" ? s.rows : []))
          .find((x) => x.ccaName === "Soccer (MALE)");
        return row ? row.role || null : "NOT LISTED";
      };
      const NEW_HEAD = R(9, ["cca_head", "resident"]);

      it("keeps an outgoing head with a saved role on the list and the transcript, and a saved role beats the Head default", async () => {
        // The outgoing head saves their own part-year role, then hands over
        // and leaves the CCA altogether.
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: SOCCER_HEAD.id,
          roleLabel: "Head",
          roleDuration: "sem1",
        });
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [R09.id],
        });
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        expect(await heads(SOCCER)).toEqual([R09.id]);

        // (b) The new head saves their own role: it beats the live "Head".
        await as(NEW_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: R09.id,
          roleLabel: "Co-captain",
          roleDuration: "sem2",
        });
        // A leaver with only an extra contribution saved is NOT kept.
        await as(NEW_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: "SEED-R13",
          extraContribution: "Kept the kit room tidy.",
        });
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: "SEED-R13" },
        });

        // While collecting: on the new head's screen, marked as kept.
        const screen = await as(NEW_HEAD).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });
        const out = screen.rows.find((r) => r.userID === SOCCER_HEAD.id);
        expect(out).toMatchObject({
          kept: true,
          isHead: false,
          roleLabel: "Head",
          roleDuration: "sem1",
        });
        expect(
          screen.rows.find((r) => r.userID === "SEED-R13"),
        ).toBeUndefined();
        expect(screen.rows.find((r) => r.userID === R09.id)).toMatchObject({
          isHead: true,
          roleLabel: "Co-captain",
        });
        // The kept person can still be edited by the new head.
        await as(NEW_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: SOCCER_HEAD.id,
          extraContribution: "Captained the first half of the season.",
        });
        expect(await soccerRole(SOCCER_HEAD.id)).toBe("Head (Sem 1)");
        expect(await soccerRole("SEED-R13")).toBe("NOT LISTED");

        // Open transcripts keeps them, exactly as the screen showed.
        const result = await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        expect(result.opened).toBe(true);
        expect(await frozenKeys(SOCCER, AY)).toContain(SOCCER_HEAD.id);
        expect(await frozenKeys(SOCCER, AY)).not.toContain("SEED-R13");
        expect(await soccerRole(SOCCER_HEAD.id)).toBe("Head (Sem 1)");
        expect(await soccerRole(R09.id)).toBe("Co-captain (Sem 2)");
      });

      it("keeps an outgoing head who saved only Semester 1 as Head (Semester 1) (S1)", async () => {
        // Clear the seeded "Captain", then save only the role period.
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: SOCCER_HEAD.id,
          roleLabel: null,
          roleDuration: null,
        });
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: SOCCER_HEAD.id,
          roleDuration: "sem1",
        });
        // Hands over and leaves the CCA altogether.
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [R09.id],
        });
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        await db.ccaHead.deleteMany({
          where: { ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        expect(await heads(SOCCER)).toEqual([R09.id]);

        const result = await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        expect(result.opened).toBe(true);
        expect(await frozenKeys(SOCCER, AY)).toContain(SOCCER_HEAD.id);
        expect(await soccerRole(SOCCER_HEAD.id)).toBe("Head (Sem 1)");
      });

      it("drops a leaver once their saved role and semester are cleared", async () => {
        await db.userCCA.deleteMany({
          where: { ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        await db.ccaHead.deleteMany({
          where: { ccaID: SOCCER, userID: SOCCER_HEAD.id },
        });
        // Seeded: SEED-R04 saved "Captain" for Soccer, so they are kept.
        expect(await soccerRole(SOCCER_HEAD.id)).toBe("Captain");
        await as(ADMIN).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: SOCCER_HEAD.id,
          roleLabel: null,
          roleDuration: null,
          duration: null,
        });
        expect(await soccerRole(SOCCER_HEAD.id)).toBe("NOT LISTED");
        await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        expect(await frozenKeys(SOCCER, AY)).not.toContain(SOCCER_HEAD.id);
      });
    });

    /* ---- (D3) an Open that lands during a head's save (P9) --------------- */
    describe("an Open that lands between a head's check and their write", () => {
      /**
       * The database, except that the year is opened (published) right before
       * every transaction starts: after the guard passed, before the write.
       */
      const openingDuring = (): PrismaClient =>
        new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return async (fn: unknown, opts?: unknown) => {
                await db.transcriptPeriod.upsert({
                  where: { academicYear: AY },
                  create: { academicYear: AY, status: "published" },
                  update: { status: "published" },
                });
                return (
                  target.$transaction as unknown as (
                    f: unknown,
                    o?: unknown,
                  ) => Promise<unknown>
                )(fn, opts);
              };
            }
            const value: unknown = Reflect.get(target, prop, receiver);
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as PrismaClient;
      const backToCollecting = () =>
        db.transcriptPeriod.update({
          where: { academicYear: AY },
          data: { status: "collecting" },
        });

      it("writes nothing: the roster, activity participants and volunteer people all refuse", async () => {
        const roster = await import("../manageRoster");
        const activities = await import("../activities");
        const volunteer = await import("../manageVolunteer");

        expect(
          await errorOf(
            roster.rosterUpsert(openingDuring(), SOCCER_HEAD.id, {
              ccaID: SOCCER,
              academicYear: AY,
              userID: R12.id,
              extraContribution: "Saved too late.",
            }),
          ),
        ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
        const entry = await db.transcriptRosterEntry.findFirst({
          where: { academicYear: AY, ccaID: SOCCER, userID: R12.id },
        });
        expect(entry?.extraContribution ?? null).not.toBe("Saved too late.");
        await backToCollecting();

        const league = await db.ccaActivity.findFirstOrThrow({
          where: {
            ccaID: SOCCER,
            academicYear: AY,
            title: "Inter-hall league",
          },
        });
        const before = await db.ccaActivityParticipant.count({
          where: { activityID: league.id },
        });
        expect(
          await errorOf(
            activities.participantsSet(openingDuring(), SOCCER_HEAD.id, {
              id: league.id,
              ccaID: SOCCER,
              participants: [{ userID: R20.id, role: "", description: "" }],
            }),
          ),
        ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
        expect(
          await db.ccaActivityParticipant.count({
            where: { activityID: league.id },
          }),
        ).toBe(before);
        await backToCollecting();

        const tuition = await db.volunteerActivity.findFirstOrThrow({
          where: {
            ccaID: 9002,
            academicYear: AY,
            title: { startsWith: "Weekly tuition" },
          },
        });
        const people = await db.volunteerPerson.count({
          where: { activityID: tuition.id },
        });
        expect(
          await errorOf(
            volunteer.volunteerPeopleSet(openingDuring(), "SEED-R06", {
              activityID: tuition.id,
              ccaID: 9002,
              userIDs: [R20.id],
            }),
          ),
        ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
        expect(
          await db.volunteerPerson.count({ where: { activityID: tuition.id } }),
        ).toBe(people);
      });

      it("every other year-scoped write refuses too: activities, volunteer activities and sessions, JCRC pages and awards (R5)", async () => {
        const activities = await import("../activities");
        const volunteer = await import("../manageVolunteer");
        const records = await import("../manageRecords");
        const awards = await import("../manageAwards");
        const refused = "PRECONDITION_FAILED:PERIOD_PUBLISHED";

        const league = await db.ccaActivity.findFirstOrThrow({
          where: {
            ccaID: SOCCER,
            academicYear: AY,
            title: "Inter-hall league",
          },
        });
        const tuition = await db.volunteerActivity.findFirstOrThrow({
          where: {
            ccaID: 9002,
            academicYear: AY,
            title: { startsWith: "Weekly tuition" },
          },
        });
        const session = await db.volunteerSession.findFirstOrThrow({
          where: { activityID: tuition.id, ...loader.NOT_REMOVED },
        });
        const awardType = await db.awardType.findFirstOrThrow({
          where: { name: "Service Excellence Award" },
        });
        const snapshot = async () => ({
          activities: await db.ccaActivity.findMany({
            where: { ccaID: SOCCER, academicYear: AY },
            orderBy: { id: "asc" },
          }),
          volunteer: await db.volunteerActivity.findMany({
            where: { ccaID: 9002, academicYear: AY },
            orderBy: { id: "asc" },
          }),
          sessions: await db.volunteerSession.findMany({
            where: { activityID: tuition.id },
            orderBy: { id: "asc" },
          }),
          jcrc: await db.jcrcService.findMany({
            where: { academicYear: AY, userID: JCRC.id },
          }),
          awards: await db.award.findMany({
            where: { academicYear: AY, userID: R20.id },
          }),
        });
        const before = await snapshot();

        const writes: Array<[string, () => Promise<unknown>]> = [
          [
            "activity create",
            () =>
              activities.activityCreate(openingDuring(), SOCCER_HEAD.id, {
                ccaID: SOCCER,
                academicYear: AY,
                title: "Saved too late",
                description: "",
                period: "full",
              }),
          ],
          [
            "activity update",
            () =>
              activities.activityUpdate(openingDuring(), SOCCER_HEAD.id, {
                id: league.id,
                ccaID: SOCCER,
                title: "Saved too late",
                description: "",
                period: "full",
              }),
          ],
          [
            "activity remove",
            () =>
              activities.activityRemove(
                openingDuring(),
                SOCCER_HEAD.id,
                league.id,
                SOCCER,
              ),
          ],
          [
            "volunteer activity create",
            () =>
              volunteer.volunteerActivityCreate(openingDuring(), "SEED-R06", {
                ccaID: 9002,
                academicYear: AY,
                title: "Saved too late",
                kind: "regular",
                description: "",
              }),
          ],
          [
            "volunteer activity remove",
            () =>
              volunteer.volunteerActivityRemove(
                openingDuring(),
                "SEED-R06",
                tuition.id,
                9002,
              ),
          ],
          [
            "volunteer session add",
            () =>
              volunteer.volunteerSessionAdd(openingDuring(), "SEED-R06", {
                activityID: tuition.id,
                ccaID: 9002,
                hours: 2,
              }),
          ],
          [
            "volunteer session update",
            () =>
              volunteer.volunteerSessionUpdate(openingDuring(), "SEED-R06", {
                sessionID: session.id,
                ccaID: 9002,
                hours: 7,
              }),
          ],
          [
            "volunteer session remove",
            () =>
              volunteer.volunteerSessionRemove(
                openingDuring(),
                "SEED-R06",
                session.id,
                9002,
              ),
          ],
          [
            "JCRC page save",
            () =>
              records.jcrcSave(openingDuring(), JCRC.id, JCRC.id, {
                academicYear: AY,
                portfolio: "Saved too late",
                position: "",
                description: "",
                contributions: [],
                testimonial: "",
              }),
          ],
          [
            "award assign",
            () =>
              awards.awardsAssign(openingDuring(), JCRC.id, {
                academicYear: AY,
                awardTypeID: awardType.id,
                recipients: [{ userID: R20.id, citation: "" }],
              }),
          ],
        ];
        for (const [what, write] of writes) {
          expect(await errorOf(write()), what).toBe(refused);
          await backToCollecting();
        }
        expect(await snapshot()).toEqual(before);
      });
    });

    /* ---- (E) who may edit -------------------------------------------------- */
    describe("edit rights", () => {
      const editAs = (
        who: { id: string; roles: string[] },
        academicYear = AY,
      ) =>
        errorOf(
          as(who).transcriptManage.roster.upsert({
            ccaID: SOCCER,
            academicYear,
            userID: R12.id,
            extraContribution: "Kept the kit room tidy.",
          }),
        );

      it("lets the current head edit the current year, and a new head after a handover", async () => {
        expect(await editAs(SOCCER_HEAD)).toBe("ok");
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [R09.id],
        });
        expect(await editAs(R(9, ["cca_head", "resident"]))).toBe("ok");
        // The old head is not a head any more.
        expect(await editAs(SOCCER_HEAD)).toBe(
          "FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA",
        );
      });

      it("keeps other years read-only for heads, but not for managers", async () => {
        expect(await editAs(SOCCER_HEAD, "AY2025/26")).toBe(
          "FORBIDDEN:NOT_THE_TERM_YEAR",
        );
        expect(await editAs(SOCCER_HEAD, NEXT)).toBe(
          "FORBIDDEN:NOT_THE_TERM_YEAR",
        );
        expect(await editAs(ADMIN, NEXT)).toBe("ok");
      });

      it("refuses everyone but a per-resident correction once transcripts are open", async () => {
        await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        expect(await editAs(SOCCER_HEAD)).toBe(
          "PRECONDITION_FAILED:PERIOD_PUBLISHED",
        );
        expect(await editAs(JCRC)).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");

        await as(JCRC).transcriptManage.corrections.unlock({
          userID: R12.id,
          academicYear: AY,
          reason: "Wrong contribution on file",
        });
        expect(await editAs(JCRC)).toBe("ok");
        expect(await editAs(SOCCER_HEAD)).toBe(
          "PRECONDITION_FAILED:PERIOD_PUBLISHED",
        );
      });
    });

    /* ---- what a resident sees -------------------------------------------- */
    describe("what a resident sees", () => {
      it("sees nothing while collecting, and the transcript (no draft) once open", async () => {
        expect(await as(R12).transcript.mine.get({ academicYear: AY })).toEqual(
          {
            status: "not_open",
            academicYear: AY,
          },
        );
        expect(await as(R12).transcript.mine.years()).toEqual([]);

        await periods.openTranscripts(db, AY, JCRC.id, APR_2027);
        const open = await as(R12).transcript.mine.get({ academicYear: AY });
        expect(open.status).toBe("ready");
        expect(open).not.toHaveProperty("draft");
        if (open.status === "ready") {
          expect(open.transcript).not.toHaveProperty("isDraft");
        }
        expect(await as(R12).transcript.mine.years()).toEqual([AY]);
      });
    });

    /* ---- Open transcripts: races, odd rows and dates ------------------- */
    describe("Open transcripts: edge cases", () => {
      const NEW_CCA = 99001;

      it("two opens at once with no period row both succeed, and the year is opened once (F28)", async () => {
        await db.transcriptPeriod.deleteMany({ where: { academicYear: AY } });

        const results = await Promise.all([
          periods.openTranscripts(db, AY, JCRC.id, APR_2027),
          periods.openTranscripts(db, AY, ADMIN.id, APR_2027),
        ]);

        expect(results.map((r) => r.opened)).toEqual([true, true]);
        const rows = await db.transcriptPeriod.findMany({
          where: { academicYear: AY },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: "published" });
        expect(rows[0]!.publishedAt).not.toBeNull();
        expect([JCRC.id, ADMIN.id]).toContain(rows[0]!.publishedBy);
        expect(await lockCount()).toBe(await db.cCA.count());
      });

      it("locks a CCA created while the first pass was running before it opens (F29)", async () => {
        let created = false;
        const racing = new Proxy(db, {
          get(target, prop) {
            const value: unknown = Reflect.get(target, prop, target);
            if (prop !== "cCA") {
              return typeof value === "function"
                ? (value as (...a: unknown[]) => unknown).bind(target)
                : value;
            }
            return new Proxy(value as object, {
              get(model, modelProp) {
                const real: unknown = Reflect.get(model, modelProp, model);
                if (modelProp !== "findMany") {
                  return typeof real === "function"
                    ? (real as (...a: unknown[]) => unknown).bind(model)
                    : real;
                }
                return async (...args: unknown[]) => {
                  const rows = await (
                    real as (...a: unknown[]) => Promise<unknown>
                  ).apply(model, args);
                  if (!created) {
                    // A new CCA appears just after the first list was read.
                    created = true;
                    await target.cCA.create({
                      data: {
                        ccaID: NEW_CCA,
                        ccaName: "Late CCA",
                        category: "Test",
                      },
                    });
                  }
                  return rows;
                };
              },
            });
          },
        }) as PrismaClient;

        try {
          const result = await periods.openTranscripts(
            racing,
            AY,
            JCRC.id,
            APR_2027,
          );

          expect(result.opened).toBe(true);
          const late = await db.ccaYearFreeze.findFirst({
            where: { academicYear: AY, ccaID: NEW_CCA },
          });
          expect(late).not.toBeNull();
          expect(result.lockedNow).toBe(await db.cCA.count());
          expect(await statusOf()).toBe("published");
        } finally {
          await db.ccaYearFreeze.deleteMany({ where: { ccaID: NEW_CCA } });
          await db.transcriptRosterEntry.deleteMany({
            where: { ccaID: NEW_CCA },
          });
          await db.cCA.deleteMany({ where: { ccaID: NEW_CCA } });
        }
      });

      it("opens a year whose row still says 'closed' (F31)", async () => {
        await db.transcriptPeriod.update({
          where: { academicYear: AY },
          data: { status: "closed" },
        });

        const result = await periods.openTranscripts(db, AY, JCRC.id, APR_2027);

        expect(result.opened).toBe(true);
        expect(await statusOf()).toBe("published");
        // Residents see it now.
        expect(
          (await as(R12).transcript.mine.get({ academicYear: AY })).status,
        ).toBe("ready");
      });

      it("refuses a year before transcripts began, to open it or to set its download-by date (F32)", async () => {
        expect(
          await errorOf(
            as(JCRC).transcript.periods.open({ academicYear: "AY2025/26" }),
          ),
        ).toBe("BAD_REQUEST:YEAR_BEFORE_START");
        expect(
          await errorOf(
            as(JCRC).transcript.periods.setDownloadBy({
              academicYear: "AY2025/26",
              downloadBy: "2026-06-01",
            }),
          ),
        ).toBe("BAD_REQUEST:YEAR_BEFORE_START");
        expect(
          await db.transcriptPeriod.count({
            where: { academicYear: "AY2025/26" },
          }),
        ).toBe(0);
      });

      it("saves everyone as a full year unless a semester was chosen by hand, with no dates set (S)", async () => {
        await db.transcriptPeriod.update({
          where: { academicYear: AY },
          data: { downloadBy: null },
        });
        // A late join and a late head grant must not matter.
        await db.ccaApplication.updateMany({
          where: { userID: { startsWith: "SEED-" } },
          data: { decidedAt: new Date("2027-03-20T00:00:00Z") },
        });
        await db.ccaHead.updateMany({
          where: { userID: { startsWith: "SEED-" } },
          data: { grantedAt: new Date("2027-03-20T00:00:00Z") },
        });
        const before = await db.transcriptRosterEntry.findMany({
          where: { academicYear: AY },
        });
        const chosen = before.filter(
          (e) => e.duration === "sem1" || e.duration === "sem2",
        );
        expect(chosen.length).toBeGreaterThan(0);

        await periods.openTranscripts(db, AY, JCRC.id, APR_2027);

        const locked = await db.transcriptRosterEntry.findMany({
          where: { academicYear: AY, frozen: true },
        });
        const notFull = locked.filter((e) => e.duration !== "full");
        expect(
          notFull.map((e) => `${e.userID}|${e.ccaID}|${e.duration}`).sort(),
        ).toEqual(
          chosen.map((e) => `${e.userID}|${e.ccaID}|${e.duration}`).sort(),
        );
        // A head whose role period nobody chose holds the role for the full year.
        const chosenRole = new Map(
          before
            .filter((e) => e.roleDuration)
            .map((e) => [`${e.userID}|${e.ccaID}`, e.roleDuration]),
        );
        const heads = locked.filter((e) => e.roleLabel === "Head");
        expect(heads.length).toBeGreaterThan(0);
        for (const h of heads) {
          const picked = chosenRole.get(`${h.userID}|${h.ccaID}`);
          expect(h.roleDuration).toBe(picked ?? "full");
        }
      });
    });

    /* ---- (i) retention --------------------------------------------------- */
    describe("purging a year", () => {
      it("takes the year out of 'published' first, so an interrupted purge never leaves an open year half deleted (F42)", async () => {
        await db.transcriptPeriod.create({
          data: {
            academicYear: OLD,
            status: "published",
            publishedBy: JCRC.id,
          },
        });
        await db.residentEvent.createMany({
          data: [1, 2, 3].map((i) => ({
            academicYear: OLD,
            userID: `HALF-${i}`,
            action: "correction",
            actor: JCRC.id,
            at: new Date("2026-06-01T00:00:00Z"),
          })),
        });
        // The purge stops right after its first data collection.
        let deletes = 0;
        const flaky = new Proxy(db, {
          get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (
              value &&
              typeof value === "object" &&
              "deleteMany" in (value as object)
            ) {
              return new Proxy(value as object, {
                get(m, p) {
                  if (p === "deleteMany") {
                    return (...args: unknown[]) => {
                      deletes += 1;
                      if (deletes === 2) {
                        return Promise.reject(new Error("went away"));
                      }
                      return (
                        m as unknown as Record<
                          string,
                          (...a: unknown[]) => Promise<unknown>
                        >
                      ).deleteMany!(...args);
                    };
                  }
                  const v: unknown = Reflect.get(m, p, m);
                  return typeof v === "function"
                    ? (v as (...a: unknown[]) => unknown).bind(m)
                    : v;
                },
              });
            }
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as PrismaClient;

        await expect(retention.purgeAcademicYear(flaky, OLD)).rejects.toThrow(
          "went away",
        );

        const half = await db.transcriptPeriod.findFirstOrThrow({
          where: { academicYear: OLD },
        });
        expect(half.status).toBe("collecting");
        expect(await as(R12).transcript.mine.years()).not.toContain(OLD);

        // Run it again: it finishes, and nothing of that year is left.
        await retention.purgeAcademicYear(db, OLD);
        expect(
          await db.transcriptPeriod.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(
          await db.residentEvent.count({ where: { academicYear: OLD } }),
        ).toBe(0);
      }, 120_000);

      it("purges a few thousand rows of one year, leaves other years alone, and is safe to run again (F24)", async () => {
        const at = new Date("2026-06-01T00:00:00Z");
        const rows = (academicYear: string, n: number) =>
          Array.from({ length: n }, (_, i) => ({
            academicYear,
            userID: `PURGE-${i}`,
            action: "correction",
            summary: "bulk row",
            actor: JCRC.id,
            at,
          }));
        await db.residentEvent.createMany({ data: rows(OLD, 3000) });
        await db.residentEvent.createMany({ data: rows("AY2024/25", 50) });
        await db.transcriptPeriod.create({
          data: { academicYear: OLD, status: "published" },
        });
        const otherBefore = await db.residentEvent.count({
          where: { academicYear: AY },
        });

        const started = Date.now();
        const purged = await retention.purgeAcademicYear(db, OLD);

        expect(Date.now() - started).toBeLessThan(60_000);
        expect(purged.ResidentEvent).toBe(3000);
        expect(purged.TranscriptPeriod).toBe(1);
        expect(
          await db.residentEvent.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(
          await db.residentEvent.count({
            where: { academicYear: "AY2024/25" },
          }),
        ).toBe(50);
        expect(
          await db.residentEvent.count({ where: { academicYear: AY } }),
        ).toBe(otherBefore);
        // Run again: nothing left, nothing fails.
        const again = await retention.purgeAcademicYear(db, OLD);
        expect(Object.values(again).every((n) => n === 0)).toBe(true);
        await db.residentEvent.deleteMany({
          where: { academicYear: "AY2024/25" },
        });
      }, 180_000);

      const OLD = "AY2025/26";

      const counts = async (ay: string) => {
        const out: Record<string, number> = {};
        for (const name of retention.TRANSCRIPT_COLLECTIONS) {
          const delegate = (
            {
              TranscriptPeriod: db.transcriptPeriod,
              TranscriptRosterEntry: db.transcriptRosterEntry,
              VolunteerActivity: db.volunteerActivity,
              VolunteerSession: db.volunteerSession,
              VolunteerPerson: db.volunteerPerson,
              VolunteerAttendance: db.volunteerAttendance,
              Award: db.award,
              AwardImportBatch: db.awardImportBatch,
              JcrcService: db.jcrcService,
              TranscriptAccess: db.transcriptAccess,
              CcaYearFreeze: db.ccaYearFreeze,
              CcaActivity: db.ccaActivity,
              CcaActivityParticipant: db.ccaActivityParticipant,
              ResidentUnlock: db.residentUnlock,
              ResidentWithhold: db.residentWithhold,
              ManualMembership: db.manualMembership,
              ResidentEvent: db.residentEvent,
            } as Record<string, { count: (a: object) => Promise<number> }>
          )[name]!;
          out[name] = await delegate.count({ where: { academicYear: ay } });
        }
        return out;
      };

      /** A copy of every AY2026/27 row of every collection, filed under AY2025/26. */
      const copyYear = async () => {
        const strip = <T extends { id: string }>(rows: T[]) =>
          rows.map(({ id: _id, ...rest }) => ({ ...rest, academicYear: OLD }));
        const where = { academicYear: AY };
        await db.transcriptPeriod.create({
          data: {
            academicYear: OLD,
            status: "published",
          },
        });
        await db.transcriptRosterEntry.createMany({
          data: strip(
            await db.transcriptRosterEntry.findMany({ where }),
          ) as never,
        });
        // Volunteer rows point at each other, so each activity is copied with
        // its sessions, people and ticks under the new ids.
        for (const activity of await db.volunteerActivity.findMany({ where })) {
          const { id, ...rest } = activity;
          const copy = await db.volunteerActivity.create({
            data: { ...rest, academicYear: OLD } as never,
          });
          const sessionIds = new Map<string, string>();
          for (const session of await db.volunteerSession.findMany({
            where: { activityID: id },
          })) {
            const { id: sid, ...sr } = session;
            const made = await db.volunteerSession.create({
              data: { ...sr, activityID: copy.id, academicYear: OLD } as never,
            });
            sessionIds.set(sid, made.id);
          }
          await db.volunteerPerson.createMany({
            data: (
              await db.volunteerPerson.findMany({ where: { activityID: id } })
            ).map(({ id: _id, ...pr }) => ({
              ...pr,
              activityID: copy.id,
              academicYear: OLD,
            })) as never,
          });
          await db.volunteerAttendance.createMany({
            data: (
              await db.volunteerAttendance.findMany({
                where: { activityID: id },
              })
            ).map(({ id: _id, ...ar }) => ({
              ...ar,
              activityID: copy.id,
              sessionID: sessionIds.get(ar.sessionID)!,
              academicYear: OLD,
            })) as never,
          });
        }
        await db.award.createMany({
          data: strip(await db.award.findMany({ where })).map((a) => ({
            ...a,
            // The unique key carries the year: file the copy under the old one.
            activeKey: a.activeKey.replace(AY, OLD),
          })) as never,
        });
        await db.awardImportBatch.createMany({
          data: strip(await db.awardImportBatch.findMany({ where })) as never,
        });
        await db.jcrcService.createMany({
          data: strip(await db.jcrcService.findMany({ where })) as never,
        });
        await db.transcriptAccess.create({
          data: { academicYear: OLD, userID: R12.id },
        });
        await db.ccaYearFreeze.createMany({
          data: strip(await db.ccaYearFreeze.findMany({ where })) as never,
        });
        // The per-resident records have no counterpart to copy: file one of each.
        await db.residentUnlock.create({
          data: {
            academicYear: OLD,
            userID: R12.id,
            reason: "test",
            activeKey: `${OLD}|${R12.id}`,
          },
        });
        await db.residentWithhold.create({
          data: {
            academicYear: OLD,
            userID: R12.id,
            reason: "test",
            activeKey: `${OLD}|${R12.id}`,
          },
        });
        await db.manualMembership.create({
          data: { academicYear: OLD, userID: R12.id, ccaID: 1 },
        });
        await db.residentEvent.create({
          data: { academicYear: OLD, userID: R12.id, action: "unlock" },
        });
        // A participant belongs to one activity, so each activity is copied
        // first and its people follow it under the new id.
        for (const activity of await db.ccaActivity.findMany({ where })) {
          const { id, ...rest } = activity;
          const copy = await db.ccaActivity.create({
            data: { ...rest, academicYear: OLD } as never,
          });
          const people = await db.ccaActivityParticipant.findMany({
            where: { activityID: id },
          });
          await db.ccaActivityParticipant.createMany({
            data: people.map(({ id: _id, ...person }) => ({
              ...person,
              activityID: copy.id,
              academicYear: OLD,
            })) as never,
          });
        }
      };

      it("counts without deleting on a dry run, then removes only that year", async () => {
        // A saved list for the year, so every collection has rows to copy.
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          academicYear: AY,
          actorUserID: JCRC.id,
        });
        await copyYear();
        const keep = await counts(AY);
        const old = await counts(OLD);
        for (const [name, n] of Object.entries(old)) {
          expect(n, name).toBeGreaterThan(0);
        }

        const dry = await retention.purgeAcademicYear(db, OLD, {
          dryRun: true,
        });
        expect(dry).toEqual(old);
        expect(await counts(OLD)).toEqual(old);

        const purged = await retention.purgeAcademicYear(db, OLD);
        expect(purged).toEqual(old);
        for (const n of Object.values(await counts(OLD))) expect(n).toBe(0);
        expect(await counts(AY)).toEqual(keep);
      });

      it("refuses something that is not an academic year, and deletes nothing", async () => {
        const before = await counts(AY);

        await expect(retention.purgeAcademicYear(db, "2026")).rejects.toThrow();

        expect(await counts(AY)).toEqual(before);
      });
    });
  },
);
