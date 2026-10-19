import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APR_2027, useAy2026Clock } from "./ayClock";
import { isLocalDevDatabase } from "./localDbGate";

/**
 * LOAD TEST of year-scoped writes (T1 of the S2 re-review) against the LOCAL
 * development database (skipped unless DATABASE_URL is localhost and the
 * database is `rhapp_transcript_dev`; run `npm run test:db`).
 *
 * Every year-scoped save ends by touching the year's period row. Before T1 the
 * touch came FIRST, so one long save held that row for its whole transaction
 * and other saves of the year, in any CCA, failed after their few short
 * retries. Here 20 ordinary saves across the seed CCAs run at the same moment
 * as one large attendance save (4,000 cells: 2,000 new ticks and 2,000 hour
 * overrides, written in batches since T9), and every one must land. Then the same load runs
 * with Open transcripts started in the middle of it: Open must complete, and
 * each save either landed or was refused because the year opened, never a
 * "busy" or raw error, and a refused save wrote nothing.
 */

const AY = "AY2026/27";
const ADMIN = "SEED-R01";
const JCRC = "SEED-R02";
const CHILDREN = 9002; // RVC Children, a volunteering CCA
const SEED_CCAS = Array.from({ length: 14 }, (_, i) => 9001 + i);
const ORDINARY_SAVES = 20;
const PEOPLE = 40;
const SESSIONS = 100;

