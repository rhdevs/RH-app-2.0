import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * INTEGRATION TESTS of the year lifecycle against the LOCAL development
 * database (skipped unless DATABASE_URL is localhost and the database is
 * `rhapp_transcript_dev`; run with `npm run test:db`). Services take an
 * injectable `now`, so the handover scenarios move through the calendar. The
 * seed is re-run before every test, so each starts from the same baseline and
 * head changes cannot leak.
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

const MAR_2027 = new Date("2027-03-11T04:00:00Z");
const MAY_2027 = new Date("2027-05-20T04:00:00Z");
const SEP_2027 = new Date("2027-09-10T04:00:00Z");

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "the year lifecycle (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let freeze: typeof import("../freeze");
    let retention: typeof import("../retention");
    let rosterSvc: typeof import("../manageRoster");
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
      retention = await import("../retention");
      rosterSvc = await import("../manageRoster");
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

    /* ---- (a) a March handover ------------------------------------------ */
    describe("a handover in March", () => {
      it("freezes this year's members, so clearing and re-recruiting changes next year only", async () => {
        const result = await freeze.freezeBeforeHeadChange(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
          keepOnly: ["SEED-R09"],
          now: MAR_2027,
        });
        expect(result).toBeUndefined();

        const [f] = await activeFreezes(SOCCER);
        expect(f).toMatchObject({
          academicYear: AY,
          reason: "handover",
          frozenBy: SOCCER_HEAD.id,
          memberCount: SOCCER_MEMBERS.length,
        });
        expect(await frozenKeys(SOCCER, AY)).toEqual(SOCCER_MEMBERS);

        // The new heads clear the CCA and recruit afresh.
        await db.userCCA.deleteMany({ where: { ccaID: SOCCER } });
        await db.userCCA.create({ data: { userID: R20.id, ccaID: SOCCER } });

        // AY2026/27 still lists the old members.
        const old = await rosterSvc.rosterList(db, SOCCER, AY, MAR_2027);
        expect(old.mode).toBe("frozen");
        expect(old.rows.map((r) => r.userID).sort()).toEqual(SOCCER_MEMBERS);
        expect(old.freeze).toMatchObject({ reason: "handover" });
        expect(old.termAcademicYear).toBe(NEXT);

        // The new members count toward the next year, even before 1 August.
        const next = await rosterSvc.rosterList(db, SOCCER, NEXT, MAR_2027);
        expect(next.mode).toBe("live");
        // the head is a member too (a head change that keeps them leaves them in)
        expect(next.rows.map((r) => r.userID).sort()).toEqual(
          [R20.id, SOCCER_HEAD.id].sort(),
        );

        // ...and the transcripts say the same.
        const names = (userID: string, ay: string) =>
          as(JCRC)
            .transcript.preview({ userID, academicYear: ay })
            .then((r) => involvementNames(r.transcript));
        expect(await names(R12.id, AY)).toContain("Soccer (MALE)");
        expect(await names(R20.id, AY)).not.toContain("Soccer (MALE)");
        expect(await names(R20.id, NEXT)).toContain("Soccer (MALE)");
        expect(await names(R12.id, NEXT)).not.toContain("Soccer (MALE)");
      });
    });

    /* ---- (b) a September handover -------------------------------------- */
    describe("a handover in September", () => {
      it("freezes the oldest unfrozen year (AY2026/27), not the current one", async () => {
        await freeze.freezeBeforeHeadChange(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
          keepOnly: ["SEED-R09"],
          now: SEP_2027,
        });

        const rows = await activeFreezes(SOCCER);
        expect(rows.map((r) => r.academicYear)).toEqual([AY]);
        expect(await frozenKeys(SOCCER, AY)).toEqual(SOCCER_MEMBERS);
        expect(await frozenKeys(SOCCER, NEXT)).toEqual([]);
      });
    });

    /* ---- (c) a second handover ----------------------------------------- */
    describe("a second change after the freeze", () => {
      it("is skipped, and does not block the head change", async () => {
        const first = await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
          now: MAR_2027,
        });
        expect(first).toMatchObject({ kind: "frozen", academicYear: AY });

        const second = await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
          now: MAY_2027,
        });
        expect(second).toEqual({
          kind: "skipped",
          reason: "already_frozen_for_current_year",
        });

        await expect(
          freeze.freezeBeforeHeadChange(db, {
            ccaID: SOCCER,
            reason: "handover",
            actorUserID: SOCCER_HEAD.id,
            keepOnly: ["SEED-R09"],
            now: MAY_2027,
          }),
        ).resolves.toBeUndefined();
        expect(await activeFreezes(SOCCER)).toHaveLength(1);
      });

      it("is idempotent for the same year and leaves a frozen list alone", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "lock",
          actorUserID: SOCCER_HEAD.id,
          now: MAR_2027,
        });
        const again = await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "close_year",
          actorUserID: ADMIN.id,
          academicYear: AY,
          now: MAY_2027,
        });

        expect(again).toEqual({ kind: "unchanged", academicYear: AY });
        const [f] = await activeFreezes(SOCCER);
        expect(f?.reason).toBe("lock");
      });
    });

    /* ---- (d) admin paths ------------------------------------------------ */
    describe("the head-removing paths", () => {
      it("freezes before an admin revokes a head, and not for a grant-only change", async () => {
        // Grant only: nobody is removed, nothing freezes.
        await as(ADMIN).admin.grantCcaHead({ userID: R09.id, ccaID: SOCCER });
        expect(await activeFreezes(SOCCER)).toHaveLength(0);
        expect(await heads(SOCCER)).toEqual([R09.id, SOCCER_HEAD.id].sort());

        await as(ADMIN).admin.revokeCcaHead({
          userID: SOCCER_HEAD.id,
          ccaID: SOCCER,
        });

        const [f] = await activeFreezes(SOCCER);
        expect(f).toMatchObject({ academicYear: AY, reason: "head_removed" });
        expect(await heads(SOCCER)).toEqual([R09.id]);
      });

      it("freezes before an admin transfers a head", async () => {
        await as(ADMIN).admin.transferCcaHead({
          fromUserID: SOCCER_HEAD.id,
          toUserID: R09.id,
          ccaID: SOCCER,
        });

        const [f] = await activeFreezes(SOCCER);
        expect(f).toMatchObject({ reason: "head_removed" });
        expect(await heads(SOCCER)).toEqual([R09.id]);
      });

      it("freezes before a head's own handover", async () => {
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [R09.id],
        });

        const [f] = await activeFreezes(SOCCER);
        expect(f).toMatchObject({ reason: "handover" });
        expect(await heads(SOCCER)).toEqual([R09.id]);
      });

      it("does not freeze when a handover keeps every head", async () => {
        await as(SOCCER_HEAD).cca.handoverHeads({
          ccaID: SOCCER,
          newHeadUserIDs: [SOCCER_HEAD.id, R09.id],
        });

        expect(await activeFreezes(SOCCER)).toHaveLength(0);
        expect(await heads(SOCCER)).toEqual([R09.id, SOCCER_HEAD.id].sort());
      });
    });

    /* ---- (e) a failing freeze ------------------------------------------- */
    describe("a freeze that fails", () => {
      it("refuses the handover and leaves the heads unchanged", async () => {
        const failing = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return () => Promise.reject(new Error("database went away"));
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

        const outcome = await errorOf(
          asOn(failing, SOCCER_HEAD).cca.handoverHeads({
            ccaID: SOCCER,
            newHeadUserIDs: [R09.id],
          }),
        );

        expect(outcome).toBe("PRECONDITION_FAILED:TRANSCRIPT_FREEZE_FAILED");
        expect(await heads(SOCCER)).toEqual([SOCCER_HEAD.id]);
        expect(await activeFreezes(SOCCER)).toHaveLength(0);
      });

      it("also refuses an admin revoke, leaving the head in place", async () => {
        const failing = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return () => Promise.reject(new Error("database went away"));
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

        const outcome = await errorOf(
          asOn(failing, ADMIN).admin.revokeCcaHead({
            userID: SOCCER_HEAD.id,
            ccaID: SOCCER,
          }),
        );

        expect(outcome).toBe("PRECONDITION_FAILED:TRANSCRIPT_FREEZE_FAILED");
        expect(await heads(SOCCER)).toEqual([SOCCER_HEAD.id]);
      });
    });

    /* ---- (f) who may edit ----------------------------------------------- */
    describe("edit rights", () => {
      const edit = (who: { id: string; roles: string[] }) =>
        errorOf(
          as(who).transcriptManage.roster.upsert({
            ccaID: SOCCER,
            academicYear: AY,
            userID: R12.id,
            extraContribution: "Kept the books.",
          }),
        );

      it("lets a head edit a list that is not frozen", async () => {
        expect(await edit(SOCCER_HEAD)).toBe("ok");
      });

      it("makes a handover-frozen list read-only for the head, but not for a manager", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
        });

        expect(await edit(SOCCER_HEAD)).toBe("FORBIDDEN:CCA_YEAR_FROZEN");
        expect(await edit(JCRC)).toBe("ok");
        expect(await edit(ADMIN)).toBe("ok");
        // the edit lands on the frozen entry, which stays frozen
        const entry = await db.transcriptRosterEntry.findFirstOrThrow({
          where: { academicYear: AY, ccaID: SOCCER, userID: R12.id },
        });
        expect(entry).toMatchObject({
          frozen: true,
          extraContribution: "Kept the books.",
        });
      });

      it("lets a head edit after their own lock, while the year is collecting", async () => {
        await as(SOCCER_HEAD).transcriptManage.roster.lock({ ccaID: SOCCER });

        expect(await edit(SOCCER_HEAD)).toBe("ok");
        // but only people on the frozen list can be edited
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.roster.upsert({
              ccaID: SOCCER,
              academicYear: AY,
              userID: R20.id,
              extraContribution: "x",
            }),
          ),
        ).toBe("BAD_REQUEST:NOT_A_MEMBER");

        // once the year is closed the head is read-only, lock or not
        await as(JCRC).transcript.periods.close({ academicYear: AY });
        expect(await edit(SOCCER_HEAD)).toBe("FORBIDDEN:YEAR_CLOSED");
        expect(await edit(JCRC)).toBe("ok");
      });

      it("refuses everyone once the year is published, and strangers always", async () => {
        await as(JCRC).transcript.periods.close({ academicYear: AY });
        await as(JCRC).transcript.periods.publish({ academicYear: AY });

        // A manager is refused until the resident is unlocked (a correction);
        // a head never gets that power.
        expect(await edit(JCRC)).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        expect(await edit(SOCCER_HEAD)).toBe(
          "PRECONDITION_FAILED:PERIOD_PUBLISHED",
        );
        expect(await edit(R09)).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
      });

      it("shows the head why a list is read-only, and a manager that it is editable", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: SOCCER_HEAD.id,
        });

        const head = await as(SOCCER_HEAD).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });
        const manager = await as(JCRC).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });

        expect(head.editRefusal).toBe("CCA_YEAR_FROZEN");
        expect(head.mode).toBe("frozen");
        expect(manager.editRefusal).toBeNull();
        expect(head.freeze?.frozenByName).toBe("Seed Resident 04");
      });

      it("says no list was recorded for a year the CCA has moved past", async () => {
        const list = await as(SOCCER_HEAD).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: NEXT,
        });

        expect(list.mode).toBe("none");
        expect(list.rows).toEqual([]);
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.roster.upsert({
              ccaID: SOCCER,
              academicYear: NEXT,
              userID: R12.id,
              extraContribution: "x",
            }),
          ),
        ).toBe("BAD_REQUEST:NOT_A_MEMBER");
      });
    });

    /* ---- (g) the year status machine ------------------------------------ */
    describe("closing, publishing, reopening and unfreezing", () => {
      it("closing freezes the remaining CCAs; publishing freezes nothing", async () => {
        const closed = await as(JCRC).transcript.periods.close({
          academicYear: AY,
        });
        expect(closed).toMatchObject({ frozenNow: 12, alreadyFrozen: 2 });
        expect(
          (
            await db.transcriptPeriod.findUniqueOrThrow({
              where: { academicYear: AY },
            })
          ).status,
        ).toBe("closed");
        const before = await db.ccaYearFreeze.count({
          where: { academicYear: AY, ...loader.NOT_UNFROZEN },
        });
        expect(before).toBe(14);

        await as(JCRC).transcript.periods.publish({ academicYear: AY });
        expect(
          await db.ccaYearFreeze.count({
            where: { academicYear: AY, ...loader.NOT_UNFROZEN },
          }),
        ).toBe(before);
      });

      it("refuses to close without a semester 2 date, or a year that has not begun", async () => {
        await as(JCRC).transcript.periods.setSem2Start({
          academicYear: AY,
          sem2Start: null,
        });
        expect(
          await errorOf(
            as(JCRC).transcript.periods.close({ academicYear: AY }),
          ),
        ).toBe("PRECONDITION_FAILED:SEM2_START_REQUIRED");
        expect(
          await errorOf(
            as(JCRC).transcript.periods.close({ academicYear: NEXT }),
          ),
        ).toBe("PRECONDITION_FAILED:YEAR_NOT_STARTED");
        expect(await activeFreezes(9006)).toHaveLength(0);
      });

      it("moves through the whole cycle and refuses the wrong step", async () => {
        const p = as(JCRC).transcript.periods;
        const status = async () =>
          (
            await db.transcriptPeriod.findUniqueOrThrow({
              where: { academicYear: AY },
            })
          ).status;

        expect(await errorOf(p.publish({ academicYear: AY }))).toBe(
          "CONFLICT:NOT_CLOSED",
        );
        await p.close({ academicYear: AY });
        expect(await status()).toBe("closed");
        expect(await errorOf(p.close({ academicYear: AY }))).toBe(
          "CONFLICT:NOT_COLLECTING",
        );
        expect(await errorOf(p.reopen({ academicYear: AY }))).toBe(
          "CONFLICT:NOT_PUBLISHED",
        );

        await p.backToCollecting({ academicYear: AY });
        expect(await status()).toBe("collecting");
        // frozen lists stay frozen
        expect(await activeFreezes(SOCCER)).toHaveLength(1);

        await p.close({ academicYear: AY });
        await p.publish({ academicYear: AY });
        expect(await status()).toBe("published");
        expect(await errorOf(p.backToCollecting({ academicYear: AY }))).toBe(
          "CONFLICT:NOT_CLOSED",
        );

        await p.reopen({ academicYear: AY });
        expect(await status()).toBe("closed");
      });

      it("unfreezing a CCA brings back live reading, with a reason, and not once published", async () => {
        await as(JCRC).transcript.periods.close({ academicYear: AY });
        const unfreeze = (reason: string) =>
          as(JCRC).transcript.freezes.unfreeze({
            academicYear: AY,
            ccaID: SOCCER,
            reason,
          });

        expect(await errorOf(unfreeze("  "))).toMatch(/^BAD_REQUEST:/);
        expect(await errorOf(unfreeze("Frozen by mistake"))).toBe("ok");

        const [row] = await db.ccaYearFreeze.findMany({
          where: { ccaID: SOCCER, academicYear: AY },
        });
        expect(row).toMatchObject({
          unfrozenBy: JCRC.id,
          unfreezeReason: "Frozen by mistake",
        });
        expect(row?.unfrozenAt).toBeInstanceOf(Date);
        expect(await activeFreezes(SOCCER)).toHaveLength(0);
        expect(await frozenKeys(SOCCER, AY)).toEqual([]);
        // the current member list is read again, until it is frozen again
        const list = await rosterSvc.rosterList(db, SOCCER, AY);
        expect(list.mode).toBe("live");
        expect(list.rows.map((r) => r.userID).sort()).toEqual(SOCCER_MEMBERS);
        expect(await errorOf(unfreeze("again"))).toBe("NOT_FOUND:NOT_FROZEN");

        // freezing again reuses the same document
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "lock",
          actorUserID: SOCCER_HEAD.id,
        });
        const rows = await db.ccaYearFreeze.findMany({
          where: { ccaID: SOCCER, academicYear: AY },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ reason: "lock", unfrozenAt: null });

        await as(JCRC).transcript.periods.publish({ academicYear: AY });
        expect(await errorOf(unfreeze("late"))).toBe(
          "FORBIDDEN:PERIOD_PUBLISHED",
        );
      });

      it("lists each CCA's state for the admin table, with names", async () => {
        const { rows, unfrozen } = await as(JCRC).transcript.freezes.list({
          academicYear: AY,
        });

        expect(rows).toHaveLength(14);
        expect(unfrozen).toBe(12);
        const dance = rows.find((r) => r.ccaID === 9014)!;
        expect(dance).toMatchObject({
          state: "Frozen at handover",
          frozenByName: "Seed Resident 01",
        });
        expect(rows.find((r) => r.ccaID === 9013)?.state).toBe(
          "Locked by head",
        );
        expect(rows.find((r) => r.ccaID === SOCCER)?.state).toBe("Not frozen");
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcript.freezes.list({ academicYear: AY }),
          ),
        ).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
      });
    });

    /* ---- (h) the resident's view ---------------------------------------- */
    describe("what a resident sees", () => {
      it("sees a DRAFT while the year is closed, with nothing recorded, and the real thing once published", async () => {
        await as(JCRC).transcript.periods.close({ academicYear: AY });

        const draft = await as(R12).transcript.mine.get({ academicYear: AY });
        expect(draft).toMatchObject({ status: "ready", draft: true });
        if (draft.status !== "ready") throw new Error("not ready");
        expect(draft.transcript.isDraft).toBe(true);
        expect(draft.downloadBy).toBeNull();
        expect(
          await db.transcriptAccess.count({ where: { userID: R12.id } }),
        ).toBe(0);
        expect(await as(R12).transcript.mine.readiness()).toEqual({
          ready: false,
          academicYear: null,
        });
        expect(await as(R12).transcript.mine.years()).toEqual([
          { academicYear: AY, draft: true },
        ]);

        await as(JCRC).transcript.periods.publish({ academicYear: AY });
        expect(await as(R12).transcript.mine.readiness()).toEqual({
          ready: true,
          academicYear: AY,
        });
        const real = await as(R12).transcript.mine.get({ academicYear: AY });
        expect(real).toMatchObject({ status: "ready", draft: false });
        expect(
          await db.transcriptAccess.count({ where: { userID: R12.id } }),
        ).toBe(1);
      });

      it("sees nothing while the year is collecting", async () => {
        expect(await as(R12).transcript.mine.get({ academicYear: AY })).toEqual(
          {
            status: "not_open",
            academicYear: AY,
          },
        );
        expect(await as(R12).transcript.mine.years()).toEqual([]);
      });
    });

    /* ---- (i) retention --------------------------------------------------- */
    describe("purging a year", () => {
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
            sem2Start: new Date("2026-01-10T16:00:00Z"),
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
          data: strip(await db.award.findMany({ where })) as never,
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
