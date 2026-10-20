import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAy2026Clock } from "./ayClock";
import { isLocalDevDatabase } from "./localDbGate";

/**
 * INTEGRATION TESTS of per-resident corrections against the LOCAL development
 * database (skipped unless DATABASE_URL is localhost and the database is
 * `rhapp_transcript_dev`; run `npm run test:db`). The seed is re-run before every
 * test. Each test closes and publishes the seeded year itself, with the same
 * procedures the admin buttons call, then works on a PUBLISHED year.
 */

const AY = "AY2026/27";
const NOW = new Date("2026-10-16T04:00:00Z");
const SOCCER = 9005;
const DANCE = 9008;
const CHILDREN = 9002;

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const ADMIN = R(1, ["admin", "resident"]);
const JCRC = R(2, ["jcrc", "resident"]);
const SOCCER_HEAD = R(4, ["cca_head", "resident"]);
const R12 = R(12, ["resident"]);
const R17 = R(17, ["resident"]);
const R20 = R(20, ["resident"]);

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "per-resident corrections (local database)",
  { timeout: 300_000 },
  () => {
    useAy2026Clock();

    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let loader: typeof import("../loader");
    let ipCounter = 0;

    const as = (who: { id: string; roles: string[] } | null) =>
      createCaller({
        db,
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

    /** The admin button: Open transcripts. */
    const publishYear = async () => {
      await as(JCRC).transcript.periods.open({ academicYear: AY });
    };
    const unlock = (who: { id: string }, reason = "Wrong role on file") =>
      as(JCRC).transcriptManage.corrections.unlock({
        userID: who.id,
        academicYear: AY,
        reason,
      });
    const setRole = (
      who: { id: string },
      roleLabel: string | null,
      actor = JCRC,
      ccaID = SOCCER,
    ) =>
      as(actor).transcriptManage.roster.upsert({
        ccaID,
        academicYear: AY,
        userID: who.id,
        roleLabel,
      });
    const history = (who: { id: string }) =>
      as(JCRC).transcriptManage.corrections.history({
        userID: who.id,
        academicYear: AY,
      });
    const events = (who: { id: string }) =>
      db.residentEvent.findMany({
        where: { academicYear: AY, userID: who.id },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      });
    const interHall = () =>
      db.ccaActivity.findFirstOrThrow({
        where: { ccaID: SOCCER, title: "Inter-hall league" },
      });
    const entryOf = (who: { id: string }, ccaID = SOCCER) =>
      db.transcriptRosterEntry.findFirstOrThrow({
        where: { academicYear: AY, userID: who.id, ccaID },
      });

    /* ---------------------------------------------------------------- */
    describe("unlocking one resident of a published year", () => {
      it("refuses a manager's write for a locked resident, allows it after Unlock, and logs a correction", async () => {
        await publishYear();

        expect(await errorOf(setRole(R12, "Vice-Captain"))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        expect((await entryOf(R12)).roleLabel ?? null).toBeNull();

        await unlock(R12);
        expect(await errorOf(setRole(R12, "Vice-Captain"))).toBe("ok");
        expect((await entryOf(R12)).roleLabel).toBe("Vice-Captain");

        const logged = await events(R12);
        expect(logged.map((e) => e.action)).toEqual(["unlock", "correction"]);
        expect(logged[1]).toMatchObject({
          actor: JCRC.id,
          summary: "Roster: Soccer (MALE) role set to Vice-Captain",
        });
      });

      it("renders the corrected role on the transcript straight away", async () => {
        await publishYear();
        await unlock(R12);
        await setRole(R12, "Vice-Captain");

        const input = await loader.loadTranscriptInput(db, R12.id, AY, {
          now: NOW,
        });
        expect(
          input.memberships.find((m) => m.ccaName === "Soccer (MALE)")
            ?.leadershipRole,
        ).toBe("Vice-Captain");
      });

      it("does not let an unlock of one resident open another", async () => {
        await publishYear();
        await unlock(R12);

        // R04 is a Soccer member too, but is not unlocked.
        expect(await errorOf(setRole({ id: "SEED-R04" }, "Striker"))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        expect(await errorOf(setRole(R12, "Captain"))).toBe("ok");
      });

      it("refuses an unlock while the year is collecting, and asking again changes nothing", async () => {
        expect(await errorOf(unlock(R12))).toBe(
          "PRECONDITION_FAILED:YEAR_NOT_OPEN",
        );
        await publishYear();
        expect(await errorOf(unlock(R12))).toBe("ok");
        expect(await errorOf(unlock(R12))).toBe("ok");
        expect(
          await db.residentUnlock.count({
            where: { academicYear: AY, userID: R12.id },
          }),
        ).toBe(1);
        expect(
          (await events(R12)).filter((e) => e.action === "unlock"),
        ).toHaveLength(1);
      });

      it("keeps one active unlock and one history line when five unlocks arrive at once", async () => {
        await publishYear();
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            errorOf(unlock(R12, "Wrong role on file")),
          ),
        );
        expect(results).toEqual(["ok", "ok", "ok", "ok", "ok"]);
        const rows = await db.residentUnlock.findMany({
          where: { academicYear: AY, userID: R12.id },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.activeKey).toBe(`${AY}|${R12.id}`);
        expect(
          (await events(R12)).filter((e) => e.action === "unlock"),
        ).toHaveLength(1);
      });

      it("frees the key on relock, so the resident can be unlocked again", async () => {
        await publishYear();
        await unlock(R12);
        await as(JCRC).transcriptManage.corrections.relock({
          userID: R12.id,
          academicYear: AY,
        });
        const [ended] = await db.residentUnlock.findMany({
          where: { academicYear: AY, userID: R12.id },
        });
        expect(ended!.activeKey).toBe(`${AY}|${R12.id}|ended|${ended!.id}`);
        expect(await errorOf(unlock(R12, "Again"))).toBe("ok");
        expect(
          await db.residentUnlock.count({
            where: { academicYear: AY, userID: R12.id },
          }),
        ).toBe(2);
        expect(await errorOf(setRole(R12, "Vice-Captain"))).toBe("ok");
      });

      it("requires a reason", async () => {
        await publishYear();
        expect(
          (await errorOf(unlock(R12, "  "))).startsWith("BAD_REQUEST"),
        ).toBe(true);
      });

      it("restores the refusal on Relock", async () => {
        await publishYear();
        await unlock(R12);
        expect(await errorOf(setRole(R12, "Vice-Captain"))).toBe("ok");

        await as(JCRC).transcriptManage.corrections.relock({
          userID: R12.id,
          academicYear: AY,
          note: "Done",
        });
        expect(await errorOf(setRole(R12, "Captain"))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        expect((await entryOf(R12)).roleLabel).toBe("Vice-Captain");
        expect(
          await errorOf(
            as(JCRC).transcriptManage.corrections.relock({
              userID: R12.id,
              academicYear: AY,
            }),
          ),
        ).toBe("CONFLICT:NOT_UNLOCKED");
      });

      it("never lets a head through, with or without an unlock", async () => {
        await publishYear();
        await unlock(R12);

        expect(await errorOf(setRole(R12, "Vice-Captain", SOCCER_HEAD))).toBe(
          "PRECONDITION_FAILED:PERIOD_PUBLISHED",
        );
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.corrections.unlock({
              userID: R12.id,
              academicYear: AY,
              reason: "Because I am a head",
            }),
          ),
        ).toMatch(/^FORBIDDEN:/);
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.corrections.history({
              userID: R12.id,
              academicYear: AY,
            }),
          ),
        ).toMatch(/^FORBIDDEN:/);
        expect((await entryOf(R12)).roleLabel ?? null).toBeNull();
      });

      it("keeps activity-level fields locked on a published year even with an unlock", async () => {
        await publishYear();
        await unlock(R12);
        const activity = await interHall();

        expect(
          await errorOf(
            as(JCRC).transcriptManage.activities.update({
              id: activity.id,
              ccaID: SOCCER,
              title: "Renamed",
              description: "",
              period: "full",
            }),
          ),
        ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
        expect(
          await errorOf(
            as(JCRC).transcriptManage.activities.remove({
              id: activity.id,
              ccaID: SOCCER,
            }),
          ),
        ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
        expect((await interHall()).title).toBe("Inter-hall league");
      });

      it("a correction whose first read still saw the year collecting changes the locked entry and keeps earlier corrections (S5)", async () => {
        await publishYear();
        await unlock(R12);
        await as(JCRC).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: R12.id,
          extraContribution: "Corrected A.",
        });

        // The database, except that the FIRST read of the year (the one before
        // the guard) still finds it collecting: Open landed just after it.
        let reads = 0;
        const stale = new Proxy(db, {
          get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (prop !== "transcriptPeriod") {
              return typeof value === "function"
                ? (value as (...a: unknown[]) => unknown).bind(target)
                : value;
            }
            const period = value as PrismaClient["transcriptPeriod"];
            return new Proxy(period, {
              get(t, p, r) {
                if (p !== "findUnique") return Reflect.get(t, p, r);
                return async (
                  args: Parameters<typeof period.findUnique>[0],
                ) => {
                  const row = await period.findUnique(args);
                  reads += 1;
                  return reads === 1 && row
                    ? { ...row, status: "collecting" }
                    : row;
                };
              },
            });
          },
        }) as PrismaClient;

        const roster = await import("../manageRoster");
        await roster.rosterUpsert(stale, JCRC.id, {
          ccaID: SOCCER,
          academicYear: AY,
          userID: R12.id,
          duration: "sem2",
        });
        expect(reads).toBeGreaterThan(1);
        expect(await entryOf(R12)).toMatchObject({
          frozen: true,
          duration: "sem2",
          extraContribution: "Corrected A.",
        });
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a batch write", () => {
      it("is refused entirely when one affected resident is locked, and goes through once both are unlocked", async () => {
        await publishYear();
        const activity = await interHall();
        const set = (captainRole: string) =>
          as(JCRC).transcriptManage.participants.set({
            id: activity.id,
            ccaID: SOCCER,
            participants: [
              {
                userID: "SEED-R04",
                role: captainRole,
                description: "Led the squad through ten league matches.",
              },
              { userID: R12.id, role: "Striker", description: "" },
              {
                userID: R20.id,
                role: "Guest goalkeeper",
                description: "Covered two fixtures at short notice.",
              },
            ],
          });
        await unlock(R12);

        // R04 (locked) and R12 (unlocked) both change: nothing is written.
        expect(await errorOf(set("Club captain"))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        const mine = (userID: string) =>
          db.ccaActivityParticipant.findFirstOrThrow({
            where: { activityID: activity.id, userID },
          });
        expect((await mine(R12.id)).role).toBe("Midfielder");
        expect((await mine("SEED-R04")).role).toBe("Captain");

        await unlock({ id: "SEED-R04" });
        expect(await errorOf(set("Club captain"))).toBe("ok");
        expect((await mine(R12.id)).role).toBe("Striker");
        expect((await mine("SEED-R04")).role).toBe("Club captain");
        expect(
          (await events(R12)).filter((e) => e.action === "correction"),
        ).toHaveLength(1);
        expect(
          (await events({ id: "SEED-R04" })).filter(
            (e) => e.action === "correction",
          ),
        ).toHaveLength(1);
        // R20 was not touched, so no line for R20.
        expect(await events(R20)).toHaveLength(0);
      });

      it("takes the affected residents from the stored data, not from the client", async () => {
        await publishYear();
        await unlock(R12);
        const activity = await interHall();

        // Dropping R20 from the list removes them: R20 is locked, so refused.
        expect(
          await errorOf(
            as(JCRC).transcriptManage.participants.set({
              id: activity.id,
              ccaID: SOCCER,
              participants: [
                {
                  userID: "SEED-R04",
                  role: "Captain",
                  description: "Led the squad through ten league matches.",
                },
                { userID: R12.id, role: "Midfielder", description: "" },
              ],
            }),
          ),
        ).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
      });

      it("covers volunteer attendance for an unlocked resident only", async () => {
        await publishYear();
        const activity = await db.volunteerActivity.findFirstOrThrow({
          where: { ccaID: CHILDREN, title: { startsWith: "Weekly tuition" } },
        });
        const sessions = await db.volunteerSession.findMany({
          where: { activityID: activity.id },
          orderBy: { date: "asc" },
        });
        const save = (userID: string) =>
          as(JCRC).transcriptManage.volunteer.attendance.save({
            activityID: activity.id,
            ccaID: CHILDREN,
            changes: [
              {
                sessionID: sessions[0]!.id,
                userID,
                attended: true,
                hoursOverride: 1,
              },
            ],
          });

        expect(await errorOf(save(R12.id))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        await unlock(R12);
        expect(await errorOf(save(R12.id))).toBe("ok");
        const tick = await db.volunteerAttendance.findFirstOrThrow({
          where: { sessionID: sessions[0]!.id, userID: R12.id },
        });
        expect(tick.hoursOverride).toBe(1);
        expect(
          (await events(R12)).find((e) => e.action === "correction")?.summary,
        ).toMatch(/^Volunteer hours: Weekly tuition.* attendance changed/);
      });

      it("covers award writes, one at a time and in bulk", async () => {
        await publishYear();
        const award = await db.award.findFirstOrThrow({
          where: {
            academicYear: AY,
            userID: R12.id,
            title: "Outstanding Newcomer",
          },
        });
        const other = await db.award.findFirstOrThrow({
          where: { academicYear: AY, userID: "SEED-R04" },
        });
        const m = as(JCRC).transcriptManage;

        expect(await errorOf(m.awards.remove({ id: award.id }))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        await unlock(R12);
        expect(
          await errorOf(m.awards.bulkRemove({ ids: [award.id, other.id] })),
        ).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        expect(await errorOf(m.awards.remove({ id: award.id }))).toBe("ok");
        expect(await errorOf(m.awards.restore({ id: award.id }))).toBe("ok");
        expect(
          (await events(R12))
            .filter((e) => e.action === "correction")
            .map((e) => e.summary),
        ).toEqual([
          "Awards: Outstanding Newcomer removed",
          "Awards: Outstanding Newcomer restored",
        ]);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("manual CCA entries", () => {
      it("moves an activity from Other involvement to under the CCA", async () => {
        const before = await loader.loadTranscriptInput(db, R20.id, AY, {
          now: NOW,
        });
        expect(before.memberships.map((m) => m.ccaName)).not.toContain(
          "Soccer (MALE)",
        );
        expect(
          before.activities?.find((a) => a.title === "Inter-hall league")
            ?.isMember,
        ).toBe(false);

        await as(JCRC).transcriptManage.corrections.memberships.saveManual({
          userID: R20.id,
          academicYear: AY,
          ccaID: SOCCER,
          duration: "full",
        });

        const after = await loader.loadTranscriptInput(db, R20.id, AY, {
          now: NOW,
        });
        expect(after.memberships.map((m) => m.ccaName)).toContain(
          "Soccer (MALE)",
        );
        expect(
          after.activities?.find((a) => a.title === "Inter-hall league")
            ?.isMember,
        ).toBe(true);
        expect((await events(R20)).map((e) => e.action)).toEqual([
          "manual_add",
        ]);
      });

      it("lets the roster entry win when the resident is in the roster too", async () => {
        await as(JCRC).transcriptManage.corrections.memberships.saveManual({
          userID: R12.id,
          academicYear: AY,
          ccaID: SOCCER,
          duration: "sem1",
          roleLabel: "Manual captain",
        });
        const input = await loader.loadTranscriptInput(db, R12.id, AY, {
          now: NOW,
        });
        const soccer = input.memberships.filter(
          (m) => m.ccaName === "Soccer (MALE)",
        );
        expect(soccer).toHaveLength(1);
        expect(soccer[0]!.leadershipRole).toBeNull();

        const list = await as(
          JCRC,
        ).transcriptManage.corrections.memberships.list({
          userID: R12.id,
          academicYear: AY,
        });
        expect(list.manual.find((m) => m.ccaID === SOCCER)?.alsoInRoster).toBe(
          true,
        );
      });

      it("shows the seeded manual entry as a normal row, and tags it manual in the admin list", async () => {
        const input = await loader.loadTranscriptInput(db, R17.id, AY, {
          now: NOW,
        });
        const dance = input.memberships.find((m) => m.ccaName === "Dance Crew");
        expect(dance).toMatchObject({ duration: "sem2" });
        const list = await as(
          JCRC,
        ).transcriptManage.corrections.memberships.list({
          userID: R17.id,
          academicYear: AY,
        });
        expect(list.manual.map((m) => m.ccaName)).toEqual(["Dance Crew"]);
        expect(list.roster.map((m) => m.ccaName)).not.toContain("Dance Crew");
      });

      it("refuses a role period outside the membership period", async () => {
        const save = (roleDuration: "sem1" | "sem2") =>
          as(JCRC).transcriptManage.corrections.memberships.saveManual({
            userID: R17.id,
            academicYear: AY,
            ccaID: DANCE,
            duration: "sem2",
            roleLabel: "Choreographer",
            roleDuration,
          });
        expect(await errorOf(save("sem1"))).toBe(
          "BAD_REQUEST:ROLE_PERIOD_OUTSIDE_MEMBERSHIP",
        );
        expect(await errorOf(save("sem2"))).toBe("ok");
      });

      it("removes and restores softly, with who and when, and leaves the transcript while removed", async () => {
        const m = as(JCRC).transcriptManage.corrections.memberships;
        const ref = { userID: R17.id, academicYear: AY, ccaID: DANCE };
        await m.removeManual(ref);

        const gone = await loader.loadTranscriptInput(db, R17.id, AY, {
          now: NOW,
        });
        expect(gone.memberships.map((x) => x.ccaName)).not.toContain(
          "Dance Crew",
        );
        const row = await db.manualMembership.findFirstOrThrow({
          where: { academicYear: AY, userID: R17.id, ccaID: DANCE },
        });
        expect(row.removedBy).toBe(JCRC.id);
        expect(row.removedAt).not.toBeNull();
        expect(
          (await m.list({ userID: R17.id, academicYear: AY })).manual,
        ).toHaveLength(0);
        expect(
          (
            await m.list({
              userID: R17.id,
              academicYear: AY,
              includeRemoved: true,
            })
          ).manual,
        ).toHaveLength(1);
        expect(await errorOf(m.saveManual({ ...ref, duration: "full" }))).toBe(
          "CONFLICT:MANUAL_REMOVED",
        );

        await m.restoreManual(ref);
        const back = await loader.loadTranscriptInput(db, R17.id, AY, {
          now: NOW,
        });
        expect(back.memberships.map((x) => x.ccaName)).toContain("Dance Crew");
        expect((await events(R17)).map((e) => e.action)).toEqual([
          "manual_add",
          "manual_remove",
          "manual_restore",
        ]);
      });

      it("needs an unlock to change a manual entry in a published year", async () => {
        await publishYear();
        const save = () =>
          as(JCRC).transcriptManage.corrections.memberships.saveManual({
            userID: R17.id,
            academicYear: AY,
            ccaID: DANCE,
            roleLabel: "Choreographer",
          });
        expect(await errorOf(save())).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        await unlock(R17);
        expect(await errorOf(save())).toBe("ok");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("withholding a transcript", () => {
      const get = (who: { id: string; roles: string[] }) =>
        as(who).transcript.mine.get({ academicYear: AY });
      const withhold = (who: { id: string }) =>
        as(ADMIN).transcriptManage.corrections.withhold({
          userID: who.id,
          academicYear: AY,
          reason: "Outstanding hall fees",
        });

      it("shows only the hold, records no opening and clears the Ready badge", async () => {
        await publishYear();
        await withhold(R12);

        expect(await get(R12)).toEqual({
          status: "on_hold",
          academicYear: AY,
        });
        // Even asking to note an opening does nothing for a held resident.
        expect(
          await as(R12).transcript.mine.markOpened({ academicYear: AY }),
        ).toEqual({ recorded: false });
        expect(
          await db.transcriptAccess.count({
            where: { academicYear: AY, userID: R12.id },
          }),
        ).toBe(0);
        expect(await as(R12).transcript.mine.readiness()).toEqual({
          ready: false,
          academicYear: null,
        });
        // The year is still listed, and others are unaffected.
        expect(await as(R12).transcript.mine.years()).toEqual([AY]);
        // R20 is not held: opening the year records the opening, so no badge.
        expect((await get(R20)).status).toBe("ready");
        await as(R20).transcript.mine.markOpened({ academicYear: AY });
        expect(await as(R20).transcript.mine.readiness()).toEqual({
          ready: false,
          academicYear: null,
        });
      });

      it("still lets a manager preview a held resident, with a note flag", async () => {
        await publishYear();
        await withhold(R12);

        expect(await get(R12)).toEqual({
          status: "on_hold",
          academicYear: AY,
        });
        const preview = await as(JCRC).transcript.preview({
          userID: R12.id,
          academicYear: AY,
        });
        expect(preview.withheld).toBe(true);
        expect(preview.transcript).toBeDefined();
        expect(
          (
            await as(JCRC).transcript.preview({
              userID: R20.id,
              academicYear: AY,
            })
          ).withheld,
        ).toBe(false);
      });

      it("restores the transcript and the Ready badge on Release", async () => {
        await publishYear();
        await withhold(R12);
        await as(ADMIN).transcriptManage.corrections.release({
          userID: R12.id,
          academicYear: AY,
          note: "Fees paid",
        });

        expect((await get(R12)).status).toBe("ready");
        await as(R12).transcript.mine.markOpened({ academicYear: AY });
        expect(
          await db.transcriptAccess.count({
            where: { academicYear: AY, userID: R12.id },
          }),
        ).toBe(1);
      });

      it("keeps the Ready badge for a held resident after release when never opened", async () => {
        await publishYear();
        await withhold(R12);
        await as(ADMIN).transcriptManage.corrections.release({
          userID: R12.id,
          academicYear: AY,
        });
        expect(await as(R12).transcript.mine.readiness()).toEqual({
          ready: true,
          academicYear: AY,
        });
      });

      it("keeps one hold and one history line when five holds arrive at once", async () => {
        await publishYear();
        const results = await Promise.all(
          Array.from({ length: 5 }, () => errorOf(withhold(R12))),
        );
        expect(results).toEqual(["ok", "ok", "ok", "ok", "ok"]);
        expect(
          await db.residentWithhold.count({
            where: { academicYear: AY, userID: R12.id },
          }),
        ).toBe(1);
        expect(
          (await events(R12)).filter((e) => e.action === "withhold"),
        ).toHaveLength(1);
        // Released, it can be held again.
        await as(ADMIN).transcriptManage.corrections.release({
          userID: R12.id,
          academicYear: AY,
        });
        expect(await errorOf(withhold(R12))).toBe("ok");
      });

      it("ends a hold once, with one history line, when five releases arrive at once", async () => {
        await publishYear();
        expect(await errorOf(withhold(R12))).toBe("ok");
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            errorOf(
              as(ADMIN).transcriptManage.corrections.release({
                userID: R12.id,
                academicYear: AY,
              }),
            ),
          ),
        );
        // A release that read the hold after it ended is told so; none fails.
        for (const r of results) {
          expect(["ok", "CONFLICT:NOT_WITHHELD"]).toContain(r);
        }
        expect(results).toContain("ok");
        expect(
          await db.residentWithhold.count({
            where: {
              academicYear: AY,
              userID: R12.id,
              OR: [{ releasedAt: null }, { releasedAt: { isSet: false } }],
            },
          }),
        ).toBe(0);
        expect(
          (await events(R12)).filter((e) => e.action === "release"),
        ).toHaveLength(1);
      });

      it("asks again for a hold changes nothing, refuses a release with no hold, and a missing reason", async () => {
        await publishYear();
        expect(await errorOf(withhold(R12))).toBe("ok");
        expect(await errorOf(withhold(R12))).toBe("ok");
        expect(
          await errorOf(
            as(ADMIN).transcriptManage.corrections.release({
              userID: R20.id,
              academicYear: AY,
            }),
          ),
        ).toBe("CONFLICT:NOT_WITHHELD");
        expect(
          (
            await errorOf(
              as(ADMIN).transcriptManage.corrections.withhold({
                userID: R20.id,
                academicYear: AY,
                reason: "",
              }),
            )
          ).startsWith("BAD_REQUEST"),
        ).toBe(true);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("history", () => {
      it("marks a change the resident made on their own records as a self-made change (F25a)", async () => {
        await publishYear();
        const colours = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        const give = (userID: string) =>
          as(JCRC).transcriptManage.awards.assign({
            academicYear: AY,
            awardTypeID: colours.id,
            recipients: [{ userID }],
          });
        await unlock({ id: JCRC.id });
        await give(JCRC.id);
        await unlock({ id: "SEED-R20" });
        await give("SEED-R20");

        const mine = await history(JCRC);
        const theirs = await history({ id: "SEED-R20" });

        // JCRC unlocked and corrected their own records; R20's were done by JCRC.
        expect(mine.some((l) => l.selfMade)).toBe(true);
        expect(mine.filter((l) => l.selfMade).length).toBe(mine.length);
        expect(theirs.some((l) => l.selfMade)).toBe(false);
      });

      it("logs and flags a JCRC member's award to themself while the year is collecting, and not others' (P2)", async () => {
        const colours = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        await as(JCRC).transcriptManage.awards.assign({
          academicYear: AY,
          awardTypeID: colours.id,
          recipients: [{ userID: JCRC.id }, { userID: R20.id }],
        });

        // The JCRC member's own history has the change, flagged as self-made.
        const mine = await history(JCRC);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ action: "change", selfMade: true });
        expect(mine[0]!.summary).toContain("Full Colours");
        // An ordinary award to someone else while collecting is not a history line.
        expect(await history(R20)).toEqual([]);

        const list = await as(ADMIN).transcriptManage.awards.list({
          academicYear: AY,
        });
        const flag = (userID: string) =>
          list.find((a) => a.userID === userID && a.title === "Full Colours")
            ?.selfRecorded;
        expect(flag(JCRC.id)).toBe(true);
        expect(flag(R20.id)).toBe(false);
      });

      it("flags an award a manager removed from themself, and logs it (P2)", async () => {
        const colours = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        await as(ADMIN).transcriptManage.awards.assign({
          academicYear: AY,
          awardTypeID: colours.id,
          recipients: [{ userID: JCRC.id }],
        });
        const given = (
          await as(ADMIN).transcriptManage.awards.list({ academicYear: AY })
        ).find((a) => a.userID === JCRC.id && a.title === "Full Colours")!;
        // Recorded by someone else: not self-made, and no history line.
        expect(given.selfRecorded).toBe(false);
        expect(await history(JCRC)).toEqual([]);

        await as(JCRC).transcriptManage.awards.remove({ id: given.id });
        const after = (
          await as(ADMIN).transcriptManage.awards.list({
            academicYear: AY,
            includeRemoved: true,
          })
        ).find((a) => a.id === given.id)!;
        expect(after).toMatchObject({ removed: true, selfRecorded: true });
        const mine = await history(JCRC);
        expect(mine.map((l) => [l.action, l.selfMade])).toEqual([
          ["change", true],
        ]);
        // The resident panel's awards tab flags it too.
        const tab = await as(ADMIN).transcriptManage.corrections.awards({
          userID: JCRC.id,
          academicYear: AY,
          includeRemoved: true,
        });
        expect(tab.find((a) => a.id === given.id)?.selfRecorded).toBe(true);
      });

      it("logs a head's change to their own roster entry while collecting, and not to others' (P2)", async () => {
        await setRole(SOCCER_HEAD, "Captain", SOCCER_HEAD);
        await setRole(R12, "Kit manager", SOCCER_HEAD);

        const mine = await history(SOCCER_HEAD);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ action: "change", selfMade: true });
        expect(mine[0]!.summary).toContain("Soccer");
        expect(await history(R12)).toEqual([]);
      });

      it("flags a manager withholding and releasing their own open transcript (P2)", async () => {
        await publishYear();
        await as(JCRC).transcriptManage.corrections.withhold({
          userID: JCRC.id,
          academicYear: AY,
          reason: "Testing my own hold",
        });
        await as(JCRC).transcriptManage.corrections.release({
          userID: JCRC.id,
          academicYear: AY,
        });
        const mine = await history(JCRC);
        expect(mine.map((l) => l.action).sort()).toEqual([
          "release",
          "withhold",
        ]);
        expect(mine.every((l) => l.selfMade)).toBe(true);
      });

      it("lists every event for the resident and year, newest first, with names", async () => {
        await publishYear();
        await unlock(R12, "Role was wrong");
        await setRole(R12, "Vice-Captain");
        await as(ADMIN).transcriptManage.corrections.withhold({
          userID: R12.id,
          academicYear: AY,
          reason: "Fees",
        });
        await as(ADMIN).transcriptManage.corrections.release({
          userID: R12.id,
          academicYear: AY,
          note: "Paid",
        });
        await as(JCRC).transcriptManage.corrections.relock({
          userID: R12.id,
          academicYear: AY,
        });

        const lines = await history(R12);
        expect(lines.map((l) => l.action)).toEqual([
          "relock",
          "release",
          "withhold",
          "correction",
          "unlock",
        ]);
        expect(lines.map((l) => l.byName)).toEqual([
          "Seed Resident 02",
          "Seed Resident 01",
          "Seed Resident 01",
          "Seed Resident 02",
          "Seed Resident 02",
        ]);
        expect(lines[4]!.reason).toBe("Role was wrong");
        expect(lines[3]!.summary).toBe(
          "Roster: Soccer (MALE) role set to Vice-Captain",
        );
        expect(lines[1]!.reason).toBe("Paid");
        for (const l of lines) expect(l.at).toBeInstanceOf(Date);
        // Another resident's history is untouched.
        expect(await history(R20)).toEqual([]);
      });

      it("includes the seeded manual-entry line", async () => {
        const lines = await history(R17);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          action: "manual_add",
          summary: "Manual entry: Dance Crew added",
          byName: "Seed Resident 02",
        });
      });
    });

    /* ---------------------------------------------------------------- */
    describe("JCRC pages", () => {
      it("soft-removes a member's page, keeps it off the transcript, and restores it", async () => {
        const m = as(JCRC).transcriptManage.corrections.jcrc;
        const ref = { userID: JCRC.id, academicYear: AY };
        expect(
          (await loader.loadTranscriptInput(db, JCRC.id, AY, { now: NOW }))
            .jcrc,
        ).not.toBeNull();

        await m.remove(ref);
        expect(
          (await loader.loadTranscriptInput(db, JCRC.id, AY, { now: NOW }))
            .jcrc,
        ).toBeNull();
        const row = await db.jcrcService.findFirstOrThrow({
          where: { academicYear: AY, userID: JCRC.id },
        });
        expect(row).toMatchObject({ removedBy: JCRC.id });
        expect(row.removedAt).not.toBeNull();
        expect((await m.get(ref))?.removed).toBe(true);

        // A removed page cannot be saved over; restore it first.
        expect(
          await errorOf(
            as(ADMIN).transcriptManage.jcrc.saveFor({
              userID: JCRC.id,
              academicYear: AY,
              portfolio: "Sports",
              position: "Secretary",
              description: "",
              contributions: [],
              testimonial: "",
            }),
          ),
        ).toBe("CONFLICT:JCRC_PAGE_REMOVED");

        await m.restore(ref);
        expect(
          (await loader.loadTranscriptInput(db, JCRC.id, AY, { now: NOW }))
            .jcrc,
        ).not.toBeNull();
        expect((await m.get(ref))?.removed).toBe(false);
      });

      it("needs an unlock to remove or save a JCRC page in a published year", async () => {
        await publishYear();
        const m = as(ADMIN).transcriptManage.corrections.jcrc;
        const ref = { userID: JCRC.id, academicYear: AY };
        expect(await errorOf(m.remove(ref))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        await unlock(JCRC);
        expect(await errorOf(m.remove(ref))).toBe("ok");
        expect(await errorOf(m.restore(ref))).toBe("ok");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("reset to default", () => {
      it("clears every override of a roster entry when all four are sent as null", async () => {
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: "SEED-R12",
          duration: "sem2",
          roleLabel: "Vice-Captain",
          roleDuration: "sem2",
          extraContribution: "Ran the fixtures.",
        });
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: "SEED-R12",
          duration: null,
          roleLabel: null,
          roleDuration: null,
          extraContribution: null,
        });
        const row = await entryOf(R12);
        expect(row.duration ?? null).toBeNull();
        expect(row.roleLabel ?? null).toBeNull();
        expect(row.roleDuration ?? null).toBeNull();
        expect(row.extraContribution ?? null).toBeNull();

        const list = await as(SOCCER_HEAD).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });
        const r12 = list.rows.find((r) => r.userID === R12.id)!;
        expect(r12.duration).toBeNull();
        expect(r12.effective.duration).toBe(r12.defaultDuration);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("who may use the corrections procedures", () => {
      it("refuses plain residents and heads, and signed-out callers", async () => {
        const call = (who: { id: string; roles: string[] } | null) =>
          errorOf(
            as(who).transcriptManage.corrections.panel({
              userID: R12.id,
              academicYear: AY,
            }),
          );
        expect(await call(R20)).toMatch(/^FORBIDDEN:/);
        expect(await call(SOCCER_HEAD)).toMatch(/^FORBIDDEN:/);
        expect(await call(null)).toMatch(/^UNAUTHORIZED:/);
        expect(await call(JCRC)).toBe("ok");
        expect(await call(ADMIN)).toBe("ok");
      });

      it("describes the status line from the live data", async () => {
        const panel = () =>
          as(JCRC).transcriptManage.corrections.panel({
            userID: R12.id,
            academicYear: AY,
          });
        expect(await panel()).toMatchObject({
          status: "collecting",
          state: "collecting",
          withheld: false,
          unlocked: false,
          isJcrcMember: false,
        });
        await publishYear();
        await unlock(R12);
        await as(ADMIN).transcriptManage.corrections.withhold({
          userID: R12.id,
          academicYear: AY,
          reason: "Fees",
        });
        expect(await panel()).toMatchObject({
          status: "published",
          state: "published",
          withheld: true,
          unlocked: true,
          displayName: "Seed Resident 12",
        });
        expect(
          (
            await as(JCRC).transcriptManage.corrections.panel({
              userID: JCRC.id,
              academicYear: AY,
            })
          ).isJcrcMember,
        ).toBe(true);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a correction and its history line are one write", () => {
      /** A database whose history writes inside a transaction fail. */
      const lossyHistory = () =>
        new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
                target.$transaction(
                  (tx) =>
                    fn(
                      new Proxy(tx, {
                        get(t, p, r) {
                          if (p === "residentEvent") {
                            return {
                              create: () =>
                                Promise.reject(new Error("history failed")),
                            };
                          }
                          return Reflect.get(t, p, r) as unknown;
                        },
                      }),
                    ),
                  opts as never,
                );
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

      it("leaves an award alone when its history line cannot be written", async () => {
        const awards = await import("../manageAwards");
        await publishYear();
        await unlock(R12);
        const award = await db.award.findFirstOrThrow({
          where: {
            academicYear: AY,
            userID: R12.id,
            title: "Outstanding Newcomer",
          },
        });

        await expect(
          awards.awardRemove(lossyHistory(), JCRC.id, award.id),
        ).rejects.toThrow("history failed");
        const after = await db.award.findUniqueOrThrow({
          where: { id: award.id },
        });
        expect(after.voidedAt ?? null).toBeNull();
        expect(
          (await events(R12)).filter((e) => e.action === "correction"),
        ).toHaveLength(0);

        // With a working history, both are written.
        await awards.awardRemove(db, JCRC.id, award.id);
        expect(
          (await db.award.findUniqueOrThrow({ where: { id: award.id } }))
            .voidedAt,
        ).not.toBeNull();
        expect(
          (await events(R12)).filter((e) => e.action === "correction"),
        ).toHaveLength(1);
      });

      it("leaves a roster entry and a manual entry alone when their history cannot be written", async () => {
        const roster = await import("../manageRoster");
        const manual = await import("../residentManual");
        await publishYear();
        await unlock(R12);

        await expect(
          roster.rosterUpsert(lossyHistory(), JCRC.id, {
            ccaID: SOCCER,
            academicYear: AY,
            userID: R12.id,
            roleLabel: "Vice-Captain",
          }),
        ).rejects.toThrow("history failed");
        expect((await entryOf(R12)).roleLabel ?? null).toBeNull();

        await expect(
          manual.manualSave(lossyHistory(), JCRC.id, {
            userID: R12.id,
            academicYear: AY,
            ccaID: DANCE,
            duration: "full",
          } as never),
        ).rejects.toThrow("history failed");
        expect(
          await db.manualMembership.count({
            where: { academicYear: AY, userID: R12.id, ccaID: DANCE },
          }),
        ).toBe(0);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("the retention registry", () => {
      it("purges the per-resident collections for one year only", async () => {
        const retention = await import("../retention");
        const OLD = "AY2025/26";
        await db.residentUnlock.create({
          data: {
            academicYear: OLD,
            userID: R12.id,
            reason: "old",
            activeKey: `${OLD}|${R12.id}`,
          },
        });
        await db.residentWithhold.create({
          data: {
            academicYear: OLD,
            userID: R12.id,
            reason: "old",
            activeKey: `${OLD}|${R12.id}`,
          },
        });
        await db.manualMembership.create({
          data: { academicYear: OLD, userID: R12.id, ccaID: SOCCER },
        });
        await db.residentEvent.create({
          data: { academicYear: OLD, userID: R12.id, action: "unlock" },
        });
        const keepEvents = await db.residentEvent.count({
          where: { academicYear: AY },
        });

        const purged = await retention.purgeAcademicYear(db, OLD);
        expect(purged).toMatchObject({
          ResidentUnlock: 1,
          ResidentWithhold: 1,
          ManualMembership: 1,
          ResidentEvent: 1,
        });
        expect(
          await db.residentEvent.count({ where: { academicYear: AY } }),
        ).toBe(keepEvents);
        expect(
          await db.manualMembership.count({ where: { academicYear: AY } }),
        ).toBe(1);
        await db.transcriptPeriod.deleteMany({ where: { academicYear: OLD } });
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a create or restore decided inside the transaction (U5)", () => {
      /** A db whose first transaction is preceded by `before` (a rival write). */
      const withRivalBeforeFirstTransaction = (
        before: () => Promise<unknown>,
      ) => {
        let started = 0;
        return new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return async (
                fn: (tx: unknown) => Promise<unknown>,
                opts?: unknown,
              ) => {
                started += 1;
                if (started === 1) await before();
                return (
                  target.$transaction as unknown as (
                    f: (tx: unknown) => Promise<unknown>,
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
      };

      it("a participation added by a double-submit is updated, not refused as a duplicate", async () => {
        const { participationSet } = await import("../residentData");
        const activity = await interHall();
        const input = {
          userID: R17.id,
          academicYear: AY,
          activityID: activity.id,
          role: "Reserve",
          description: "",
        };
        expect(
          await db.ccaActivityParticipant.count({
            where: { activityID: activity.id, userID: R17.id },
          }),
        ).toBe(0);

        // The same save lands first, after this call has looked and found no row.
        const racing = withRivalBeforeFirstTransaction(() =>
          participationSet(db, JCRC.id, { ...input, role: "Striker" }),
        );
        await participationSet(racing, JCRC.id, input);

        const rows = await db.ccaActivityParticipant.findMany({
          where: { activityID: activity.id, userID: R17.id },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.role).toBe("Reserve");
      });

      it("five identical saves at once leave one participation and no error", async () => {
        const { participationSet } = await import("../residentData");
        const activity = await interHall();
        const input = {
          userID: R17.id,
          academicYear: AY,
          activityID: activity.id,
          role: "Reserve",
          description: "",
        };

        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () => participationSet(db, JCRC.id, input)),
        );

        expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
        expect(
          await db.ccaActivityParticipant.count({
            where: { activityID: activity.id, userID: R17.id },
          }),
        ).toBe(1);
      });

      it("a manual entry removed meanwhile is not removed or logged again (V3)", async () => {
        const { manualRemove } = await import("../residentManual");
        const where = {
          academicYear_userID_ccaID: {
            academicYear: AY,
            userID: R17.id,
            ccaID: DANCE,
          },
        };
        const input = { userID: R17.id, academicYear: AY, ccaID: DANCE };
        const racing = withRivalBeforeFirstTransaction(() =>
          manualRemove(db, ADMIN.id, input),
        );
        const later = new Date(Date.now() + 3_600_000);

        await manualRemove(racing, JCRC.id, input, later);

        const row = await db.manualMembership.findUniqueOrThrow({ where });
        expect(row.removedBy).toBe(ADMIN.id);
        expect(row.removedAt?.getTime()).not.toBe(later.getTime());
        expect(
          (await events(R17)).filter((e) => e.action === "manual_remove"),
        ).toHaveLength(1);
      });

      it("a JCRC page removed meanwhile is not removed again", async () => {
        const { jcrcRemove } = await import("../manageRecords");
        const where = {
          academicYear_userID: { academicYear: AY, userID: JCRC.id },
        };
        const racing = withRivalBeforeFirstTransaction(() =>
          jcrcRemove(db, ADMIN.id, { userID: JCRC.id, academicYear: AY }),
        );
        const later = new Date(Date.now() + 3_600_000);

        await jcrcRemove(
          racing,
          JCRC.id,
          { userID: JCRC.id, academicYear: AY },
          later,
        );

        const row = await db.jcrcService.findUniqueOrThrow({ where });
        expect(row.removedBy).toBe(ADMIN.id);
        expect(row.removedAt?.getTime()).not.toBe(later.getTime());
      });

      it("refuses a correction whose resident is relocked after the guard passed, writing nothing (F4)", async () => {
        const roster = await import("../manageRoster");
        await publishYear();
        await unlock(R12);
        const relocking = withRivalBeforeFirstTransaction(() =>
          as(JCRC).transcriptManage.corrections.relock({
            userID: R12.id,
            academicYear: AY,
          }),
        );

        expect(
          await errorOf(
            roster.rosterUpsert(relocking, JCRC.id, {
              ccaID: SOCCER,
              academicYear: AY,
              userID: R12.id,
              roleLabel: "Vice-Captain",
            }),
          ),
        ).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        expect((await entryOf(R12)).roleLabel ?? null).toBeNull();
        expect((await events(R12)).map((e) => e.action)).toEqual([
          "unlock",
          "relock",
        ]);
      });

      it("a correction guard for one resident refuses a write that resolves to another (F61)", async () => {
        const records = await import("../residentRecords");
        await publishYear();
        await unlock(R12);
        const guard = await records.assertCanEditForResidents(
          db,
          { userID: JCRC.id },
          { ccaID: SOCCER, academicYear: AY, affectedUserIDs: [R12.id] },
        );

        expect(guard.correction).toBe(true);
        expect(() =>
          records.assertCheckedResidents(guard, [R12.id]),
        ).not.toThrow();
        expect(() => records.assertCheckedResidents(guard, [R20.id])).toThrow(
          "ONLY_UNLOCKED_RESIDENTS",
        );
      });

      it("refuses a participants correction when a change meanwhile adds an unchecked resident to the diff (F4)", async () => {
        const { participantsSet } = await import("../activities");
        await publishYear();
        await unlock(R12);
        const activity = await interHall();
        const rows = await db.ccaActivityParticipant.findMany({
          where: { activityID: activity.id },
        });
        // Only R12 changes, so the guard checks only R12...
        const participants = rows
          .filter((r) => !r.removedAt)
          .map((r) => ({
            userID: r.userID,
            role: r.userID === R12.id ? "Striker" : (r.role ?? ""),
            description: r.description ?? "",
          }));
        // ...but R17 is added meanwhile, so the write would remove R17 too.
        const racing = withRivalBeforeFirstTransaction(() =>
          db.ccaActivityParticipant.create({
            data: {
              activityID: activity.id,
              academicYear: AY,
              ccaID: SOCCER,
              userID: R17.id,
              addedBy: ADMIN.id,
              addedAt: new Date(),
            },
          }),
        );

        expect(
          await errorOf(
            participantsSet(racing, JCRC.id, {
              ccaID: SOCCER,
              id: activity.id,
              participants,
            }),
          ),
        ).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        const after = await db.ccaActivityParticipant.findMany({
          where: { activityID: activity.id },
        });
        expect(after.find((r) => r.userID === R12.id)?.role).toBe("Midfielder");
        expect(after.find((r) => r.userID === R17.id)?.removedAt ?? null).toBe(
          null,
        );
        expect(
          (await events(R12)).filter((e) => e.action === "correction"),
        ).toHaveLength(0);
      });
    });
    /* ---------------------------------------------------------------- */
    describe("who added each activity participant (F14)", () => {
      it("returns the names of who added and who last edited a participation", async () => {
        const list = () =>
          as(JCRC).transcriptManage.corrections.participation.list({
            userID: R12.id,
            academicYear: AY,
          });
        const before = (await list()).find(
          (i) => i.title === "Inter-hall league",
        );
        expect(before).toMatchObject({
          addedByName: "Seed Resident 04",
          updatedByName: null,
        });

        await as(JCRC).transcriptManage.corrections.participation.set({
          userID: R12.id,
          academicYear: AY,
          activityID: (await interHall()).id,
          role: "Striker",
          description: "",
        });
        const after = (await list()).find(
          (i) => i.title === "Inter-hall league",
        );
        expect(after).toMatchObject({
          addedByName: "Seed Resident 04",
          updatedByName: "Seed Resident 02",
        });
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a year that has not started (F17)", () => {
      const NEXT = "AY2027/28";

      it("refuses a manager's download-by date for the next year, and still sets the current one", async () => {
        const c = as(JCRC).transcript.periods;
        expect(
          await errorOf(
            c.setDownloadBy({ academicYear: NEXT, downloadBy: "2028-06-30" }),
          ),
        ).toBe("PRECONDITION_FAILED:YEAR_NOT_STARTED");
        expect(
          await db.transcriptPeriod.count({ where: { academicYear: NEXT } }),
        ).toBe(0);
        expect(
          await errorOf(
            c.setDownloadBy({ academicYear: AY, downloadBy: "2027-06-30" }),
          ),
        ).toBe("ok");
      });

      it("refuses an award for the next year, and still gives one for the current year", async () => {
        const colours = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        const give = (academicYear: string) =>
          as(JCRC).transcriptManage.awards.assign({
            academicYear,
            awardTypeID: colours.id,
            recipients: [{ userID: R20.id }],
          });
        expect(await errorOf(give(NEXT))).toBe(
          "PRECONDITION_FAILED:YEAR_NOT_STARTED",
        );
        expect(await db.award.count({ where: { academicYear: NEXT } })).toBe(0);
        expect(await errorOf(give(AY))).toBe("ok");
      });

      it("refuses a manager's activity and roster write for the next year, and still writes the current one", async () => {
        const manage = as(JCRC).transcriptManage;
        const activity = (academicYear: string) =>
          manage.activities.create({
            ccaID: SOCCER,
            academicYear,
            title: "Next year's league",
            description: "",
            period: "full",
          });
        const roster = (academicYear: string) =>
          manage.roster.upsert({
            ccaID: SOCCER,
            academicYear,
            userID: R12.id,
            extraContribution: "Kept the kit room tidy.",
          });
        expect(await errorOf(activity(NEXT))).toBe(
          "PRECONDITION_FAILED:YEAR_NOT_STARTED",
        );
        // The roster guard (residentRecords.ts) words this one as FORBIDDEN.
        expect(await errorOf(roster(NEXT))).toBe("FORBIDDEN:YEAR_NOT_STARTED");
        expect(
          await db.ccaActivity.count({ where: { academicYear: NEXT } }),
        ).toBe(0);
        expect(await errorOf(activity(AY))).toBe("ok");
        expect(await errorOf(roster(AY))).toBe("ok");
      });

      it("refuses to withhold a resident for the next year, and for a year before the start", async () => {
        const withhold = (academicYear: string) =>
          as(JCRC).transcriptManage.corrections.withhold({
            userID: R20.id,
            academicYear,
            reason: "Outstanding fees",
          });
        expect(await errorOf(withhold(NEXT))).toBe(
          "PRECONDITION_FAILED:YEAR_NOT_STARTED",
        );
        expect(await errorOf(withhold("AY2025/26"))).toBe(
          "BAD_REQUEST:YEAR_BEFORE_START",
        );
        expect(
          await db.residentWithhold.count({
            where: { academicYear: { in: [NEXT, "AY2025/26"] } },
          }),
        ).toBe(0);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a manual entry's role period without a role (F18)", () => {
      it("stores no role period without a role, and lets an old one go to Semester 2", async () => {
        const save = (fields: Record<string, unknown>) =>
          as(JCRC).transcriptManage.corrections.memberships.saveManual({
            userID: R20.id,
            academicYear: AY,
            ccaID: SOCCER,
            ...fields,
          } as never);
        const where = {
          academicYear_userID_ccaID: {
            academicYear: AY,
            userID: R20.id,
            ccaID: SOCCER,
          },
        };
        await save({ duration: "full", roleDuration: "sem1" });
        expect(
          (await db.manualMembership.findUniqueOrThrow({ where }))
            .roleDuration ?? null,
        ).toBeNull();

        // An entry saved before this rule, with the role period kept.
        await db.manualMembership.update({
          where,
          data: { roleDuration: "sem1" },
        });
        expect(await errorOf(save({ duration: "sem2" }))).toBe("ok");
        expect(
          await db.manualMembership.findUniqueOrThrow({ where }),
        ).toMatchObject({ duration: "sem2", roleDuration: null });
      });
    });
  },
);
