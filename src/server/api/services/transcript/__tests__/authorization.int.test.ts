import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * AUTHORIZATION, procedure by procedure, against the LOCAL development database
 * (skipped unless DATABASE_URL is localhost and the database is
 * `rhapp_transcript_dev`; run with `npm run test:db`).
 *
 * The list of procedures is read from the router itself and compared with the
 * table below, so a new procedure under transcript.periods, transcript.freezes
 * or transcriptManage.corrections fails this test until it is added to the
 * table (and so is checked against every kind of caller).
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
const SOCCER = 9005;
const CHILDREN = 9002;

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const JCRC = R(2, ["jcrc", "resident"]);
const SOCCER_HEAD = R(4, ["cca_head", "resident"]);
const R12 = R(12, ["resident"]);
const R20 = R(20, ["resident"]);

/** Every procedure that must be manager-only, by its full path. */
const MANAGER_ONLY = [
  "transcript.periods.list",
  "transcript.periods.setDownloadBy",
  "transcript.periods.open",
  "transcript.freezes.list",
  "transcriptManage.corrections.panel",
  "transcriptManage.corrections.unlock",
  "transcriptManage.corrections.relock",
  "transcriptManage.corrections.withhold",
  "transcriptManage.corrections.release",
  "transcriptManage.corrections.history",
  "transcriptManage.corrections.memberships.list",
  "transcriptManage.corrections.memberships.saveManual",
  "transcriptManage.corrections.memberships.removeManual",
  "transcriptManage.corrections.memberships.restoreManual",
  "transcriptManage.corrections.participation.list",
  "transcriptManage.corrections.participation.options",
  "transcriptManage.corrections.participation.set",
  "transcriptManage.corrections.participation.remove",
  "transcriptManage.corrections.volunteer",
  "transcriptManage.corrections.awards",
  "transcriptManage.corrections.jcrc.get",
  "transcriptManage.corrections.jcrc.remove",
  "transcriptManage.corrections.jcrc.restore",
] as const;

