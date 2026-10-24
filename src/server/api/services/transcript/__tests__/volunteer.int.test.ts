import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAy2026Clock } from "./ayClock";
import { isLocalDevDatabase } from "./localDbGate";

/**
 * INTEGRATION TESTS of volunteer activities (sessions, people, attendance)
 * against the LOCAL development database (skipped unless DATABASE_URL is
 * localhost and the database is `rhapp_transcript_dev`; run `npm run test:db`).
 * The seed is re-run before every test. It gives RVC Children (9002, head R06)
 * "Weekly tuition" (10 weekly sessions of 2 hours from 2026-09-07; R12 attended
 * all, one of them for 1 hour, so 19 hours), RVC Special Projects (9001, head
 * R07) a one-off beach clean-up (4 hours), and a removed food drive.
 */

const AY = "AY2026/27";
const OLD = "AY2025/26";
const NOW = new Date("2026-10-16T04:00:00Z");

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const ADMIN = R(1, ["admin", "resident"]);
const JCRC = R(2, ["jcrc", "resident"]);
const SOCCER_HEAD = R(4, ["cca_head", "resident"]); // heads Soccer (9005), not volunteering
const CHILDREN_HEAD = R(6, ["cca_head", "resident"]); // heads RVC Children (9002)
const PROJECTS_HEAD = R(7, ["cca_head", "resident"]); // heads RVC Special Projects (9001)
const PLAIN = R(9, ["resident"]);
const SOCCER = 9005;
const CHILDREN = 9002;
const PROJECTS = 9001;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "volunteer activities (local database)",
  { timeout: 120_000 },
  () => {
    useAy2026Clock();

    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let retention: typeof import("../retention");
    let loader: typeof import("../loader");
    let assemble: typeof import("~/lib/transcript/assemble");
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
      }).transcriptManage.volunteer;

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
      retention = await import("../retention");
      loader = await import("../loader");
      assemble = await import("~/lib/transcript/assemble");
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

    const newActivity = (ccaID: number, over: object = {}) => ({
      ccaID,
      academicYear: AY,
      title: "New activity",
      description: "",
      kind: "regular" as const,
      ...over,
    });

    const tuition = () =>
      db.volunteerActivity.findFirstOrThrow({
        where: { ccaID: CHILDREN, title: { startsWith: "Weekly tuition" } },
      });
    /** Prisma's `field: null` misses absent fields on MongoDB. */
    const live = { OR: [{ removedAt: null }, { removedAt: { isSet: false } }] };
    const beach = () =>
      db.volunteerActivity.findFirstOrThrow({
        where: { ccaID: PROJECTS, kind: "oneoff", ...live },
      });
    const sessionsOf = (activityID: string) =>
      db.volunteerSession.findMany({
        where: { activityID },
        orderBy: { date: "asc" },
      });

    /** R12's total hours in an activity, as the transcript loader sees it. */
    const hoursOf = async (userID: string, title: string) => {
      const input = await loader.loadTranscriptInput(db, userID, AY, {
        now: NOW,
      });
      return input.volunteering.find((v) => v.title.startsWith(title))?.hours;
    };

    /* ---------------------------------------------------------------- */
    describe("a past year", () => {
      it("is read-only for a head in every volunteer write, and open to a manager (F31)", async () => {
        const oldActivity = await db.volunteerActivity.create({
          data: {
            academicYear: OLD,
            ccaID: CHILDREN,
            title: "Old tuition",
            kind: "regular",
            description: "",
            createdBy: ADMIN.id,
          },
        });
        const oldSession = await db.volunteerSession.create({
          data: {
            activityID: oldActivity.id,
            academicYear: OLD,
            ccaID: CHILDREN,
            date: new Date("2025-10-06T00:00:00Z"),
            hours: 2,
            createdBy: ADMIN.id,
          },
        });
        const ids = { activityID: oldActivity.id, ccaID: CHILDREN };
        const writes = (who: { id: string; roles: string[] }) => [
          () =>
            as(who).activities.update({
              id: oldActivity.id,
              ccaID: CHILDREN,
              title: "Old tuition (revised)",
              description: "",
              defaultHours: null,
            }),
          () => as(who).sessions.add({ ...ids, date: "2025-10-13", hours: 2 }),
          () => as(who).people.set({ ...ids, userIDs: ["SEED-R12"] }),
          () =>
            as(who).attendance.save({
              ...ids,
              changes: [
                {
                  sessionID: oldSession.id,
                  userID: "SEED-R12",
                  attended: true,
                },
              ],
            }),
        ];

        for (const write of writes(CHILDREN_HEAD)) {
          expect(await errorOf(write())).toBe("FORBIDDEN:NOT_THE_TERM_YEAR");
        }
        for (const write of writes(JCRC)) {
          expect(await errorOf(write())).toBe("ok");
        }
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a head of a volunteering CCA, for the term year", () => {
      it("creates, edits, removes and restores a regular activity, recording who and when", async () => {
        const head = as(CHILDREN_HEAD);
        const made = await head.activities.create(
          newActivity(CHILDREN, {
            title: "Reading club",
            description: "Weekly reading",
            defaultHours: 1.5,
          }),
        );

        let row = await db.volunteerActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row).toMatchObject({
          academicYear: AY,
          ccaID: CHILDREN,
          title: "Reading club",
          kind: "regular",
          defaultHours: 1.5,
          createdBy: CHILDREN_HEAD.id,
        });
        expect(await sessionsOf(made.id)).toHaveLength(0);

        await head.activities.update({
          id: made.id,
          ccaID: CHILDREN,
          title: "Reading club (revised)",
          description: "",
          defaultHours: null,
        });
        row = await db.volunteerActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row).toMatchObject({
          title: "Reading club (revised)",
          updatedBy: CHILDREN_HEAD.id,
        });
        expect(row.defaultHours ?? null).toBeNull();

        await head.activities.remove({ id: made.id, ccaID: CHILDREN });
        row = await db.volunteerActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row.removedAt).toBeTruthy();
        expect(row.removedBy).toBe(CHILDREN_HEAD.id);
        const live = await head.activities.list({
          ccaID: CHILDREN,
          academicYear: AY,
        });
        expect(live.activities.map((a) => a.id)).not.toContain(made.id);
        const all = await head.activities.list({
          ccaID: CHILDREN,
          academicYear: AY,
          includeRemoved: true,
        });
        expect(all.activities.find((a) => a.id === made.id)?.removed).toBe(
          true,
        );

        await head.activities.restore({ id: made.id, ccaID: CHILDREN });
        row = await db.volunteerActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row.removedAt ?? null).toBeNull();
      });

      it("lists the seeded activity with people, total hours and who made it", async () => {
        const list = await as(CHILDREN_HEAD).activities.list({
          ccaID: CHILDREN,
          academicYear: AY,
        });

        expect(list).not.toHaveProperty("max");
        expect(list.activeCount).toBe(1);
        const t = list.activities[0]!;
        expect(t.title).toMatch(/^Weekly tuition/);
        expect(t.kind).toBe("regular");
        expect(t.peopleCount).toBeGreaterThan(3);
        expect(t.createdByName).toBe("Seed Resident 06");
        // R12 19 + R06 16 + everyone else 10 each.
        expect(t.totalHours).toBeGreaterThan(35);
      });

      it("returns one activity in full for the grid", async () => {
        const t = await tuition();
        const detail = await as(CHILDREN_HEAD).activities.get({
          id: t.id,
          ccaID: CHILDREN,
        });

        expect(detail.sessions).toHaveLength(10);
        expect(detail.sessions[0]).toMatchObject({
          date: "2026-09-07",
          hours: 2,
          removed: false,
        });
        expect(detail.sessions[9]!.date).toBe("2026-11-09");
        expect(detail.totals["SEED-R12"]).toBe(19);
        expect(
          detail.cells.filter((c) => c.userID === "SEED-R12"),
        ).toHaveLength(10);
        expect(detail.cells.filter((c) => c.hoursOverride === 1)).toHaveLength(
          1,
        );
        for (const p of detail.people) expect(p.displayName).toBeTruthy();
      });

      it("adds sessions a week after the latest one with the same hours", async () => {
        const t = await tuition();
        const head = as(CHILDREN_HEAD);

        const added = await head.sessions.add({
          activityID: t.id,
          ccaID: CHILDREN,
        });
        expect(added).toMatchObject({ date: "2026-11-16", hours: 2 });

        const own = await head.sessions.add({
          activityID: t.id,
          ccaID: CHILDREN,
          date: "2026-12-01",
          hours: 1.25,
        });
        expect(own).toMatchObject({ date: "2026-12-01", hours: 1.25 });
        // The next default follows the LATEST date, not the last one added.
        const next = await head.sessions.add({
          activityID: t.id,
          ccaID: CHILDREN,
        });
        expect(next).toMatchObject({ date: "2026-12-08", hours: 1.25 });
      });

      it("stores a session's date as midnight in Singapore", async () => {
        const t = await tuition();
        const made = await as(CHILDREN_HEAD).sessions.add({
          activityID: t.id,
          ccaID: CHILDREN,
          date: "2026-12-01",
          hours: 1,
        });
        const row = await db.volunteerSession.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row.date.toISOString()).toBe("2026-11-30T16:00:00.000Z");
      });

      it("refuses a session outside the academic year", async () => {
        const t = await tuition();
        const head = as(CHILDREN_HEAD);
        for (const date of ["2026-07-31", "2027-08-01"]) {
          expect(
            await errorOf(
              head.sessions.add({ activityID: t.id, ccaID: CHILDREN, date }),
            ),
          ).toBe("BAD_REQUEST:DATE_OUTSIDE_ACADEMIC_YEAR");
        }
        const [first] = await sessionsOf(t.id);
        expect(
          await errorOf(
            head.sessions.update({
              sessionID: first!.id,
              ccaID: CHILDREN,
              date: "2027-08-01",
            }),
          ),
        ).toBe("BAD_REQUEST:DATE_OUTSIDE_ACADEMIC_YEAR");
        for (const date of ["2026-08-01", "2027-07-31"]) {
          expect(
            await errorOf(
              head.sessions.add({ activityID: t.id, ccaID: CHILDREN, date }),
            ),
          ).toBe("ok");
        }
      });

      it("edits, removes and restores a session; a removed session stops counting", async () => {
        const t = await tuition();
        const head = as(CHILDREN_HEAD);
        const [first, second] = await sessionsOf(t.id);
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(19);

        await head.sessions.update({
          sessionID: first!.id,
          ccaID: CHILDREN,
          hours: 3,
        });
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(20);

        await head.sessions.remove({ sessionID: second!.id, ccaID: CHILDREN });
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(18);
        const removed = await db.volunteerSession.findUniqueOrThrow({
          where: { id: second!.id },
        });
        expect(removed.removedAt).toBeTruthy();
        expect(removed.removedBy).toBe(CHILDREN_HEAD.id);

        await head.sessions.restore({ sessionID: second!.id, ccaID: CHILDREN });
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(20);
        // The tick rows were never deleted by removing the session.
        expect(
          await db.volunteerAttendance.count({
            where: { sessionID: second!.id },
          }),
        ).toBeGreaterThan(0);
      });

      it("will not edit a removed session or activity until restored", async () => {
        const t = await tuition();
        const head = as(CHILDREN_HEAD);
        const [first] = await sessionsOf(t.id);
        await head.sessions.remove({ sessionID: first!.id, ccaID: CHILDREN });
        expect(
          await errorOf(
            head.sessions.update({
              sessionID: first!.id,
              ccaID: CHILDREN,
              hours: 2,
            }),
          ),
        ).toBe("CONFLICT:SESSION_REMOVED");

        await head.activities.remove({ id: t.id, ccaID: CHILDREN });
        expect(
          await errorOf(
            head.activities.update({
              id: t.id,
              ccaID: CHILDREN,
              title: "x",
              description: "",
            }),
          ),
        ).toBe("CONFLICT:ACTIVITY_REMOVED");
        expect(
          await errorOf(
            head.sessions.add({ activityID: t.id, ccaID: CHILDREN }),
          ),
        ).toBe("CONFLICT:ACTIVITY_REMOVED");
      });

      it("refuses bad input before touching the database", async () => {
        const before = await db.volunteerActivity.count();
        const head = as(CHILDREN_HEAD);
        for (const bad of [
          { title: "   " },
          { title: "x".repeat(81) },
          { description: "x".repeat(301) },
          { defaultHours: 0.1 },
          { defaultHours: 25 },
          { kind: "weekly" },
          { title: "bad\u0000char" },
        ]) {
          expect(
            await errorOf(
              head.activities.create(newActivity(CHILDREN, bad) as never),
            ),
          ).toMatch(/^BAD_REQUEST:/);
        }
        expect(await db.volunteerActivity.count()).toBe(before);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("one-off activities", () => {
      it("is created with exactly one session, with a date and hours required", async () => {
        const head = as(PROJECTS_HEAD);
        expect(
          await errorOf(
            head.activities.create(newActivity(PROJECTS, { kind: "oneoff" })),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            head.activities.create(
              newActivity(PROJECTS, {
                kind: "oneoff",
                date: "2027-09-01",
                hours: 2,
              }),
            ),
          ),
        ).toMatch(/^BAD_REQUEST:/);

        const made = await head.activities.create(
          newActivity(PROJECTS, {
            title: "Blood drive",
            kind: "oneoff",
            date: "2026-11-05",
            hours: 3,
          }),
        );
        const sessions = await sessionsOf(made.id);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ hours: 3, ccaID: PROJECTS });
        expect(sessions[0]!.date.toISOString()).toBe(
          "2026-11-04T16:00:00.000Z",
        );
      });

      it("cannot get more sessions, or lose its only one", async () => {
        const b = await beach();
        const [only] = await sessionsOf(b.id);
        const head = as(PROJECTS_HEAD);

        expect(
          await errorOf(
            head.sessions.add({ activityID: b.id, ccaID: PROJECTS }),
          ),
        ).toBe("CONFLICT:ONEOFF_HAS_ONE_SESSION");
        expect(
          await errorOf(
            head.sessions.remove({ sessionID: only!.id, ccaID: PROJECTS }),
          ),
        ).toBe("CONFLICT:ONEOFF_HAS_ONE_SESSION");
        expect(await sessionsOf(b.id)).toHaveLength(1);
      });

      it("can change its date and hours through the activity", async () => {
        const b = await beach();
        await as(PROJECTS_HEAD).activities.update({
          id: b.id,
          ccaID: PROJECTS,
          title: b.title,
          description: "",
          date: "2026-09-19",
          hours: 5,
        });
        const [only] = await sessionsOf(b.id);
        expect(only).toMatchObject({ hours: 5 });
        expect(only!.date.toISOString()).toBe("2026-09-18T16:00:00.000Z");
        expect(await hoursOf("SEED-R12", "Beach clean-up")).toBe(5);
      });

      it("refuses a date or hours on a regular activity's update", async () => {
        const t = await tuition();
        expect(
          await errorOf(
            as(CHILDREN_HEAD).activities.update({
              id: t.id,
              ccaID: CHILDREN,
              title: "x",
              description: "",
              hours: 2,
            }),
          ),
        ).toBe("BAD_REQUEST:DATE_ONLY_FOR_ONEOFF");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("who may write", () => {
      it("refuses the head of an ordinary CCA: it is not a volunteering CCA", async () => {
        expect(
          await errorOf(as(SOCCER_HEAD).activities.create(newActivity(SOCCER))),
        ).toBe("PRECONDITION_FAILED:NOT_A_VOLUNTEERING_CCA");
      });

      it("refuses the head of one volunteering CCA on another, and a plain resident", async () => {
        const t = await tuition();
        expect(
          await errorOf(
            as(PROJECTS_HEAD).activities.create(newActivity(CHILDREN)),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(
          await errorOf(
            as(PROJECTS_HEAD).activities.remove({ id: t.id, ccaID: CHILDREN }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(
          await errorOf(
            as(PLAIN).activities.list({ ccaID: CHILDREN, academicYear: AY }),
          ),
        ).toMatch(/^FORBIDDEN:/);
        expect(
          await errorOf(
            as(null).activities.list({ ccaID: CHILDREN, academicYear: AY }),
          ),
        ).toMatch(/^UNAUTHORIZED:/);
      });

      it("will not touch an activity through another CCA's id", async () => {
        const t = await tuition();
        const head = as(PROJECTS_HEAD);
        expect(
          await errorOf(
            head.activities.update({
              id: t.id,
              ccaID: PROJECTS,
              title: "Hijack",
              description: "",
            }),
          ),
        ).toBe("NOT_FOUND:ACTIVITY_NOT_FOUND");
        const [session] = await sessionsOf(t.id);
        expect(
          await errorOf(
            head.sessions.update({
              sessionID: session!.id,
              ccaID: PROJECTS,
              hours: 1,
            }),
          ),
        ).toBe("NOT_FOUND:SESSION_NOT_FOUND");
        expect(
          await errorOf(
            head.attendance.save({
              activityID: t.id,
              ccaID: PROJECTS,
              changes: [],
            }),
          ),
        ).toBe("NOT_FOUND:ACTIVITY_NOT_FOUND");
      });

      it("refuses a CCA that is no longer tagged, even for a manager, but still reads and renders it", async () => {
        const t = await tuition();
        const [session] = await sessionsOf(t.id);
        await db.ccaProfile.update({
          where: { ccaID: CHILDREN },
          data: { isVolunteering: false },
        });

        const refused = "PRECONDITION_FAILED:NOT_A_VOLUNTEERING_CCA";
        expect(
          await errorOf(as(JCRC).activities.create(newActivity(CHILDREN))),
        ).toBe(refused);
        expect(
          await errorOf(
            as(JCRC).activities.update({
              id: t.id,
              ccaID: CHILDREN,
              title: "x",
              description: "",
            }),
          ),
        ).toBe(refused);
        expect(
          await errorOf(
            as(JCRC).activities.remove({ id: t.id, ccaID: CHILDREN }),
          ),
        ).toBe(refused);
        expect(
          await errorOf(
            as(JCRC).sessions.add({ activityID: t.id, ccaID: CHILDREN }),
          ),
        ).toBe(refused);
        expect(
          await errorOf(
            as(JCRC).sessions.remove({
              sessionID: session!.id,
              ccaID: CHILDREN,
            }),
          ),
        ).toBe(refused);
        expect(
          await errorOf(
            as(JCRC).people.set({
              activityID: t.id,
              ccaID: CHILDREN,
              userIDs: [],
            }),
          ),
        ).toBe(refused);
        expect(
          await errorOf(
            as(JCRC).attendance.save({
              activityID: t.id,
              ccaID: CHILDREN,
              changes: [],
            }),
          ),
        ).toBe(refused);

        // Reading still works, and the transcript still shows the hours.
        expect(
          (
            await as(CHILDREN_HEAD).activities.list({
              ccaID: CHILDREN,
              academicYear: AY,
            })
          ).activities,
        ).toHaveLength(1);
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(19);
      });

      it("refuses everyone once the year is published", async () => {
        const t = await tuition();
        const [session] = await sessionsOf(t.id);
        await db.transcriptPeriod.update({
          where: { academicYear: AY },
          data: {
            status: "published",
            publishedAt: new Date(),
            publishedBy: ADMIN.id,
          },
        });
        const denied = "PRECONDITION_FAILED:PERIOD_PUBLISHED";

        for (const who of [CHILDREN_HEAD, JCRC, ADMIN]) {
          const v = as(who);
          const calls = [
            () => v.activities.create(newActivity(CHILDREN)),
            () =>
              v.activities.update({
                id: t.id,
                ccaID: CHILDREN,
                title: "x",
                description: "",
              }),
            () => v.activities.remove({ id: t.id, ccaID: CHILDREN }),
            () => v.activities.restore({ id: t.id, ccaID: CHILDREN }),
            () => v.sessions.add({ activityID: t.id, ccaID: CHILDREN }),
            () =>
              v.sessions.update({
                sessionID: session!.id,
                ccaID: CHILDREN,
                hours: 1,
              }),
            () =>
              v.sessions.remove({ sessionID: session!.id, ccaID: CHILDREN }),
            () =>
              v.people.set({ activityID: t.id, ccaID: CHILDREN, userIDs: [] }),
            () =>
              v.attendance.save({
                activityID: t.id,
                ccaID: CHILDREN,
                changes: [],
              }),
          ];
          for (const call of calls) {
            const result = await errorOf(call());
            const isPeopleSet = call === calls[7];
            // Taking people off is a per-resident correction for a manager.
            expect(result).toBe(
              isPeopleSet && who !== CHILDREN_HEAD
                ? "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS"
                : denied,
            );
          }
        }
        expect(
          (
            await as(CHILDREN_HEAD).activities.list({
              ccaID: CHILDREN,
              academicYear: AY,
            })
          ).activeCount,
        ).toBe(1);
      });

      it("lets a manager write to any volunteering CCA", async () => {
        expect(
          await errorOf(as(ADMIN).activities.create(newActivity(CHILDREN))),
        ).toBe("ok");
        expect(
          await errorOf(as(JCRC).activities.create(newActivity(PROJECTS))),
        ).toBe("ok");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("limits", () => {
      const fill = async (n: number) => {
        const have = await db.volunteerActivity.count({
          where: { ccaID: CHILDREN, academicYear: AY, ...live },
        });
        for (let i = have; i < n; i += 1) {
          await db.volunteerActivity.create({
            data: {
              academicYear: AY,
              ccaID: CHILDREN,
              title: `Filler ${i}`,
              kind: "regular",
              createdBy: CHILDREN_HEAD.id,
              createdAt: new Date(),
            },
          });
        }
      };

      it("takes far more than 30 volunteer activities, and restores whatever the count", async () => {
        await fill(35);
        const head = as(CHILDREN_HEAD);
        expect(
          await errorOf(head.activities.create(newActivity(CHILDREN))),
        ).toBe("ok");
        const victim = await db.volunteerActivity.findFirstOrThrow({
          where: { ccaID: CHILDREN, title: "Filler 5" },
        });
        await head.activities.remove({ id: victim.id, ccaID: CHILDREN });
        await head.activities.create(newActivity(CHILDREN));
        expect(
          await errorOf(
            head.activities.restore({ id: victim.id, ccaID: CHILDREN }),
          ),
        ).toBe("ok");
      }, 120_000);

      it("takes more than 120 sessions, and restores one whatever the count", async () => {
        const t = await tuition();
        const have = await db.volunteerSession.count({
          where: { activityID: t.id, ...live },
        });
        await db.volunteerSession.createMany({
          data: Array.from({ length: 125 - have }, (_, i) => ({
            activityID: t.id,
            academicYear: AY,
            ccaID: CHILDREN,
            date: new Date(Date.UTC(2027, 0, 1 + (i % 28))),
            hours: 1,
          })),
        });
        const head = as(CHILDREN_HEAD);
        expect(
          await errorOf(
            head.sessions.add({ activityID: t.id, ccaID: CHILDREN }),
          ),
        ).toBe("ok");
        const [first] = await sessionsOf(t.id);
        await head.sessions.remove({ sessionID: first!.id, ccaID: CHILDREN });
        await head.sessions.add({ activityID: t.id, ccaID: CHILDREN });
        expect(
          await errorOf(
            head.sessions.restore({ sessionID: first!.id, ccaID: CHILDREN }),
          ),
        ).toBe("ok");
      });

      it("keeps only hidden safety caps far above real use", async () => {
        const t = await tuition();
        const have = await db.volunteerSession.count({
          where: { activityID: t.id, ...live },
        });
        await db.volunteerSession.createMany({
          data: Array.from({ length: 1000 - have }, (_, i) => ({
            activityID: t.id,
            academicYear: AY,
            ccaID: CHILDREN,
            date: new Date(Date.UTC(2027, 0, 1 + (i % 28))),
            hours: 1,
          })),
        });
        expect(
          await errorOf(
            as(CHILDREN_HEAD).sessions.add({
              activityID: t.id,
              ccaID: CHILDREN,
            }),
          ),
        ).toBe("CONFLICT:TOO_MANY_AT_ONCE");
      }, 120_000);
    });

    /* ---------------------------------------------------------------- */
    describe("people", () => {
      const set = (userIDs: string[], who = CHILDREN_HEAD) =>
        (async () =>
          as(who).people.set({
            activityID: (await tuition()).id,
            ccaID: CHILDREN,
            userIDs,
          }))();
      const rows = async () =>
        db.volunteerPerson.findMany({
          where: { activityID: (await tuition()).id },
        });

      it("adds anyone in the hall, and soft-removes the people left out", async () => {
        const before = await rows();
        const live = before.filter((p) => !p.removedAt).map((p) => p.userID);
        expect(live).toContain("SEED-R12");

        const result = await set(["SEED-R12", "SEED-R03"]);

        expect(result.added).toBe(1);
        expect(result.removed).toBe(live.length - 1);
        const after = await rows();
        expect(after).toHaveLength(before.length + 1);
        expect(
          after
            .filter((p) => !p.removedAt)
            .map((p) => p.userID)
            .sort(),
        ).toEqual(["SEED-R03", "SEED-R12"]);
        expect(after.find((p) => p.userID === "SEED-R03")).toMatchObject({
          addedBy: CHILDREN_HEAD.id,
        });
      });

      it("rejects a resident who does not exist, changing nothing", async () => {
        const before = await rows();
        expect(await errorOf(set(["SEED-R12", "NO-SUCH-RESIDENT"]))).toBe(
          "NOT_FOUND:RESIDENT_NOT_FOUND",
        );
        expect(await rows()).toEqual(before);
      });

      it("rejects the same person twice, and only past the hidden cap in number", async () => {
        expect(await errorOf(set(["SEED-R12", "SEED-R12"]))).toBe(
          "BAD_REQUEST:DUPLICATE_PARTICIPANT",
        );
        const many = (n: number) =>
          Array.from({ length: n }, (_, i) => `SEED-R${i}`);
        // 301 people are not refused for their number (these residents do not exist).
        expect(await errorOf(set(many(301)))).toBe(
          "NOT_FOUND:RESIDENT_NOT_FOUND",
        );
        expect(await errorOf(set(many(2001)))).toMatch(/^BAD_REQUEST:/);
      });

      it("keeps a removed person's ticks but stops counting them, and brings them back", async () => {
        const t = await tuition();
        const ticksBefore = await db.volunteerAttendance.count({
          where: { activityID: t.id, userID: "SEED-R12" },
        });
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(19);

        await set(["SEED-R06"]);
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBeUndefined();
        expect(
          await db.volunteerAttendance.count({
            where: { activityID: t.id, userID: "SEED-R12" },
          }),
        ).toBe(ticksBefore);
        const detail = await as(CHILDREN_HEAD).activities.get({
          id: t.id,
          ccaID: CHILDREN,
        });
        expect(detail.people.map((p) => p.userID)).toEqual(["SEED-R06"]);
        expect(detail.cells.every((c) => c.userID === "SEED-R06")).toBe(true);

        await set(["SEED-R06", "SEED-R12"]);
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(19);
        const all = await rows();
        expect(all.filter((p) => p.userID === "SEED-R12")).toHaveLength(1);
      });

      it("writes no history line for a removal someone else made between the guard and the write (F60)", async () => {
        const { volunteerPeopleSet } = await import("../manageVolunteer");
        const t = await tuition();
        // The head is on the list, then drops themself. Before the write,
        // another manager removes them first, so this call removes nobody.
        await set(["SEED-R12", CHILDREN_HEAD.id]);
        const racing = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return async (...args: unknown[]) => {
                await db.volunteerPerson.updateMany({
                  where: { activityID: t.id, userID: CHILDREN_HEAD.id },
                  data: { removedAt: new Date(), removedBy: ADMIN.id },
                });
                return (
                  target.$transaction as unknown as (
                    ...a: unknown[]
                  ) => Promise<unknown>
                )(...args);
              };
            }
            const value: unknown = Reflect.get(target, prop, receiver);
            return typeof value === "function"
              ? (value as (...a: unknown[]) => unknown).bind(target)
              : value;
          },
        }) as PrismaClient;

        const result = await volunteerPeopleSet(racing, CHILDREN_HEAD.id, {
          activityID: t.id,
          ccaID: CHILDREN,
          userIDs: ["SEED-R12"],
        });

        expect(result).toMatchObject({ removed: 0 });
        expect(
          await db.residentEvent.count({
            where: {
              userID: CHILDREN_HEAD.id,
              academicYear: AY,
              summary: { contains: "removed" },
            },
          }),
        ).toBe(0);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("attendance.save", () => {
      const detail = async () =>
        as(CHILDREN_HEAD).activities.get({
          id: (await tuition()).id,
          ccaID: CHILDREN,
        });

      it("rejects the WHOLE batch when one change is invalid, changing nothing", async () => {
        const t = await tuition();
        const d = await detail();
        const [s0, s1] = d.sessions;
        const before = await db.volunteerAttendance.findMany({
          where: { activityID: t.id },
          orderBy: { id: "asc" },
        });

        for (const bad of [
          { sessionID: s1!.id, userID: "SEED-R03", attended: true }, // not a person
          { sessionID: "f".repeat(24), userID: "SEED-R12", attended: true }, // no such session
        ]) {
          expect(
            await errorOf(
              as(CHILDREN_HEAD).attendance.save({
                activityID: t.id,
                ccaID: CHILDREN,
                changes: [
                  { sessionID: s0!.id, userID: "SEED-R12", attended: false }, // valid
                  bad,
                ],
              }),
            ),
          ).toBe("BAD_REQUEST:INVALID_ATTENDANCE");
        }
        expect(
          await db.volunteerAttendance.findMany({
            where: { activityID: t.id },
            orderBy: { id: "asc" },
          }),
        ).toEqual(before);
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(19);
      });

      it("rejects a tick on a removed session or for a removed person", async () => {
        const t = await tuition();
        const d = await detail();
        const [s0, s1] = d.sessions;
        await as(CHILDREN_HEAD).sessions.remove({
          sessionID: s0!.id,
          ccaID: CHILDREN,
        });
        expect(
          await errorOf(
            as(CHILDREN_HEAD).attendance.save({
              activityID: t.id,
              ccaID: CHILDREN,
              changes: [
                { sessionID: s0!.id, userID: "SEED-R12", attended: true },
              ],
            }),
          ),
        ).toBe("BAD_REQUEST:INVALID_ATTENDANCE");

        await as(CHILDREN_HEAD).people.set({
          activityID: t.id,
          ccaID: CHILDREN,
          userIDs: ["SEED-R06"],
        });
        expect(
          await errorOf(
            as(CHILDREN_HEAD).attendance.save({
              activityID: t.id,
              ccaID: CHILDREN,
              changes: [
                { sessionID: s1!.id, userID: "SEED-R12", attended: true },
              ],
            }),
          ),
        ).toBe("BAD_REQUEST:INVALID_ATTENDANCE");
      });

      it("rejects the same cell twice and a bad override", async () => {
        const t = await tuition();
        const d = await detail();
        const s0 = d.sessions[0]!;
        expect(
          await errorOf(
            as(CHILDREN_HEAD).attendance.save({
              activityID: t.id,
              ccaID: CHILDREN,
              changes: [
                { sessionID: s0.id, userID: "SEED-R12", attended: false },
                { sessionID: s0.id, userID: "SEED-R12", attended: true },
              ],
            }),
          ),
        ).toBe("BAD_REQUEST:DUPLICATE_CHANGE");
        for (const hoursOverride of [0, 0.1, 25]) {
          expect(
            await errorOf(
              as(CHILDREN_HEAD).attendance.save({
                activityID: t.id,
                ccaID: CHILDREN,
                changes: [
                  {
                    sessionID: s0.id,
                    userID: "SEED-R12",
                    attended: true,
                    hoursOverride,
                  },
                ],
              }),
            ),
          ).toMatch(/^BAD_REQUEST:/);
        }
      });

      it("applies a valid batch: un-tick, tick, override, clear override", async () => {
        const t = await tuition();
        const d = await detail();
        const [s0, s1, s2] = d.sessions;
        // Seed: R12 ticked in all ten, 1 hour on the third session.
        const result = await as(CHILDREN_HEAD).attendance.save({
          activityID: t.id,
          ccaID: CHILDREN,
          changes: [
            { sessionID: s0!.id, userID: "SEED-R12", attended: false },
            {
              sessionID: s1!.id,
              userID: "SEED-R12",
              attended: true,
              hoursOverride: 0.5,
            },
            {
              sessionID: s2!.id,
              userID: "SEED-R12",
              attended: true,
              hoursOverride: null,
            },
          ],
        });

        expect(result).toEqual({ created: 0, updated: 2, deleted: 1 });
        // 19 - 2 (s0 unticked) - 1.5 (s1 2h -> 0.5h) + 1 (s2 1h -> 2h) = 16.5
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(16.5);
        const row = await db.volunteerAttendance.findFirstOrThrow({
          where: { sessionID: s1!.id, userID: "SEED-R12" },
        });
        expect(row).toMatchObject({
          hoursOverride: 0.5,
          markedBy: CHILDREN_HEAD.id,
        });
        expect(row.markedAt).toBeTruthy();
      });

      it("leaves an override alone when a tick omits it, and creates new ticks", async () => {
        const t = await tuition();
        const d = await detail();
        const s2 = d.sessions[2]!; // R12 has the 1-hour override here
        const result = await as(CHILDREN_HEAD).attendance.save({
          activityID: t.id,
          ccaID: CHILDREN,
          changes: [
            { sessionID: s2.id, userID: "SEED-R12", attended: true },
            {
              sessionID: d.sessions[9]!.id,
              userID: "SEED-R06",
              attended: true,
            },
          ],
        });
        expect(result).toEqual({ created: 1, updated: 0, deleted: 0 });
        expect(
          (
            await db.volunteerAttendance.findFirstOrThrow({
              where: { sessionID: s2.id, userID: "SEED-R12" },
            })
          ).hoursOverride,
        ).toBe(1);
      });

      it("handles a large batch in one request", async () => {
        const t = await tuition();
        const d = await detail();
        const changes = d.sessions.flatMap((s) =>
          d.people.map((p) => ({
            sessionID: s.id,
            userID: p.userID,
            attended: true as const,
          })),
        );
        await as(CHILDREN_HEAD).attendance.save({
          activityID: t.id,
          ccaID: CHILDREN,
          changes,
        });
        expect(
          await db.volunteerAttendance.count({ where: { activityID: t.id } }),
        ).toBe(d.sessions.length * d.people.length);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("on the transcript", () => {
      it("matches the hours the head sees, per person and activity", async () => {
        const t = await tuition();
        const d = await as(CHILDREN_HEAD).activities.get({
          id: t.id,
          ccaID: CHILDREN,
        });
        for (const p of d.people) {
          expect(await hoursOf(p.userID, "Weekly tuition")).toBe(
            d.totals[p.userID] || undefined,
          );
        }
        expect(await hoursOf("SEED-R12", "Beach clean-up")).toBe(4);
      });

      it("renders one row per activity with Regular / One-off, the CCA and total hours", async () => {
        const input = await loader.loadTranscriptInput(db, "SEED-R12", AY, {
          now: NOW,
        });
        const vm = assemble.assembleTranscript(input, AY);
        const main = vm.pages[0] as {
          sections: Array<{
            kind: string;
            volunteer?: { rows: unknown[]; total: number };
          }>;
        };
        const section = main.sections.find((s) => s.kind === "volunteerHours")!;
        expect(section.volunteer!.rows).toEqual([
          {
            activity: "Weekly tuition for neighbourhood children",
            type: "Regular",
            organiser: "RVC Children",
            hours: 19,
          },
          {
            activity: "Beach clean-up, East Coast Park",
            type: "One-off",
            organiser: "RVC Special Projects",
            hours: 4,
          },
        ]);
        expect(section.volunteer!.total).toBe(23);
      });

      it("leaves out a removed activity, even for someone ticked in it", async () => {
        const input = await loader.loadTranscriptInput(db, "SEED-R12", AY, {
          now: NOW,
        });
        expect(input.volunteering.map((v) => v.title)).not.toContain(
          "Cancelled food drive",
        );
        const t = await tuition();
        await as(CHILDREN_HEAD).activities.remove({
          id: t.id,
          ccaID: CHILDREN,
        });
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBeUndefined();
        await as(CHILDREN_HEAD).activities.restore({
          id: t.id,
          ccaID: CHILDREN,
        });
        expect(await hoursOf("SEED-R12", "Weekly tuition")).toBe(19);
      });

      it("shows nothing for someone not on the activity, and nothing for another year", async () => {
        expect(await hoursOf("SEED-R19", "Weekly tuition")).toBeUndefined();
        const old = await loader.loadTranscriptInput(db, "SEED-R12", OLD, {
          now: NOW,
        });
        expect(old.volunteering).toEqual([]);
      });

      it("credits an outsider who is ticked, and a person with no ticks gets no row", async () => {
        const t = await tuition();
        await as(CHILDREN_HEAD).people.set({
          activityID: t.id,
          ccaID: CHILDREN,
          userIDs: ["SEED-R12", "SEED-R03", "SEED-R19"],
        });
        const d = await as(CHILDREN_HEAD).activities.get({
          id: t.id,
          ccaID: CHILDREN,
        });
        await as(CHILDREN_HEAD).attendance.save({
          activityID: t.id,
          ccaID: CHILDREN,
          changes: [
            {
              sessionID: d.sessions[0]!.id,
              userID: "SEED-R03",
              attended: true,
            },
            {
              sessionID: d.sessions[1]!.id,
              userID: "SEED-R03",
              attended: true,
              hoursOverride: 1,
            },
          ],
        });
        expect(await hoursOf("SEED-R03", "Weekly tuition")).toBe(3);
        expect(await hoursOf("SEED-R19", "Weekly tuition")).toBeUndefined();
      });
    });

    /* ---------------------------------------------------------------- */
    describe("purging a year", () => {
      it("removes that year's volunteer data and leaves the others", async () => {
        const old = await db.volunteerActivity.create({
          data: {
            academicYear: OLD,
            ccaID: CHILDREN,
            title: "Last year's tuition",
            kind: "regular",
            createdBy: CHILDREN_HEAD.id,
          },
        });
        const session = await db.volunteerSession.create({
          data: {
            activityID: old.id,
            academicYear: OLD,
            ccaID: CHILDREN,
            date: new Date("2025-10-01T00:00:00Z"),
            hours: 2,
          },
        });
        await db.volunteerPerson.create({
          data: {
            activityID: old.id,
            academicYear: OLD,
            ccaID: CHILDREN,
            userID: "SEED-R12",
          },
        });
        await db.volunteerAttendance.create({
          data: {
            sessionID: session.id,
            activityID: old.id,
            academicYear: OLD,
            ccaID: CHILDREN,
            userID: "SEED-R12",
          },
        });
        const current = {
          activities: await db.volunteerActivity.count({
            where: { academicYear: AY },
          }),
          sessions: await db.volunteerSession.count({
            where: { academicYear: AY },
          }),
          people: await db.volunteerPerson.count({
            where: { academicYear: AY },
          }),
          attendance: await db.volunteerAttendance.count({
            where: { academicYear: AY },
          }),
        };

        const dry = await retention.purgeAcademicYear(db, OLD, {
          dryRun: true,
        });
        expect(dry).toMatchObject({
          VolunteerActivity: 1,
          VolunteerSession: 1,
          VolunteerPerson: 1,
          VolunteerAttendance: 1,
        });
        const purged = await retention.purgeAcademicYear(db, OLD);
        expect(purged).toMatchObject({
          VolunteerActivity: 1,
          VolunteerSession: 1,
          VolunteerPerson: 1,
          VolunteerAttendance: 1,
        });

        expect(
          await db.volunteerActivity.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(
          await db.volunteerSession.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(
          await db.volunteerPerson.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(
          await db.volunteerAttendance.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect({
          activities: await db.volunteerActivity.count({
            where: { academicYear: AY },
          }),
          sessions: await db.volunteerSession.count({
            where: { academicYear: AY },
          }),
          people: await db.volunteerPerson.count({
            where: { academicYear: AY },
          }),
          attendance: await db.volunteerAttendance.count({
            where: { academicYear: AY },
          }),
        }).toEqual(current);
      });
    });
  },
);