type Outcome = { label: string; ms: number; result: string };

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "year-scoped writes under load (local database)",
  { timeout: 300_000 },
  () => {
    useAy2026Clock();

    let db: PrismaClient;
    let activities: typeof import("../activities");
    let volunteer: typeof import("../manageVolunteer");
    let periods: typeof import("../periods");

    const reseed = () =>
      execFileSync(process.execPath, ["scripts/dev/seed-transcript.mjs"], {
        stdio: "pipe",
      });

    beforeAll(async () => {
      ({ db } = await import("~/server/db"));
      activities = await import("../activities");
      volunteer = await import("../manageVolunteer");
      periods = await import("../periods");
    });

    beforeEach(() => {
      reseed();
    });

    afterAll(() => {
      reseed();
    });

    /** Time one save; its result is "ok" or "CODE:MESSAGE". */
    const timed = async (
      label: string,
      run: () => Promise<unknown>,
    ): Promise<Outcome> => {
      const started = performance.now();
      try {
        await run();
        return { label, ms: performance.now() - started, result: "ok" };
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return {
          label,
          ms: performance.now() - started,
          result: `${e.code}:${e.message}`,
        };
      }
    };

    /**
     * A volunteer activity with PEOPLE people and SESSIONS sessions, half of
     * whose cells are already ticked, and the 4,000-cell change that ticks the
     * other half and sets an hour override on every existing tick.
     */
    const bigGrid = async () => {
      const activity = await db.volunteerActivity.create({
        data: {
          academicYear: AY,
          ccaID: CHILDREN,
          title: "Load test tuition",
          kind: "regular",
          createdBy: ADMIN,
        },
      });
      const base = {
        activityID: activity.id,
        academicYear: AY,
        ccaID: CHILDREN,
      };
      await db.volunteerSession.createMany({
        data: Array.from({ length: SESSIONS }, (_, i) => ({
          ...base,
          date: new Date(Date.UTC(2026, 7, 3 + (i % 300))),
          hours: 2,
        })),
      });
      const sessions = await db.volunteerSession.findMany({
        where: { activityID: activity.id },
        select: { id: true },
      });
      const people = Array.from(
        { length: PEOPLE },
        (_, i) => `LOAD-P${String(i).padStart(2, "0")}`,
      );
      await db.volunteerPerson.createMany({
        data: people.map((userID) => ({ ...base, userID, addedBy: ADMIN })),
      });
      const cells = sessions.flatMap((s) =>
        people.map((userID) => ({ sessionID: s.id, userID })),
      );
      const ticked = cells.filter((_, i) => i % 2 === 0);
      await db.volunteerAttendance.createMany({
        data: ticked.map((c) => ({ ...base, ...c, markedBy: ADMIN })),
      });
      const changes = cells.map((c, i) =>
        i % 2 === 0
          ? { ...c, attended: true, hoursOverride: 1.5 }
          : { ...c, attended: true },
      );
      return { activityID: activity.id, changes };
    };

    /** The 20 ordinary saves: a new activity each, across the seed CCAs. */
    const ordinarySaves = (tag: string) =>
      Array.from({ length: ORDINARY_SAVES }, (_, i) => {
        const ccaID = SEED_CCAS[i % SEED_CCAS.length]!;
        const title = `${tag} ${i}`;
        return {
          title,
          run: () =>
            timed(`activity ${i} (CCA ${ccaID})`, () =>
              activities.activityCreate(db, ADMIN, {
                ccaID,
                academicYear: AY,
                title,
                description: "",
                period: "full",
              }),
            ),
        };
      });

    const report = (name: string, outcomes: Outcome[], extra = "") => {
      const ordinary = outcomes.filter((o) => o.label.startsWith("activity"));
      const big = outcomes.find((o) => o.label === "attendance")!;
      const ms = ordinary.map((o) => o.ms).sort((a, b) => a - b);
      const line = [
        `[load] ${name}:`,
        `ordinary saves min ${ms[0]!.toFixed(0)} ms,`,
        `median ${ms[Math.floor(ms.length / 2)]!.toFixed(0)} ms,`,
        `max ${ms.at(-1)!.toFixed(0)} ms;`,
        `large attendance save ${big.ms.toFixed(0)} ms (${big.result})`,
        extra,
      ].join(" ");
      console.info(line);
    };

    it("one 4,000-cell attendance save on its own is a single attempt of under 3 s (T9)", async () => {
      const grid = await bigGrid();
      let attempts = 0;
      const counted = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "$transaction") {
            attempts += 1;
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as PrismaClient;
      const outcome = await timed("attendance", () =>
        volunteer.volunteerAttendanceSave(counted, ADMIN, {
          activityID: grid.activityID,
          ccaID: CHILDREN,
          changes: grid.changes,
        }),
      );
      console.info(
        `[load] alone: large attendance save ${outcome.ms.toFixed(0)} ms in ${attempts} attempt(s) (${outcome.result})`,
      );
      expect(outcome.result).toBe("ok");
      expect(attempts).toBe(1);
      expect(outcome.ms).toBeLessThan(3_000);
    });

    it("20 ordinary saves and one 4,000-cell attendance save at the same moment all land", async () => {
      const grid = await bigGrid();
      const saves = ordinarySaves("Load A");
      const outcomes = await Promise.all([
        timed("attendance", () =>
          volunteer.volunteerAttendanceSave(db, ADMIN, {
            activityID: grid.activityID,
            ccaID: CHILDREN,
            changes: grid.changes,
          }),
        ),
        ...saves.map((s) => s.run()),
      ]);
      report("no Open", outcomes);

      expect(outcomes.map((o) => o.result)).toEqual(outcomes.map(() => "ok"));
      expect(
        await db.ccaActivity.count({
          where: { academicYear: AY, title: { startsWith: "Load A " } },
        }),
      ).toBe(ORDINARY_SAVES);
      expect(
        await db.volunteerAttendance.count({
          where: { activityID: grid.activityID },
        }),
      ).toBe(PEOPLE * SESSIONS);
      expect(
        await db.volunteerAttendance.count({
          where: { activityID: grid.activityID, hoursOverride: 1.5 },
        }),
      ).toBe((PEOPLE * SESSIONS) / 2);
    });

    it("Open transcripts started in the middle of that load completes; every save either landed or was refused because the year opened", async () => {
      const grid = await bigGrid();
      const saves = ordinarySaves("Load B");
      const pending: Array<Promise<Outcome>> = [
        timed("attendance", () =>
          volunteer.volunteerAttendanceSave(db, ADMIN, {
            activityID: grid.activityID,
            ccaID: CHILDREN,
            changes: grid.changes,
          }),
        ),
        ...saves.map((s) => s.run()),
      ];
      // Open starts while the saves are running.
      await new Promise((done) => setTimeout(done, 50));
      const open = await timed("open", () =>
        periods.openTranscripts(db, AY, JCRC, APR_2027),
      );
      const outcomes = await Promise.all(pending);
      const opened = await periods.getPeriod(db, AY);
      report(
        "with Open",
        outcomes,
        `; Open ${open.ms.toFixed(0)} ms (${open.result}); ${
          outcomes.filter((o) => o.result === "ok").length
        } saves landed, ${
          outcomes.filter((o) => o.result !== "ok").length
        } refused`,
      );

      expect(open.result).toBe("ok");
      expect(opened?.status).toBe("published");
      for (const o of outcomes) {
        expect(["ok", "PRECONDITION_FAILED:PERIOD_PUBLISHED"]).toContain(
          o.result,
        );
      }
      // A refused save wrote nothing; a landed one is there.
      const titles = new Set(
        (
          await db.ccaActivity.findMany({
            where: { academicYear: AY, title: { startsWith: "Load B " } },
            select: { title: true },
          })
        ).map((a) => a.title),
      );
      saves.forEach((s, i) => {
        expect(titles.has(s.title)).toBe(outcomes[i + 1]!.result === "ok");
      });
      const overrides = await db.volunteerAttendance.count({
        where: { activityID: grid.activityID, hoursOverride: 1.5 },
      });
      expect(overrides).toBe(
        outcomes[0]!.result === "ok" ? (PEOPLE * SESSIONS) / 2 : 0,
      );
    });
  },
);
