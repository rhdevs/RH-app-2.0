import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  captureFreezes,
  restoreFreezes,
  type FreezeBaseline,
} from "./intHelpers";

/**
 * INTEGRATION TESTS against the LOCAL development database. They run ONLY when
 * DATABASE_URL points at localhost / 127.0.0.1 and the database is named
 * `rhapp_transcript_dev`; otherwise the whole file is skipped, so a plain
 * `npm run test` needs no database. Run them with `npm run test:db`.
 *
 * The suite re-runs the seed script once to start from a known baseline, then
 * restores the period, the roster annotations and the issued transcripts before
 * every test. It touches only SEED- data (and puts back the two seeded
 * membership/head rows it temporarily edits).
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
const SEM2_START = new Date("2027-01-11T00:00:00Z");
const MEMBERS_SEEDED = 64; // UserCCA rows written by the seed (heads are members)

const RESIDENT = { id: "SEED-R09", roles: ["resident"] };
const RESIDENT_12 = { id: "SEED-R12", roles: ["resident"] };
const HEAD_4 = { id: "SEED-R04", roles: ["cca_head", "resident"] };
const JCRC = { id: "SEED-R02", roles: ["jcrc", "resident"] };
const ADMIN = { id: "SEED-R01", roles: ["admin", "resident"] };

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "transcript server logic (local database)",
  { timeout: 60_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let baselineAnnotations: Array<Record<string, unknown>> = [];
    let baselineFreezes: FreezeBaseline = [];
    let ipCounter = 0;

    const as = (who: { id: string; roles: string[] } | null, ip?: string) =>
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
          "x-forwarded-for": ip ?? `203.0.113.${(ipCounter += 1)}`,
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

    beforeAll(async () => {
      execFileSync(process.execPath, ["scripts/dev/seed-transcript.mjs"], {
        stdio: "pipe",
      });
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      baselineAnnotations = (
        await db.transcriptRosterEntry.findMany({
          where: { academicYear: AY, userID: { startsWith: "SEED-" } },
        })
      ).map(({ id: _id, ...rest }) => rest);
      expect(baselineAnnotations.length).toBeGreaterThan(0);
      baselineFreezes = await captureFreezes(db);
    }, 120_000);

    /** Back to the seeded baseline: collecting, nothing opened, annotations as seeded. */
    const reset = async () => {
      await db.transcriptAccess.deleteMany({
        where: { userID: { startsWith: "SEED-" } },
      });
      await db.transcriptRosterEntry.deleteMany({
        where: { academicYear: AY },
      });
      await db.transcriptRosterEntry.createMany({
        data: baselineAnnotations as never,
      });
      await restoreFreezes(db, baselineFreezes);
      await db.transcriptPeriod.upsert({
        where: { academicYear: AY },
        create: {
          academicYear: AY,
          sem2Start: SEM2_START,
          status: "collecting",
        },
        update: {
          sem2Start: SEM2_START,
          status: "collecting",
          publishedAt: null,
          publishedBy: null,
          reopenedAt: null,
          reopenedBy: null,
        },
      });
      await db.rateLimit.deleteMany({
        where: { key: { startsWith: "transcript-verify:203.0.113." } },
      });
    };

    beforeEach(reset, 60_000);
    afterAll(async () => {
      if (db) {
        await reset();
        await db.$disconnect();
      }
    }, 60_000);

    /** Close the year (freezing every CCA), then publish it. */
    const publishAy = async (who: { id: string; roles: string[] } = JCRC) => {
      await as(who).transcript.periods.close({ academicYear: AY });
      return as(who).transcript.periods.publish({ academicYear: AY });
    };

    const entryOf = (userID: string, ccaID: number) =>
      db.transcriptRosterEntry.findUnique({
        where: {
          academicYear_userID_ccaID: { academicYear: AY, userID, ccaID },
        },
      });

    /* ------------------------------------------------------------------ */
    describe("who may control a year", () => {
      it("lets only jcrc and admin list, publish and reopen", async () => {
        for (const who of [RESIDENT, HEAD_4]) {
          expect(await errorOf(as(who).transcript.periods.list())).toBe(
            "FORBIDDEN:INSUFFICIENT_ROLE",
          );
          expect(await errorOf(publishAy(who))).toBe(
            "FORBIDDEN:INSUFFICIENT_ROLE",
          );
        }
        // scrc is stopped by the builder; the live role read stops a stale session.
        expect(
          await errorOf(
            as({ id: RESIDENT.id, roles: ["scrc"] }).transcript.periods.list(),
          ),
        ).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
        // A session claiming jcrc for someone whose LIVE roles are only resident.
        expect(
          await errorOf(
            as({ id: RESIDENT.id, roles: ["jcrc"] }).transcript.periods.list(),
          ),
        ).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
        expect(await errorOf(as(null).transcript.periods.list())).toBe(
          "UNAUTHORIZED:UNAUTHORIZED",
        );

        expect(await errorOf(as(JCRC).transcript.periods.list())).toBe("ok");
        expect(await errorOf(as(ADMIN).transcript.periods.list())).toBe("ok");
      });

      it("keeps preview manager-only", async () => {
        for (const who of [RESIDENT, HEAD_4]) {
          expect(
            await errorOf(
              as(who).transcript.preview({
                userID: "SEED-R12",
                academicYear: AY,
              }),
            ),
          ).toBe("FORBIDDEN:INSUFFICIENT_ROLE");
        }
        expect(
          await errorOf(
            as(JCRC).transcript.preview({
              userID: "SEED-R12",
              academicYear: AY,
            }),
          ),
        ).toBe("ok");
      });
    });

    /* ------------------------------------------------------------------ */
    describe("close year and publish", () => {
      it("closes a hall-sized year (2,000 memberships) well inside the transaction limit", async () => {
        const PEOPLE = 400;
        const CCAS_EACH = [9001, 9002, 9003, 9004, 9005]; // 400 x 5 = 2,000
        const id = (n: number) => `SEED-T${String(n).padStart(4, "0")}`;
        const people = Array.from({ length: PEOPLE }, (_, i) => i + 1);

        const cleanup = async () => {
          await db.userCCA.deleteMany({
            where: { userID: { startsWith: "SEED-T" } },
          });
          await db.transcriptRosterEntry.deleteMany({
            where: { userID: { startsWith: "SEED-T" } },
          });
          await db.user.deleteMany({
            where: { userID: { startsWith: "SEED-T" } },
          });
        };
        await cleanup();
        try {
          await db.user.createMany({
            data: people.map((n) => ({
              email: `seed-t${String(n).padStart(4, "0")}@u.nus.edu`,
              passwordHash: "not-a-real-hash",
              userID: id(n),
              displayName: `Synthetic Resident ${n}`,
              block: (n % 5) + 1,
              telegramHandle: `synthetic_${n}`,
            })),
          });
          await db.userCCA.createMany({
            data: people.flatMap((n) =>
              CCAS_EACH.map((ccaID) => ({ userID: id(n), ccaID })),
            ),
          });
          // Annotations on 400 of the memberships: half share one payload, half
          // carry their own extra text, so both update paths are exercised.
          await db.transcriptRosterEntry.createMany({
            data: people.slice(0, 200).flatMap((n) => [
              {
                academicYear: AY,
                userID: id(n),
                ccaID: 9001,
                duration: "sem1",
                frozen: false,
              },
              {
                academicYear: AY,
                userID: id(n),
                ccaID: 9002,
                extraContribution: `Contribution ${n}`,
                frozen: false,
              },
            ]),
          });

          const started = Date.now();
          const result = await as(JCRC).transcript.periods.close({
            academicYear: AY,
          });
          const seconds = (Date.now() - started) / 1000;
          const frozenEntries = await db.transcriptRosterEntry.count({
            where: { academicYear: AY, frozen: true },
          });
          // eslint-disable-next-line no-console
          console.info(
            `[scale] closed the year: ${frozenEntries} entries frozen in ${seconds.toFixed(1)}s`,
          );

          expect(frozenEntries).toBe(
            MEMBERS_SEEDED + PEOPLE * CCAS_EACH.length,
          );
          expect(result.frozenNow + result.alreadyFrozen).toBe(14);
          expect(seconds).toBeLessThan(30);
          expect(
            await db.transcriptRosterEntry.count({
              where: {
                academicYear: AY,
                userID: { startsWith: "SEED-T" },
                frozen: true,
              },
            }),
          ).toBe(PEOPLE * CCAS_EACH.length);
          expect((await entryOf(id(1), 9001))?.duration).toBe("sem1");
          expect((await entryOf(id(1), 9002))?.extraContribution).toBe(
            "Contribution 1",
          );
        } finally {
          await cleanup();
        }
      }, 120_000);

      it("refuses to close without a semester-2 start date", async () => {
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
          (
            await db.transcriptPeriod.findUnique({
              where: { academicYear: AY },
            })
          )?.status,
        ).toBe("collecting");
        // nothing was frozen by the refused close
        expect(
          await db.ccaYearFreeze.count({
            where: { academicYear: AY, reason: "close_year" },
          }),
        ).toBe(0);
      });

      it("closing freezes every CCA with the right default durations", async () => {
        // A late-accepted plain member (no seeded override) and an early one.
        const apps = await db.ccaApplication.findMany({
          where: { userID: { startsWith: "SEED-" }, status: "accepted" },
        });
        const annotated = new Set(
          baselineAnnotations.map((a) => `${a.userID}|${a.ccaID}`),
        );
        const free = apps.filter(
          (a) => !annotated.has(`${a.userID}|${a.ccaID}`),
        );
        const late = free.find((a) => a.decidedAt! >= SEM2_START)!;
        const early = free.find((a) => a.decidedAt! < SEM2_START)!;
        expect(late && early).toBeTruthy();

        // A head granted after semester 2 began (R10 heads RVC Pioneers, 9003).
        const head = await db.ccaHead.findFirstOrThrow({
          where: { userID: "SEED-R10", ccaID: 9003 },
        });
        await db.ccaHead.update({
          where: { id: head.id },
          data: { grantedAt: new Date("2027-02-01T00:00:00Z") },
        });
        try {
          const closed = await as(JCRC).transcript.periods.close({
            academicYear: AY,
          });
          await as(JCRC).transcript.periods.publish({ academicYear: AY });

          // 12 CCAs were not frozen; the 2 the seed froze already were left alone.
          expect(closed).toMatchObject({ frozenNow: 12, alreadyFrozen: 2 });
          expect(
            await db.ccaYearFreeze.count({
              where: { academicYear: AY, reason: "close_year" },
            }),
          ).toBe(12);
          expect((await entryOf(late.userID, late.ccaID))?.duration).toBe(
            "sem2",
          );
          expect((await entryOf(early.userID, early.ccaID))?.duration).toBe(
            "full",
          );
          expect(await entryOf("SEED-R10", 9003)).toMatchObject({
            roleLabel: "Head",
            roleDuration: "sem2",
            frozen: true,
          });
          // A head granted earlier gets a full-year default role...
          expect(await entryOf("SEED-R07", 9001)).toMatchObject({
            roleLabel: "Head",
            roleDuration: "full",
          });
          // ...and stored overrides win over derived defaults.
          expect(await entryOf("SEED-R04", 9005)).toMatchObject({
            roleLabel: "Captain",
            roleDuration: "full",
          });
          expect((await entryOf("SEED-R05", 9007))?.roleDuration).toBe("sem2");
          expect((await entryOf("SEED-R12", 9007))?.duration).toBe("sem1");

          const period = await db.transcriptPeriod.findUnique({
            where: { academicYear: AY },
          });
          expect(period).toMatchObject({
            status: "published",
            publishedBy: JCRC.id,
          });
          expect(
            await db.transcriptRosterEntry.count({
              where: { academicYear: AY, frozen: true },
            }),
          ).toBe(MEMBERS_SEEDED);
        } finally {
          await db.ccaHead.update({
            where: { id: head.id },
            data: { grantedAt: head.grantedAt },
          });
        }
      });

      it("keeps members who left, and ignores anyone who joined, after the close", async () => {
        await publishAy(JCRC);

        const left = await db.userCCA.findMany({
          where: { userID: "SEED-R13", ccaID: 9009 },
        });
        expect(left).toHaveLength(1);
        await db.userCCA.deleteMany({
          where: { userID: "SEED-R13", ccaID: 9009 },
        });
        await db.userCCA.create({ data: { userID: "SEED-R14", ccaID: 9013 } });
        try {
          const gone = await as(JCRC).transcript.preview({
            userID: "SEED-R13",
            academicYear: AY,
          });
          const joined = await as(JCRC).transcript.preview({
            userID: "SEED-R14",
            academicYear: AY,
          });

          expect(gone.status).toBe("published");
          const row = gone.transcript.pages
            .flatMap((p) => (p.kind === "main" ? p.sections : []))
            .flatMap((s) => (s.kind === "involvements" ? s.rows : []))
            .find((r) => r.ccaName === "Phoenix Press");
          expect(row?.year).toBe("2026/27 Sem 1");
          const names = joined.transcript.pages
            .flatMap((p) => (p.kind === "main" ? p.sections : []))
            .flatMap((s) =>
              s.kind === "involvements" ? s.rows.map((r) => r.ccaName) : [],
            );
          expect(names).not.toContain("Chess Club");
        } finally {
          await db.userCCA.deleteMany({
            where: { userID: "SEED-R14", ccaID: 9013 },
          });
          await db.userCCA.createMany({
            data: left.map(({ ccaID, userID }) => ({ ccaID, userID })),
          });
        }
      });

      it("locks edits while published", async () => {
        await publishAy(JCRC);

        expect(
          await errorOf(
            as(JCRC).transcript.periods.setSem2Start({
              academicYear: AY,
              sem2Start: "2027-01-12",
            }),
          ),
        ).toBe("FORBIDDEN:PERIOD_PUBLISHED");
      });

      it("refuses to publish a year that is not closed, and a second publish", async () => {
        expect(
          await errorOf(
            as(JCRC).transcript.periods.publish({ academicYear: AY }),
          ),
        ).toBe("CONFLICT:NOT_CLOSED");

        await publishAy(JCRC);

        expect(
          await errorOf(
            as(JCRC).transcript.periods.publish({ academicYear: AY }),
          ),
        ).toBe("CONFLICT:NOT_CLOSED");
        expect(
          await errorOf(
            as(JCRC).transcript.periods.close({ academicYear: AY }),
          ),
        ).toBe("CONFLICT:NOT_COLLECTING");
      });

      it("leaves one consistent state when two publishes race", async () => {
        await as(JCRC).transcript.periods.close({ academicYear: AY });
        const results = await Promise.allSettled([
          as(JCRC).transcript.periods.publish({ academicYear: AY }),
          as(ADMIN).transcript.periods.publish({ academicYear: AY }),
        ]);

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        // The loser is a clean CONFLICT, not an internal error.
        const loser = results.find(
          (r): r is PromiseRejectedResult => r.status === "rejected",
        )!;
        expect((loser.reason as { code?: string }).code).toBe("CONFLICT");
        const period = await db.transcriptPeriod.findUnique({
          where: { academicYear: AY },
        });
        expect(period?.status).toBe("published");
        expect([JCRC.id, ADMIN.id]).toContain(period?.publishedBy);
        expect(
          await db.transcriptRosterEntry.count({
            where: { academicYear: AY, frozen: true },
          }),
        ).toBe(MEMBERS_SEEDED);
        expect(
          await db.transcriptRosterEntry.count({ where: { academicYear: AY } }),
        ).toBe(MEMBERS_SEEDED);
      });
    });

    /* ------------------------------------------------------------------ */
    describe("a resident's own transcript", () => {
      it("is not open while the year is collecting", async () => {
        expect(
          await as(RESIDENT_12).transcript.mine.get({ academicYear: AY }),
        ).toEqual({
          status: "not_open",
          academicYear: AY,
        });
        expect(
          await db.transcriptAccess.count({
            where: { userID: RESIDENT_12.id },
          }),
        ).toBe(0);
      });

      it("is assembled from the frozen record once the year is published", async () => {
        await publishAy(JCRC);

        const result = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });

        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.transcript.resident.name).toBe("Seed Resident 12");
        expect(result.transcript.resident.matric).toBe("A9912000X");
        expect(Object.keys(result)).not.toContain("code");
        expect(Object.keys(result.transcript.issue)).not.toContain(
          "verificationCode",
        );
        expect(result.transcript.hasAwards).toBe(true);
        expect(result.transcript.hasVolunteerHours).toBe(true);
        // Weekly tuition (9 sessions of 2 hours and one of 1) is 19 hours and the
        // beach clean-up 4; the removed food drive is not on it.
        const hours = result.transcript.pages
          .flatMap((p) => (p.kind === "main" ? p.sections : []))
          .flatMap((s) =>
            s.kind === "volunteerHours" ? [s.volunteer.total] : [],
          );
        expect(hours).toEqual([23]);
      });

      it("dates the transcript with the day the year was published, in Singapore, on every view", async () => {
        await publishAy(JCRC);
        const period = await db.transcriptPeriod.findUniqueOrThrow({
          where: { academicYear: AY },
        });
        // Pin the instant so its UTC date differs from its Singapore date.
        await db.transcriptPeriod.update({
          where: { academicYear: AY },
          data: { publishedAt: new Date("2027-03-09T17:30:00Z") },
        });
        expect(period.publishedAt).not.toBeNull();

        const first = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });
        const second = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });

        if (first.status !== "ready" || second.status !== "ready")
          throw new Error("not ready");
        expect(first.transcript.issue.issuedOn).toBe("2027-03-10");
        expect(second.transcript.issue.issuedOn).toBe("2027-03-10");
      });

      it("has no issue date in an admin preview before publish", async () => {
        const preview = await as(JCRC).transcript.preview({
          userID: RESIDENT_12.id,
          academicYear: AY,
        });

        expect(preview.status).toBe("collecting");
        expect(preview.transcript.issue.issuedOn).toBeNull();
      });

      it("notes the first and last time it was opened, once, even when opened many times at once", async () => {
        await publishAy(JCRC);

        await Promise.all(
          Array.from({ length: 6 }, () =>
            as(RESIDENT_12).transcript.mine.get({ academicYear: AY }),
          ),
        );

        const rows = await db.transcriptAccess.findMany({
          where: { userID: RESIDENT_12.id, academicYear: AY },
        });
        expect(rows).toHaveLength(1);
        const first = rows[0]!.firstOpenedAt!;
        await as(RESIDENT_12).transcript.mine.get({ academicYear: AY });
        const after = await db.transcriptAccess.findUniqueOrThrow({
          where: { id: rows[0]!.id },
        });
        expect(after.firstOpenedAt!.getTime()).toBe(first.getTime());
        expect(after.lastOpenedAt!.getTime()).toBeGreaterThanOrEqual(
          first.getTime(),
        );
      });

      it("can only ever be the signed-in resident's own", async () => {
        await publishAy(JCRC);

        // A client-supplied userID is not an input, so it is stripped, not honoured.
        const result = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
          userID: "SEED-R04",
        } as never);

        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.transcript.resident.name).toBe("Seed Resident 12");
        expect(
          await db.transcriptAccess.count({ where: { userID: "SEED-R04" } }),
        ).toBe(0);
        expect(
          await errorOf(as(null).transcript.mine.get({ academicYear: AY })),
        ).toBe("UNAUTHORIZED:UNAUTHORIZED");
      });

      it("shows current data on every view, with no stored copy", async () => {
        await publishAy(JCRC);
        const first = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });
        if (first.status !== "ready") throw new Error("not ready");
        expect(first.transcript.hasAwards).toBe(true);
        await db.award.updateMany({
          where: { userID: RESIDENT_12.id },
          data: { voidedAt: new Date() },
        });

        const again = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });

        if (again.status !== "ready") throw new Error("not ready");
        expect(again.transcript.hasAwards).toBe(false);
        await db.award.updateMany({
          where: { userID: RESIDENT_12.id },
          data: { voidedAt: null },
        });
      });

      it("shows an empty year for a resident with no involvements", async () => {
        await publishAy(JCRC);
        // SEED-R20 is in a couple of CCAs; unfreeze their entries to make the year empty.
        await db.transcriptRosterEntry.updateMany({
          where: { academicYear: AY, userID: "SEED-R20" },
          data: { frozen: false },
        });
        // ... and the seed lists them under "Other involvement" for one activity.
        await db.ccaActivityParticipant.deleteMany({
          where: { academicYear: AY, userID: "SEED-R20" },
        });

        const result = await as({
          id: "SEED-R20",
          roles: ["resident"],
        }).transcript.mine.get({
          academicYear: AY,
        });

        expect(result.status).toBe("ready");
        if (result.status !== "ready") return;
        expect(result.transcript.isEmpty).toBe(true);
      });
    });

    /* ------------------------------------------------------------------ */
    describe("readiness (the Ready badge)", () => {
      it("is not ready before any year is published", async () => {
        expect(await as(RESIDENT_12).transcript.mine.readiness()).toEqual({
          ready: false,
          academicYear: null,
        });
      });

      it("is ready for a published year the resident has not opened, then clears once they open it", async () => {
        await publishAy(JCRC);

        expect(await as(RESIDENT_12).transcript.mine.readiness()).toEqual({
          ready: true,
          academicYear: AY,
        });
        await as(RESIDENT_12).transcript.mine.get({ academicYear: AY });
        expect(await as(RESIDENT_12).transcript.mine.readiness()).toEqual({
          ready: false,
          academicYear: null,
        });
        // Someone else's opening does not clear mine.
        expect(await as(RESIDENT).transcript.mine.readiness()).toEqual({
          ready: true,
          academicYear: AY,
        });
      });

      it("is never answered for a signed-out visitor", async () => {
        expect(await errorOf(as(null).transcript.mine.readiness())).toBe(
          "UNAUTHORIZED:UNAUTHORIZED",
        );
      });
    });

    /* ------------------------------------------------------------------ */
    describe("there is no verification", () => {
      it("has no verify procedure and no issue collection", async () => {
        const router = (await import("~/server/api/routers/transcript"))
          .transcriptRouter;

        expect(Object.keys(router._def.procedures)).not.toContain(
          "transcript.verify",
        );
        expect(Object.keys(router._def.record)).not.toContain("verify");
        const collections = (await db.$runCommandRaw({
          listCollections: 1,
          nameOnly: true,
        })) as { cursor: { firstBatch: Array<{ name: string }> } };
        expect(collections.cursor.firstBatch.map((c) => c.name)).not.toContain(
          "TranscriptIssue",
        );
      });
    });

    /* ------------------------------------------------------------------ */
    describe("reopen", () => {
      it("goes back to review: residents see a draft, and the corrected data after re-publish", async () => {
        await publishAy(JCRC);
        await as(RESIDENT_12).transcript.mine.get({ academicYear: AY });

        const reopened = await as(ADMIN).transcript.periods.reopen({
          academicYear: AY,
        });

        expect(reopened).toEqual({ academicYear: AY });
        const period = await db.transcriptPeriod.findUniqueOrThrow({
          where: { academicYear: AY },
        });
        expect(period.status).toBe("closed");
        expect(period.reopenedBy).toBe(ADMIN.id);
        // The year is back in review: the resident sees a DRAFT, and opening it
        // is not recorded as having downloaded.
        const draft = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });
        expect(draft).toMatchObject({ status: "ready", draft: true });
        expect(draft.status === "ready" && draft.transcript.isDraft).toBe(true);
        // Reopening cleared nothing: the annotations are still there.
        expect((await entryOf("SEED-R12", 9007))?.duration).toBe("sem1");

        await db.award.updateMany({
          where: { userID: RESIDENT_12.id },
          data: { voidedAt: new Date() },
        });
        await as(JCRC).transcript.periods.publish({ academicYear: AY });
        const second = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });
        if (second.status !== "ready") throw new Error("not ready");
        expect(second.draft).toBe(false);
        expect(second.transcript.isDraft).toBe(false);
        expect(second.transcript.hasAwards).toBe(false);
        await db.award.updateMany({
          where: { userID: RESIDENT_12.id },
          data: { voidedAt: null },
        });
      });

      it("refuses to reopen a year that is not published", async () => {
        expect(
          await errorOf(
            as(JCRC).transcript.periods.reopen({ academicYear: AY }),
          ),
        ).toMatch(/^PRECONDITION_FAILED:|^BAD_REQUEST:|^CONFLICT:|^FORBIDDEN:/);
      });
    });

    /* ------------------------------------------------------------------ */
    describe("what the pages rely on", () => {
      it("lists the years a resident can open: published ones, and closed ones as drafts", async () => {
        expect(await as(RESIDENT).transcript.mine.years()).toEqual([]);

        await publishAy(JCRC);

        expect(await as(RESIDENT).transcript.mine.years()).toEqual([
          { academicYear: AY, draft: false },
        ]);
        expect(await errorOf(as(null).transcript.mine.years())).toBe(
          "UNAUTHORIZED:UNAUTHORIZED",
        );
      });

      it("shows the resident the same transcript as the admin preview of a published year", async () => {
        await publishAy(JCRC);

        const mine = await as(RESIDENT_12).transcript.mine.get({
          academicYear: AY,
        });
        const preview = await as(JCRC).transcript.preview({
          userID: RESIDENT_12.id,
          academicYear: AY,
        });

        if (mine.status !== "ready") throw new Error("not ready");
        expect(preview.status).toBe("published");
        expect(preview.transcript).toEqual(mine.transcript);
        expect(mine.transcript.resident.isSpecimen).toBe(false);
      });
    });
  },
);
