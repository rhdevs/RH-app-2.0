import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * INTEGRATION TESTS of CCA activities against the LOCAL development database
 * (skipped unless DATABASE_URL is localhost and the database is
 * `rhapp_transcript_dev`; run with `npm run test:db`). The seed is re-run before
 * every test, so each starts from the same baseline. The seed gives Soccer
 * (9005, head R04) one activity ("Inter-hall league": R04, R12 and R20, who is
 * not in Soccer), 9007 a semester 2 one, and 9002 one live and one removed.
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
const OLD = "AY2025/26";
const NOW = new Date("2026-10-16T04:00:00Z");

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const ADMIN = R(1, ["admin", "resident"]);
const JCRC = R(2, ["jcrc", "resident"]);
const SOCCER_HEAD = R(4, ["cca_head", "resident"]); // heads Soccer (9005)
const OTHER_HEAD = R(5, ["cca_head", "resident"]); // heads 9007
const PLAIN = R(9, ["resident"]);
const SOCCER = 9005;
const HALL_NIGHT = 9007;
const WELFARE = 9002;

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "CCA activities (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let freeze: typeof import("../freeze");
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
      }).transcriptManage;

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

    const draft = (title: string, period = "full") => ({
      title,
      description: `About ${title}.`,
      period: period as "full" | "sem1" | "sem2",
    });

    const create = (
      who: { id: string; roles: string[] },
      title: string,
      ccaID = SOCCER,
      period = "full",
    ) =>
      as(who).activities.create({
        ccaID,
        academicYear: AY,
        ...draft(title, period),
      });

    const list = (
      who: { id: string; roles: string[] },
      ccaID = SOCCER,
      includeRemoved = false,
    ) => as(who).activities.list({ ccaID, academicYear: AY, includeRemoved });

    const seeded = async (ccaID: number, title: string) => {
      const row = await db.ccaActivity.findFirstOrThrow({
        where: { ccaID, academicYear: AY, title },
      });
      return row.id;
    };

    const people = (...rows: Array<[string, string?, string?]>) =>
      rows.map(([userID, role = "", description = ""]) => ({
        userID,
        role,
        description,
      }));

    /** Fill Soccer to `n` active activities (it starts with one). */
    const fillSoccer = async (n: number) => {
      const have = (await list(SOCCER_HEAD)).activeCount;
      for (let i = have; i < n; i += 1) {
        await create(SOCCER_HEAD, `Filler ${i}`);
      }
    };

    /* ---------------------------------------------------------------- */
    describe("head CRUD for the CCA's term year", () => {
      it("lists the seeded activity with its people and who made it", async () => {
        const result = await list(SOCCER_HEAD);

        expect(result.activeCount).toBe(1);
        expect(result.max).toBe(20);
        const league = result.activities[0]!;
        expect(league.title).toBe("Inter-hall league");
        expect(league.period).toBe("full");
        expect(league.removed).toBe(false);
        expect(league.participants.map((p) => p.userID).sort()).toEqual([
          "SEED-R04",
          "SEED-R12",
          "SEED-R20",
        ]);
        const captain = league.participants.find(
          (p) => p.userID === "SEED-R04",
        )!;
        expect(captain.role).toBe("Captain");
        expect(captain.displayName).toBeTruthy();
        expect(league.createdByName).toBeTruthy();
      });

      it("creates, edits, removes and restores an activity, recording who and when", async () => {
        const made = await create(
          SOCCER_HEAD,
          "Pre-season camp",
          SOCCER,
          "sem1",
        );
        expect(made.id).toMatch(/^[0-9a-f]{24}$/);

        let row = await db.ccaActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row).toMatchObject({
          academicYear: AY,
          ccaID: SOCCER,
          title: "Pre-season camp",
          period: "sem1",
          createdBy: SOCCER_HEAD.id,
        });
        expect(row.createdAt).toBeTruthy();

        await as(SOCCER_HEAD).activities.update({
          id: made.id,
          ccaID: SOCCER,
          title: "Pre-season camp (revised)",
          description: "",
          period: "sem2",
        });
        row = await db.ccaActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row).toMatchObject({
          title: "Pre-season camp (revised)",
          period: "sem2",
          updatedBy: SOCCER_HEAD.id,
        });
        expect(row.description ?? null).toBeNull();

        await as(SOCCER_HEAD).activities.remove({ id: made.id, ccaID: SOCCER });
        row = await db.ccaActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row.removedAt).toBeTruthy();
        expect(row.removedBy).toBe(SOCCER_HEAD.id);
        expect((await list(SOCCER_HEAD)).activeCount).toBe(1);
        expect((await list(SOCCER_HEAD)).activities).toHaveLength(1);
        const withRemoved = await list(SOCCER_HEAD, SOCCER, true);
        expect(withRemoved.activities).toHaveLength(2);
        expect(
          withRemoved.activities.find((a) => a.id === made.id),
        ).toMatchObject({ removed: true });

        await as(SOCCER_HEAD).activities.restore({
          id: made.id,
          ccaID: SOCCER,
        });
        row = await db.ccaActivity.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row.removedAt ?? null).toBeNull();
        expect((await list(SOCCER_HEAD)).activeCount).toBe(2);
      });

      it("never deletes: a removed activity and its people stay in the database", async () => {
        const id = await seeded(SOCCER, "Inter-hall league");
        await as(SOCCER_HEAD).activities.remove({ id, ccaID: SOCCER });

        expect(await db.ccaActivity.count({ where: { id } })).toBe(1);
        expect(
          await db.ccaActivityParticipant.count({ where: { activityID: id } }),
        ).toBe(3);
      });

      it("refuses the head of another CCA, a plain resident and a signed-out caller", async () => {
        const id = await seeded(SOCCER, "Inter-hall league");

        expect(await errorOf(create(OTHER_HEAD, "Nope"))).toBe(
          "FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA",
        );
        expect(await errorOf(list(OTHER_HEAD))).toBe(
          "FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA",
        );
        expect(
          await errorOf(
            as(OTHER_HEAD).activities.remove({ id, ccaID: SOCCER }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(await errorOf(create(PLAIN, "Nope"))).toMatch(/^FORBIDDEN:/);
        expect(await errorOf(list(null as never))).toMatch(/^UNAUTHORIZED:/);
      });

      it("will not touch an activity through another CCA's id", async () => {
        const welfare = await seeded(WELFARE, "Exam-period care packs");

        expect(
          await errorOf(
            as(SOCCER_HEAD).activities.update({
              id: welfare,
              ccaID: SOCCER,
              ...draft("Hijack"),
            }),
          ),
        ).toBe("NOT_FOUND:ACTIVITY_NOT_FOUND");
        expect(
          await errorOf(
            as(SOCCER_HEAD).activities.remove({ id: welfare, ccaID: SOCCER }),
          ),
        ).toBe("NOT_FOUND:ACTIVITY_NOT_FOUND");
        expect(
          await errorOf(
            as(SOCCER_HEAD).participants.set({
              id: welfare,
              ccaID: SOCCER,
              participants: [],
            }),
          ),
        ).toBe("NOT_FOUND:ACTIVITY_NOT_FOUND");
      });

      it("lets a manager edit any CCA", async () => {
        await create(JCRC, "Run by the JCRC", SOCCER);
        expect((await list(ADMIN)).activeCount).toBe(2);
      });

      it("refuses to edit a removed activity until it is restored", async () => {
        const id = await seeded(SOCCER, "Inter-hall league");
        await as(SOCCER_HEAD).activities.remove({ id, ccaID: SOCCER });

        expect(
          await errorOf(
            as(SOCCER_HEAD).activities.update({
              id,
              ccaID: SOCCER,
              ...draft("Renamed"),
            }),
          ),
        ).toBe("CONFLICT:ACTIVITY_REMOVED");
        expect(
          await errorOf(
            as(SOCCER_HEAD).participants.set({
              id,
              ccaID: SOCCER,
              participants: people(["SEED-R04"]),
            }),
          ),
        ).toBe("CONFLICT:ACTIVITY_REMOVED");
      });

      it("refuses bad input before touching the database", async () => {
        const before = await db.ccaActivity.count();

        for (const bad of [
          { ...draft(""), title: "   " },
          { ...draft("x".repeat(81)) },
          { ...draft("ok"), description: "x".repeat(301) },
          { ...draft("ok"), period: "sem3" },
          { ...draft("bad\u0000char") },
        ]) {
          expect(
            await errorOf(
              as(SOCCER_HEAD).activities.create({
                ccaID: SOCCER,
                academicYear: AY,
                ...bad,
              } as never),
            ),
          ).toMatch(/^BAD_REQUEST:/);
        }
        expect(await db.ccaActivity.count()).toBe(before);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("who may edit, by the year's state", () => {
      it("refuses the head once the CCA's list is frozen at handover, but not a manager", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: ADMIN.id,
        });
        const id = await seeded(SOCCER, "Inter-hall league");

        expect(await errorOf(create(SOCCER_HEAD, "Late idea"))).toBe(
          "FORBIDDEN:CCA_YEAR_FROZEN",
        );
        expect(
          await errorOf(
            as(SOCCER_HEAD).activities.remove({ id, ccaID: SOCCER }),
          ),
        ).toBe("FORBIDDEN:CCA_YEAR_FROZEN");
        expect(
          await errorOf(
            as(SOCCER_HEAD).participants.set({
              id,
              ccaID: SOCCER,
              participants: [],
            }),
          ),
        ).toBe("FORBIDDEN:CCA_YEAR_FROZEN");

        // The head can still READ it; a manager can still write.
        expect((await list(SOCCER_HEAD)).activeCount).toBe(1);
        expect(await errorOf(create(JCRC, "Added by the JCRC"))).toBe("ok");
        expect(
          await errorOf(
            as(ADMIN).participants.set({
              id,
              ccaID: SOCCER,
              participants: people(["SEED-R04", "SEED-R09"]),
            }),
          ),
        ).toBe("ok");
      });

      it("lets a head who locked their own list keep editing until the year closes", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "lock",
          actorUserID: SOCCER_HEAD.id,
        });

        expect(await errorOf(create(SOCCER_HEAD, "After the lock"))).toBe("ok");
      });

      it("refuses everyone, managers included, once the year is published, unless a resident is unlocked", async () => {
        const id = await seeded(SOCCER, "Inter-hall league");
        await db.transcriptPeriod.update({
          where: { academicYear: AY },
          data: {
            status: "published",
            publishedAt: new Date(),
            publishedBy: ADMIN.id,
          },
        });

        for (const who of [SOCCER_HEAD, JCRC, ADMIN]) {
          expect(await errorOf(create(who, "Too late"))).toBe(
            "PRECONDITION_FAILED:PERIOD_PUBLISHED",
          );
          expect(
            await errorOf(
              as(who).activities.update({
                id,
                ccaID: SOCCER,
                ...draft("Too late"),
              }),
            ),
          ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
          expect(
            await errorOf(as(who).activities.remove({ id, ccaID: SOCCER })),
          ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
          expect(
            await errorOf(as(who).activities.restore({ id, ccaID: SOCCER })),
          ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
          expect(
            await errorOf(
              as(who).participants.set({
                id,
                ccaID: SOCCER,
                participants: [],
              }),
            ),
            // A manager changing people is a per-resident correction: it needs
            // each of them unlocked. A head just gets the published refusal.
          ).toBe(
            who === SOCCER_HEAD
              ? "PRECONDITION_FAILED:PERIOD_PUBLISHED"
              : "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
          );
        }
        // Reading is still allowed.
        expect((await list(SOCCER_HEAD)).activeCount).toBe(1);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("the limit of 20 activities", () => {
      it("accepts the 20th and refuses the 21st", async () => {
        await fillSoccer(20);
        expect((await list(SOCCER_HEAD)).activeCount).toBe(20);

        expect(await errorOf(create(SOCCER_HEAD, "One too many"))).toBe(
          "CONFLICT:AT_MOST_20_ACTIVITIES",
        );
        expect(
          await db.ccaActivity.count({
            where: { ccaID: SOCCER, academicYear: AY },
          }),
        ).toBe(20);
      });

      it("counts only activities that are not removed", async () => {
        await fillSoccer(20);
        const id = await seeded(SOCCER, "Filler 1");
        await as(SOCCER_HEAD).activities.remove({ id, ccaID: SOCCER });

        expect(await errorOf(create(SOCCER_HEAD, "Fits now"))).toBe("ok");
        expect((await list(SOCCER_HEAD)).activeCount).toBe(20);
      });

      it("refuses to restore an activity if that would pass 20", async () => {
        await fillSoccer(20);
        const id = await seeded(SOCCER, "Filler 1");
        await as(SOCCER_HEAD).activities.remove({ id, ccaID: SOCCER });
        await create(SOCCER_HEAD, "Takes the free place");

        expect(
          await errorOf(
            as(SOCCER_HEAD).activities.restore({ id, ccaID: SOCCER }),
          ),
        ).toBe("CONFLICT:AT_MOST_20_ACTIVITIES");
        const row = await db.ccaActivity.findUniqueOrThrow({ where: { id } });
        expect(row.removedAt).toBeTruthy();
      });

      it("counts each CCA and year on its own", async () => {
        await fillSoccer(20);

        expect(
          await errorOf(create(OTHER_HEAD, "Other CCA is fine", HALL_NIGHT)),
        ).toBe("ok");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("participants.set", () => {
      const set = (
        participants: ReturnType<typeof people>,
        who = SOCCER_HEAD,
        id?: string,
      ) =>
        (async () =>
          as(who).participants.set({
            id: id ?? (await seeded(SOCCER, "Inter-hall league")),
            ccaID: SOCCER,
            participants,
          }))();

      const rows = async (title = "Inter-hall league") =>
        db.ccaActivityParticipant.findMany({
          where: { activityID: await seeded(SOCCER, title) },
          orderBy: { userID: "asc" },
        });

      it("adds new people, updates changed ones and soft-removes missing ones", async () => {
        // Seed: R04 Captain, R12 Midfielder, R20 Guest goalkeeper.
        const result = await set(
          people(
            [
              "SEED-R04",
              "Captain",
              "Led the squad through ten league matches.",
            ],
            ["SEED-R12", "Striker"],
            ["SEED-R09", "Reserve"],
          ),
        );

        expect(result).toMatchObject({
          added: 1,
          updated: 1,
          removed: 1,
          unchanged: 1,
        });
        const all = await rows();
        const by = Object.fromEntries(all.map((r) => [r.userID, r]));
        expect(by["SEED-R12"]!.role).toBe("Striker");
        expect(by["SEED-R12"]!.updatedBy).toBe(SOCCER_HEAD.id);
        expect(by["SEED-R09"]).toMatchObject({
          role: "Reserve",
          addedBy: SOCCER_HEAD.id,
        });
        expect(by["SEED-R20"]!.removedAt).toBeTruthy();
        expect(by["SEED-R20"]!.removedBy).toBe(SOCCER_HEAD.id);
        // Nobody was deleted, and the untouched row was not rewritten.
        expect(all).toHaveLength(4);
        expect(by["SEED-R04"]!.removedAt ?? null).toBeNull();
        expect(by["SEED-R04"]!.updatedBy ?? null).toBeNull();
      });

      it("replaces the whole set: an empty list removes everyone", async () => {
        await set([]);

        const all = await rows();
        expect(all).toHaveLength(3);
        expect(all.every((r) => r.removedAt)).toBe(true);
        const listed = (await list(SOCCER_HEAD)).activities[0]!;
        expect(listed.participants).toEqual([]);
      });

      it("brings a removed person back on their old row, with no duplicate", async () => {
        await set(people(["SEED-R04"]));
        const before = await rows();
        const oldRow = before.find((r) => r.userID === "SEED-R12")!;
        expect(oldRow.removedAt).toBeTruthy();

        await set(people(["SEED-R04"], ["SEED-R12", "Back again"]));

        const after = await rows();
        expect(after).toHaveLength(3);
        const back = after.find((r) => r.userID === "SEED-R12")!;
        expect(back.id).toBe(oldRow.id);
        expect(back.removedAt ?? null).toBeNull();
        expect(back.role).toBe("Back again");
      });

      it("accepts anyone in the hall, member of the CCA or not", async () => {
        // R03 is not in Soccer and neither is R20.
        await set(people(["SEED-R03"], ["SEED-R20"]));

        const live = (await rows()).filter((r) => !r.removedAt);
        expect(live.map((r) => r.userID)).toEqual(["SEED-R03", "SEED-R20"]);
      });

      it("rejects a resident who does not exist, changing nothing", async () => {
        const before = await rows();

        expect(
          await errorOf(
            set(people(["SEED-R04"], ["NO-SUCH-RESIDENT", "Ghost"])),
          ),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");

        expect(await rows()).toEqual(before);
      });

      it("rejects the same person listed twice", async () => {
        expect(
          await errorOf(set(people(["SEED-R04"], ["SEED-R04", "Twice"]))),
        ).toBe("BAD_REQUEST:DUPLICATE_PARTICIPANT");
      });

      it("rejects more than 200 people and over-long role or description", async () => {
        const many = Array.from({ length: 201 }, (_, i) => ({
          userID: `SEED-R${String(i)}`,
          role: "",
          description: "",
        }));

        expect(await errorOf(set(many))).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(set(people(["SEED-R04", "x".repeat(61)]))),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(set(people(["SEED-R04", "", "x".repeat(301)]))),
        ).toMatch(/^BAD_REQUEST:/);
      });

      it("records who changed the activity when its people change", async () => {
        const id = await seeded(SOCCER, "Inter-hall league");
        await set(people(["SEED-R04"]));

        const row = await db.ccaActivity.findUniqueOrThrow({ where: { id } });
        expect(row.updatedBy).toBe(SOCCER_HEAD.id);
        expect(row.updatedAt).toBeTruthy();
      });
    });

    /* ---------------------------------------------------------------- */
    describe("on the transcript", () => {
      const transcriptFor = async (userID: string, now = NOW) => {
        const input = await loader.loadTranscriptInput(db, userID, AY, { now });
        return {
          input,
          vm: assemble.assembleTranscript(input, AY),
        };
      };

      const mainSection = (
        vm: ReturnType<typeof assemble.assembleTranscript>,
        kind: string,
      ) => {
        const main = vm.pages[0] as { sections: Array<{ kind: string }> };
        return main.sections.find((s) => s.kind === kind) as never as {
          rows: Array<Record<string, unknown> & { activities?: unknown[] }>;
        };
      };

      it("nests a member's activity under the CCA", async () => {
        const { input, vm } = await transcriptFor("SEED-R12");

        const league = input.activities!.find(
          (a) => a.title === "Inter-hall league",
        )!;
        expect(league).toMatchObject({
          ccaName: "Soccer (MALE)",
          isMember: true,
          role: "Midfielder",
        });
        const soccerRow = mainSection(vm, "involvements").rows.find(
          (r) => r.ccaName === "Soccer (MALE)",
        )!;
        expect(soccerRow.activities).toEqual([
          {
            title: "Inter-hall league",
            role: "Midfielder",
            description: "The hall's team in the inter-hall football league.",
          },
        ]);
      });

      it("shows a non-member's activity under Other involvement", async () => {
        const { input, vm } = await transcriptFor("SEED-R20");

        expect(input.activities).toHaveLength(1);
        expect(input.activities![0]).toMatchObject({
          title: "Inter-hall league",
          isMember: false,
          role: "Guest goalkeeper",
          personDescription: "Covered two fixtures at short notice.",
        });
        const other = mainSection(vm, "otherInvolvement");
        expect(other.rows).toEqual([
          {
            title: "Inter-hall league",
            organiser: "Soccer (MALE)",
            role: "Guest goalkeeper",
            description: "Covered two fixtures at short notice.",
          },
        ]);
      });

      it("puts a semester 2 activity under its CCA with the suffix", async () => {
        const { vm } = await transcriptFor("SEED-R12");

        const choir = mainSection(vm, "involvements").rows.find(
          (r) => r.ccaName === "Hall Choir",
        )!;
        expect(choir.activities).toEqual([
          {
            title: "Hall Night preparation (Sem 2)",
            role: "Stage crew",
            description:
              "Rehearsals and set-up for the annual hall variety night.",
          },
        ]);
        expect(vm.hasPartYear).toBe(true);
      });

      it("never shows a removed activity or a removed participant", async () => {
        const { input: before } = await transcriptFor("SEED-R06");
        expect(before.activities!.map((a) => a.title)).toEqual([
          "Exam-period care packs",
        ]);

        await set_(["SEED-R04"]); // soft-removes R12 and R20 from the league
        const r20 = await transcriptFor("SEED-R20");
        expect(r20.input.activities).toEqual([]);
        expect(
          (
            r20.vm.pages[0] as { sections: Array<{ kind: string }> }
          ).sections.map((x) => x.kind),
        ).not.toContain("otherInvolvement");

        const id = await seeded(WELFARE, "Exam-period care packs");
        await as(R(6, ["cca_head"])).activities.remove({ id, ccaID: WELFARE });
        const r09 = await transcriptFor("SEED-R09");
        expect(r09.input.activities!.map((a) => a.title)).not.toContain(
          "Exam-period care packs",
        );
      });

      it("follows the frozen member list: a member who left stays a member", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: ADMIN.id,
          now: NOW,
        });
        await db.userCCA.deleteMany({
          where: { userID: "SEED-R12", ccaID: SOCCER },
        });

        const { input } = await transcriptFor("SEED-R12");
        expect(
          input.activities!.find((a) => a.title === "Inter-hall league")!
            .isMember,
        ).toBe(true);
      });

      it("treats a person who is not in the frozen list as other involvement", async () => {
        await freeze.freezeCca(db, {
          ccaID: SOCCER,
          reason: "handover",
          actorUserID: ADMIN.id,
          now: NOW,
        });

        const { input } = await transcriptFor("SEED-R20");
        expect(input.activities![0]!.isMember).toBe(false);
      });

      it("keeps the activity of one year off another year's transcript", async () => {
        const input = await loader.loadTranscriptInput(db, "SEED-R12", OLD, {
          now: NOW,
        });
        expect(input.activities).toEqual([]);
      });

      // Soccer's head replaces the league's people (used above).
      const set_ = async (keys: string[]) =>
        as(SOCCER_HEAD).participants.set({
          id: await seeded(SOCCER, "Inter-hall league"),
          ccaID: SOCCER,
          participants: people(...keys.map((k) => [k] as [string])),
        });
    });

    /* ---------------------------------------------------------------- */
    describe("purging a year", () => {
      it("removes that year's activities and people and leaves the others", async () => {
        const old = await db.ccaActivity.create({
          data: {
            academicYear: OLD,
            ccaID: SOCCER,
            title: "Last year's tour",
            period: "full",
            createdBy: SOCCER_HEAD.id,
            createdAt: new Date("2025-10-01T00:00:00Z"),
          },
        });
        await db.ccaActivityParticipant.create({
          data: {
            activityID: old.id,
            academicYear: OLD,
            ccaID: SOCCER,
            userID: "SEED-R04",
            addedBy: SOCCER_HEAD.id,
          },
        });
        const current = {
          activities: await db.ccaActivity.count({
            where: { academicYear: AY },
          }),
          people: await db.ccaActivityParticipant.count({
            where: { academicYear: AY },
          }),
        };

        const dry = await retention.purgeAcademicYear(db, OLD, {
          dryRun: true,
        });
        expect(dry.CcaActivity).toBe(1);
        expect(dry.CcaActivityParticipant).toBe(1);

        const purged = await retention.purgeAcademicYear(db, OLD);
        expect(purged.CcaActivity).toBe(1);
        expect(purged.CcaActivityParticipant).toBe(1);

        expect(
          await db.ccaActivity.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(
          await db.ccaActivity.count({ where: { academicYear: AY } }),
        ).toBe(current.activities);
        expect(
          await db.ccaActivityParticipant.count({
            where: { academicYear: AY },
          }),
        ).toBe(current.people);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("who can search for people to add", () => {
      it("lets any CCA head search by name, but not a plain resident", async () => {
        expect(
          await errorOf(as(SOCCER_HEAD).residents.search({ query: "Seed" })),
        ).toBe("ok");
        expect(
          await errorOf(as(PLAIN).residents.search({ query: "Seed" })),
        ).toMatch(/^FORBIDDEN:/);
      });
    });
  },
);