const PREFIXES = [
  "transcript.periods.",
  "transcript.freezes.",
  "transcriptManage.corrections.",
];

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "who may reach the year, lock and correction procedures (local database)",
  { timeout: 300_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
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

    /** Call a procedure by its dotted path, with an empty input. */
    const call = (caller: ReturnType<typeof as>, path: string) => {
      const fn = path
        .split(".")
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)[key],
          caller,
        ) as (input: unknown) => Promise<unknown>;
      return fn({});
    };

    const reseed = () =>
      execFileSync(process.execPath, ["scripts/dev/seed-transcript.mjs"], {
        stdio: "pipe",
      });

    beforeAll(async () => {
      reseed();
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
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

    /* ---------------------------------------------------------------- */
    describe("the table matches the router", () => {
      it("lists every procedure under the three routers, no more and no fewer", async () => {
        const { appRouter } = await import("~/server/api/root");
        const actual = Object.keys(
          (appRouter as unknown as { _def: { procedures: object } })._def
            .procedures,
        )
          .filter((path) => PREFIXES.some((p) => path.startsWith(p)))
          .sort();

        expect(actual).toEqual([...MANAGER_ONLY].sort());
      });
    });

    /* ---------------------------------------------------------------- */
    describe("every procedure refuses everyone who is not a manager", () => {
      const personas: Array<
        [string, { id: string; roles: string[] } | null, string]
      > = [
        ["a resident", R12, "FORBIDDEN"],
        ["the head of the CCA", SOCCER_HEAD, "FORBIDDEN"],
        ["hall office (scrc)", { id: R12.id, roles: ["scrc"] }, "FORBIDDEN"],
        [
          "a session claiming jcrc that the live database does not grant",
          { id: R12.id, roles: ["jcrc", "resident"] },
          "FORBIDDEN",
        ],
        ["a signed-out visitor", null, "UNAUTHORIZED"],
      ];

      it.each(personas)("%s", async (_name, who, code) => {
        const results: Array<[string, string]> = [];
        for (const path of MANAGER_ONLY) {
          results.push([path, await errorOf(call(as(who), path))]);
        }

        for (const [path, result] of results) {
          expect(result.startsWith(`${code}:`), `${path}: ${result}`).toBe(
            true,
          );
        }
      });

      it("refused procedures change nothing", async () => {
        const before = {
          periods: await db.transcriptPeriod.findMany(),
          unlocks: await db.residentUnlock.count(),
          events: await db.residentEvent.count(),
        };

        for (const who of [R12, SOCCER_HEAD, null]) {
          for (const path of MANAGER_ONLY) {
            await errorOf(call(as(who), path));
          }
        }

        expect(await db.transcriptPeriod.findMany()).toEqual(before.periods);
        expect(await db.residentUnlock.count()).toBe(before.unlocks);
        expect(await db.residentEvent.count()).toBe(before.events);
      });

      it("lets a real manager past the gate (the input is what refuses then)", async () => {
        const result = await errorOf(
          as(JCRC).transcriptManage.corrections.panel({} as never),
        );
        expect(result.startsWith("BAD_REQUEST:")).toBe(true);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a locked resident in an open year, then unlocked", () => {
      const open = () => as(JCRC).transcript.periods.open({ academicYear: AY });
      const unlock = (userID: string) =>
        as(JCRC).transcriptManage.corrections.unlock({
          userID,
          academicYear: AY,
          reason: "Wrong details on file",
        });
      const corrections = (userID: string) =>
        db.residentEvent
          .findMany({ where: { academicYear: AY, userID } })
          .then((rows) => rows.filter((e) => e.action === "correction"));

      it("participation set and remove: refused while locked, written and logged after the unlock", async () => {
        await open();
        const activity = await db.ccaActivity.findFirstOrThrow({
          where: { ccaID: SOCCER, title: "Inter-hall league" },
        });
        const c = () => as(JCRC).transcriptManage.corrections.participation;
        const set = () =>
          c().set({
            userID: R12.id,
            academicYear: AY,
            activityID: activity.id,
            role: "Striker",
            description: "Scored in the final.",
          });
        const remove = () =>
          c().remove({
            userID: R12.id,
            academicYear: AY,
            activityID: activity.id,
          });

        expect(await errorOf(set())).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        expect(await errorOf(remove())).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        expect(await corrections(R12.id)).toHaveLength(0);

        await unlock(R12.id);
        expect(await errorOf(set())).toBe("ok");
        expect(
          (
            await db.ccaActivityParticipant.findFirstOrThrow({
              where: { activityID: activity.id, userID: R12.id },
            })
          ).role,
        ).toBe("Striker");
        expect(await errorOf(remove())).toBe("ok");
        expect((await corrections(R12.id)).length).toBeGreaterThanOrEqual(2);
      });

      it("volunteer attendance: refused while locked, written and logged after the unlock", async () => {
        await open();
        const activity = await db.volunteerActivity.findFirstOrThrow({
          where: { ccaID: CHILDREN, title: { startsWith: "Weekly tuition" } },
        });
        const session = await db.volunteerSession.findFirstOrThrow({
          where: { activityID: activity.id },
          orderBy: { date: "asc" },
        });
        const save = () =>
          as(JCRC).transcriptManage.volunteer.attendance.save({
            activityID: activity.id,
            ccaID: CHILDREN,
            changes: [
              {
                sessionID: session.id,
                userID: R12.id,
                attended: true,
                hoursOverride: 1,
              },
            ],
          });

        expect(await errorOf(save())).toBe("FORBIDDEN:ONLY_UNLOCKED_RESIDENTS");
        expect(await corrections(R12.id)).toHaveLength(0);

        await unlock(R12.id);
        expect(await errorOf(save())).toBe("ok");
        expect((await corrections(R12.id)).length).toBe(1);
      });

      it("awards: assigning and removing are refused while locked, written and logged after the unlock", async () => {
        await open();
        const colours = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        const assign = () =>
          as(JCRC).transcriptManage.awards.assign({
            academicYear: AY,
            awardTypeID: colours.id,
            recipients: [{ userID: R20.id }],
          });

        expect(await errorOf(assign())).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        expect(await corrections(R20.id)).toHaveLength(0);

        await unlock(R20.id);
        expect(await errorOf(assign())).toBe("ok");
        const award = await db.award.findFirstOrThrow({
          where: { academicYear: AY, userID: R20.id, title: "Full Colours" },
        });
        expect(
          await errorOf(
            as(JCRC).transcriptManage.awards.remove({ id: award.id }),
          ),
        ).toBe("ok");
        expect((await corrections(R20.id)).length).toBe(2);
      });

      it("a head cannot write any of these once the year is open, unlocked or not", async () => {
        await open();
        await unlock(R12.id);
        const activity = await db.ccaActivity.findFirstOrThrow({
          where: { ccaID: SOCCER, title: "Inter-hall league" },
        });

        const result = await errorOf(
          as(SOCCER_HEAD).transcriptManage.corrections.participation.set({
            userID: R12.id,
            academicYear: AY,
            activityID: activity.id,
            role: "Striker",
            description: "",
          }),
        );

        expect(result.startsWith("FORBIDDEN:")).toBe(true);
      });
    });
  },
);
