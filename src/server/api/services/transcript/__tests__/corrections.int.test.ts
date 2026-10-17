import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * INTEGRATION TESTS of per-resident corrections against the LOCAL development
 * database (skipped unless DATABASE_URL is localhost and the database is
 * `rhapp_transcript_dev`; run `npm run test:db`). The seed is re-run before every
 * test. Each test closes and publishes the seeded year itself, with the same
 * procedures the admin buttons call, then works on a PUBLISHED year.
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
          "PRECONDITION_FAILED:YEAR_NOT_IN_REVIEW",
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
  },
);
