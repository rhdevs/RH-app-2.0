import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorText } from "~/lib/transcript/adminView";
import type { createCaller as CreateCaller } from "~/server/api/root";

/**
 * INTEGRATION TESTS for the management API, against the LOCAL development
 * database only (skipped unless DATABASE_URL is localhost / rhapp_transcript_dev;
 * run with `npm run test:db`).
 *
 * The suite re-seeds once for a known baseline, snapshots the seeded rows it
 * will touch, and before every test puts them back (period collecting, nothing
 * issued, roster/awards/volunteering/JCRC/CcaProfile as seeded). It leaves the
 * database exactly as the seed script does.
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
const CCA_IDS = Array.from({ length: 14 }, (_, i) => 9001 + i);

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const ADMIN = R(1, ["admin", "resident"]);
const JCRC = R(2, ["jcrc", "resident"]);
const JCRC_HEAD = R(3, ["jcrc", "cca_head", "resident"]); // also heads RHMP Sets (9011)
const SOCCER_HEAD = R(4, ["cca_head", "resident"]); // heads Soccer (9005)
const RVC_CHILDREN_HEAD = R(6, ["cca_head", "resident"]); // heads RVC Children (9002)
const RVC_PROJECTS_HEAD = R(7, ["cca_head", "resident"]); // heads RVC Special Projects (9001)
const PLAIN = R(9, ["resident"]);
const R12 = R(12, ["resident"]);
const R20 = R(20, ["resident"]); // in neither Soccer nor RVC Children

const SOCCER = 9005;
const CHOIR = 9007;
const RVC_CHILDREN = 9002;
const RVC_PROJECTS = 9001;

type Who = { id: string; roles: string[] };

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "transcript management API (local database)",
  { timeout: 60_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let ipCounter = 0;

    type Rows = Array<Record<string, unknown>>;
    const baseline: {
      roster: Rows;
      awards: Rows;
      volunteer: Rows;
      jcrc: Rows;
      profiles: Rows;
    } = { roster: [], awards: [], volunteer: [], jcrc: [], profiles: [] };

    const as = (who: Who | null) =>
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

    const strip = (rows: Array<{ id: string }>): Rows =>
      rows.map(({ id: _id, ...rest }) => rest);
    const seeded = { userID: { startsWith: "SEED-" } };

    beforeAll(async () => {
      execFileSync(process.execPath, ["scripts/dev/seed-transcript.mjs"], {
        stdio: "pipe",
      });
      ({ db } = await import("~/server/db"));
      ({ createCaller } = await import("~/server/api/root"));
      baseline.roster = strip(
        await db.transcriptRosterEntry.findMany({
          where: { academicYear: AY, ...seeded },
        }),
      );
      baseline.awards = strip(await db.award.findMany({ where: seeded }));
      baseline.volunteer = strip(
        await db.volunteerRecord.findMany({ where: seeded }),
      );
      baseline.jcrc = strip(await db.jcrcService.findMany({ where: seeded }));
      baseline.profiles = strip(
        await db.ccaProfile.findMany({ where: { ccaID: { in: CCA_IDS } } }),
      );
      expect(baseline.roster.length).toBeGreaterThan(0);
      expect(baseline.volunteer.length).toBeGreaterThan(0);
    }, 120_000);

    const reset = async () => {
      await db.transcriptAccess.deleteMany({ where: seeded });
      await db.transcriptRosterEntry.deleteMany({
        where: { academicYear: AY },
      });
      await db.transcriptRosterEntry.createMany({
        data: baseline.roster as never,
      });
      await db.award.deleteMany({ where: seeded });
      await db.award.createMany({ data: baseline.awards as never });
      await db.volunteerRecord.deleteMany({ where: seeded });
      await db.volunteerRecord.createMany({
        data: baseline.volunteer as never,
      });
      await db.jcrcService.deleteMany({ where: seeded });
      await db.jcrcService.createMany({ data: baseline.jcrc as never });
      await db.ccaProfile.deleteMany({ where: { ccaID: { in: CCA_IDS } } });
      await db.ccaProfile.createMany({ data: baseline.profiles as never });
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
    };

    beforeEach(reset, 60_000);
    afterAll(async () => {
      if (db) {
        await reset();
        await db.$disconnect();
      }
    }, 60_000);

    const publish = () =>
      as(JCRC).transcript.periods.publish({ academicYear: AY });

    const aVolunteerRecordOf = (ccaID: number) =>
      db.volunteerRecord.findFirstOrThrow({
        where: {
          ccaID,
          ...seeded,
          OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }],
        },
      });

    const rosterOf = async (who: Who, ccaID: number) =>
      (await as(who).transcriptManage.roster.list({ ccaID, academicYear: AY }))
        .rows;

    /* ------------------------------------------------------------------ */
    describe("a plain resident", () => {
      it("is forbidden from every management procedure", async () => {
        const c = as(PLAIN).transcriptManage;
        const volunteer = await aVolunteerRecordOf(RVC_PROJECTS);
        const award = await db.award.findFirstOrThrow({ where: seeded });
        const calls: Array<[string, () => Promise<unknown>]> = [
          ["ccaTags.list", () => c.ccaTags.list()],
          [
            "ccaTags.setVolunteering",
            () =>
              c.ccaTags.setVolunteering({
                ccaID: SOCCER,
                isVolunteering: true,
              }),
          ],
          ["awards.list", () => c.awards.list({ academicYear: AY })],
          [
            "awards.create",
            () =>
              c.awards.create({ academicYear: AY, userID: R12.id, title: "T" }),
          ],
          ["awards.void", () => c.awards.void({ id: award.id })],
          [
            "jcrc.saveFor",
            () =>
              c.jcrc.saveFor({
                academicYear: AY,
                userID: JCRC.id,
                portfolio: "",
                position: "",
                description: "",
                contributions: [],
                testimonial: "",
              }),
          ],
          ["jcrc.mine", () => c.jcrc.mine({ academicYear: AY })],
          [
            "jcrc.saveMine",
            () =>
              c.jcrc.saveMine({
                academicYear: AY,
                portfolio: "",
                position: "",
                description: "",
                contributions: [],
                testimonial: "",
              }),
          ],
          ["residents.search", () => c.residents.search({ query: "Seed" })],
          [
            "roster.list",
            () => c.roster.list({ ccaID: SOCCER, academicYear: AY }),
          ],
          [
            "roster.upsert",
            () =>
              c.roster.upsert({
                ccaID: SOCCER,
                academicYear: AY,
                userID: R12.id,
                duration: "sem1",
              }),
          ],
          [
            "volunteer.list",
            () => c.volunteer.list({ ccaID: RVC_CHILDREN, academicYear: AY }),
          ],
          [
            "volunteer.create",
            () =>
              c.volunteer.create({
                ccaID: RVC_CHILDREN,
                academicYear: AY,
                userID: R12.id,
                kind: "regular",
                activity: "x",
                hours: 1,
              }),
          ],
          ["volunteer.void", () => c.volunteer.void({ id: volunteer.id })],
        ];

        for (const [name, call] of calls) {
          const result = await errorOf(call());
          expect(result, name).toMatch(/^FORBIDDEN:/);
        }
        expect(
          await db.volunteerRecord.findUnique({ where: { id: volunteer.id } }),
        ).not.toBeNull();
      });

      it("is rejected as unauthenticated when not signed in", async () => {
        expect(await errorOf(as(null).transcriptManage.ccaTags.list())).toBe(
          "UNAUTHORIZED:UNAUTHORIZED",
        );
        expect(
          await errorOf(
            as(null).transcriptManage.roster.list({
              ccaID: SOCCER,
              academicYear: AY,
            }),
          ),
        ).toBe("UNAUTHORIZED:UNAUTHORIZED");
      });

      it("cannot get in by claiming a role the live database does not give them", async () => {
        const claimsJcrc = as({
          id: PLAIN.id,
          roles: ["jcrc", "admin", "cca_head"],
        }).transcriptManage;

        expect(await errorOf(claimsJcrc.ccaTags.list())).toBe(
          "FORBIDDEN:INSUFFICIENT_ROLE",
        );
        expect(
          await errorOf(
            claimsJcrc.roster.list({ ccaID: SOCCER, academicYear: AY }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(await errorOf(claimsJcrc.jcrc.mine({ academicYear: AY }))).toBe(
          "FORBIDDEN:JCRC_MEMBER_REQUIRED",
        );
      });

      it("is also refused by hall office (scrc)", async () => {
        const scrc = as({ id: PLAIN.id, roles: ["scrc"] }).transcriptManage;

        expect(await errorOf(scrc.ccaTags.list())).toMatch(/^FORBIDDEN:/);
        expect(await errorOf(scrc.residents.search({ query: "Seed" }))).toMatch(
          /^FORBIDDEN:/,
        );
      });
    });

    /* ------------------------------------------------------------------ */
    describe("a CCA head", () => {
      it("can use their own CCA but not another's", async () => {
        const soccer = as(SOCCER_HEAD).transcriptManage;

        expect(
          await errorOf(
            soccer.roster.list({ ccaID: SOCCER, academicYear: AY }),
          ),
        ).toBe("ok");
        for (const other of [CHOIR, RVC_CHILDREN, RVC_PROJECTS]) {
          expect(
            await errorOf(
              soccer.roster.list({ ccaID: other, academicYear: AY }),
            ),
          ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        }
        expect(
          await errorOf(
            soccer.roster.upsert({
              ccaID: CHOIR,
              academicYear: AY,
              userID: R12.id,
              duration: "sem1",
            }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(
          (
            await db.transcriptRosterEntry.findUnique({
              where: {
                academicYear_userID_ccaID: {
                  academicYear: AY,
                  userID: R12.id,
                  ccaID: CHOIR,
                },
              },
            })
          )?.duration,
        ).toBe("sem1"); // the seeded value, untouched
      });

      it("a volunteering head cannot see or change another volunteering CCA's records", async () => {
        const children = as(RVC_CHILDREN_HEAD).transcriptManage;
        const projectsRecord = await aVolunteerRecordOf(RVC_PROJECTS);

        expect(
          await errorOf(
            children.volunteer.list({ ccaID: RVC_PROJECTS, academicYear: AY }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(
          await errorOf(
            children.volunteer.create({
              ccaID: RVC_PROJECTS,
              academicYear: AY,
              userID: R12.id,
              kind: "regular",
              activity: "x",
              hours: 1,
            }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(
          await errorOf(children.volunteer.void({ id: projectsRecord.id })),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
      });

      it("is not given the manager-only procedures", async () => {
        const head = as(SOCCER_HEAD).transcriptManage;

        expect(await errorOf(head.ccaTags.list())).toBe(
          "FORBIDDEN:INSUFFICIENT_ROLE",
        );
        expect(await errorOf(head.awards.list({ academicYear: AY }))).toBe(
          "FORBIDDEN:INSUFFICIENT_ROLE",
        );
        expect(await errorOf(head.residents.search({ query: "Seed" }))).toBe(
          "FORBIDDEN:NOT_A_VOLUNTEERING_HEAD",
        );
        expect(
          await errorOf(
            head.jcrc.saveMine({
              academicYear: AY,
              portfolio: "",
              position: "",
              description: "",
              contributions: [],
              testimonial: "",
            }),
          ),
        ).toBe("FORBIDDEN:JCRC_MEMBER_REQUIRED");
      });
    });

    describe("a manager", () => {
      it.each([
        ["jcrc", JCRC],
        ["admin", ADMIN],
      ])(
        "%s may act on any CCA and use every manager procedure",
        async (_name, who) => {
          const m = as(who).transcriptManage;

          for (const ccaID of [SOCCER, CHOIR, RVC_CHILDREN]) {
            expect(
              await errorOf(m.roster.list({ ccaID, academicYear: AY })),
            ).toBe("ok");
          }
          expect(
            await errorOf(
              m.roster.upsert({
                ccaID: SOCCER,
                academicYear: AY,
                userID: R12.id,
                duration: "sem2",
              }),
            ),
          ).toBe("ok");
          expect(
            await errorOf(
              m.volunteer.create({
                ccaID: RVC_CHILDREN,
                academicYear: AY,
                userID: R12.id,
                kind: "regular",
                activity: "Tuition",
                hours: 2,
              }),
            ),
          ).toBe("ok");
          expect(await errorOf(m.ccaTags.list())).toBe("ok");
          expect(await errorOf(m.awards.list({ academicYear: AY }))).toBe("ok");
          expect(
            await errorOf(
              m.awards.create({
                academicYear: AY,
                userID: R12.id,
                title: "Award",
              }),
            ),
          ).toBe("ok");
          expect(await errorOf(m.residents.search({ query: "Seed" }))).toBe(
            "ok",
          );
          expect(
            await errorOf(
              m.jcrc.saveFor({
                academicYear: AY,
                userID: JCRC.id,
                portfolio: "P",
                position: "Q",
                description: "d",
                contributions: [],
                testimonial: "t",
              }),
            ),
          ).toBe("ok");
        },
      );
    });

    /* ------------------------------------------------------------------ */
    describe("the academic year must be collecting", () => {
      it("rejects every write once published, and allows them again after reopen", async () => {
        const volunteer = await aVolunteerRecordOf(RVC_PROJECTS);
        const award = await db.award.findFirstOrThrow({ where: seeded });
        await publish();

        const writes: Array<[string, () => Promise<unknown>]> = [
          [
            "roster.upsert",
            () =>
              as(SOCCER_HEAD).transcriptManage.roster.upsert({
                ccaID: SOCCER,
                academicYear: AY,
                userID: R12.id,
                duration: "sem1",
              }),
          ],
          [
            "volunteer.create",
            () =>
              as(RVC_CHILDREN_HEAD).transcriptManage.volunteer.create({
                ccaID: RVC_CHILDREN,
                academicYear: AY,
                userID: R12.id,
                kind: "regular",
                activity: "x",
                hours: 1,
              }),
          ],
          [
            "volunteer.void",
            () =>
              as(RVC_PROJECTS_HEAD).transcriptManage.volunteer.void({
                id: volunteer.id,
              }),
          ],
          [
            "awards.create",
            () =>
              as(JCRC).transcriptManage.awards.create({
                academicYear: AY,
                userID: R12.id,
                title: "T",
              }),
          ],
          [
            "awards.void",
            () => as(JCRC).transcriptManage.awards.void({ id: award.id }),
          ],
          [
            "jcrc.saveFor",
            () =>
              as(JCRC).transcriptManage.jcrc.saveFor({
                academicYear: AY,
                userID: JCRC.id,
                portfolio: "",
                position: "",
                description: "",
                contributions: [],
                testimonial: "",
              }),
          ],
          [
            "jcrc.saveMine",
            () =>
              as(JCRC).transcriptManage.jcrc.saveMine({
                academicYear: AY,
                portfolio: "",
                position: "",
                description: "",
                contributions: [],
                testimonial: "",
              }),
          ],
        ];
        for (const [name, run] of writes) {
          expect(await errorOf(run()), name).toBe(
            "PRECONDITION_FAILED:PERIOD_PUBLISHED",
          );
        }
        // Nothing was written.
        expect(
          (await db.volunteerRecord.findUnique({ where: { id: volunteer.id } }))
            ?.voidedAt ?? null,
        ).toBeNull();
        expect(
          (await db.award.findUnique({ where: { id: award.id } }))?.voidedAt ??
            null,
        ).toBeNull();

        // Reads still work, and the volunteering tag belongs to no year.
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.roster.list({
              ccaID: SOCCER,
              academicYear: AY,
            }),
          ),
        ).toBe("ok");
        expect(
          await errorOf(
            as(JCRC).transcriptManage.ccaTags.setVolunteering({
              ccaID: SOCCER,
              isVolunteering: true,
            }),
          ),
        ).toBe("ok");

        await as(JCRC).transcript.periods.reopen({ academicYear: AY });
        for (const [name, run] of writes.slice(0, 2)) {
          expect(await errorOf(run()), name).toBe("ok");
        }
      });
    });

    /* ------------------------------------------------------------------ */
    describe("roster", () => {
      it("rejects an override for someone who is not a current member", async () => {
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.roster.upsert({
              ccaID: SOCCER,
              academicYear: AY,
              userID: R20.id,
              duration: "sem1",
            }),
          ),
        ).toBe("BAD_REQUEST:NOT_A_MEMBER");
        expect(
          await db.transcriptRosterEntry.count({
            where: { academicYear: AY, userID: R20.id, ccaID: SOCCER },
          }),
        ).toBe(0);
      });

      it("sets, changes and clears overrides, and lists them beside the defaults", async () => {
        const soccer = as(SOCCER_HEAD).transcriptManage;

        await soccer.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: R12.id,
          duration: "sem2",
          roleLabel: "Treasurer",
          roleDuration: "sem2",
          extraContribution: "  Kept the books.  ",
        });
        let row = (await rosterOf(SOCCER_HEAD, SOCCER)).find(
          (r) => r.userID === R12.id,
        )!;
        expect(row).toMatchObject({
          duration: "sem2",
          roleLabel: "Treasurer",
          roleDuration: "sem2",
          extraContribution: "Kept the books.",
        });
        expect(row.effective).toEqual({
          duration: "sem2",
          roleLabel: "Treasurer",
          roleDuration: "sem2",
          extraContribution: "Kept the books.",
        });

        // Omitted fields stay; null clears one.
        await soccer.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: R12.id,
          roleLabel: null,
          extraContribution: "",
        });
        row = (await rosterOf(SOCCER_HEAD, SOCCER)).find(
          (r) => r.userID === R12.id,
        )!;
        expect(row).toMatchObject({
          duration: "sem2",
          roleLabel: null,
          roleDuration: "sem2",
          extraContribution: null,
        });
        expect(row.effective.duration).toBe("sem2");
        expect(row.effective.roleLabel).toBeNull();
      });

      it("refuses a role period that sticks out of the membership period", async () => {
        const soccer = as(SOCCER_HEAD).transcriptManage;
        const base = { ccaID: SOCCER, academicYear: AY, userID: R12.id };

        // semester 2 member, role for semester 1 or the full year
        expect(
          await errorOf(
            soccer.roster.upsert({
              ...base,
              duration: "sem2",
              roleLabel: "Treasurer",
              roleDuration: "sem1",
            }),
          ),
        ).toBe("BAD_REQUEST:ROLE_PERIOD_OUTSIDE_MEMBERSHIP");
        expect(
          await errorOf(
            soccer.roster.upsert({
              ...base,
              duration: "sem2",
              roleLabel: "Treasurer",
              roleDuration: "full",
            }),
          ),
        ).toBe("BAD_REQUEST:ROLE_PERIOD_OUTSIDE_MEMBERSHIP");
        // nothing was stored by the refused calls
        expect(
          await db.transcriptRosterEntry.count({
            where: {
              academicYear: AY,
              userID: R12.id,
              ccaID: SOCCER,
              roleDuration: "sem1",
            },
          }),
        ).toBe(0);

        // a compatible pair is accepted
        expect(
          await errorOf(
            soccer.roster.upsert({
              ...base,
              duration: "sem2",
              roleLabel: "Treasurer",
              roleDuration: "sem2",
            }),
          ),
        ).toBe("ok");
        // narrowing the membership under a stored role period is refused too
        expect(
          await errorOf(soccer.roster.upsert({ ...base, duration: "sem1" })),
        ).toBe("BAD_REQUEST:ROLE_PERIOD_OUTSIDE_MEMBERSHIP");
        // narrowing both together is fine
        expect(
          await errorOf(
            soccer.roster.upsert({
              ...base,
              duration: "sem1",
              roleDuration: "sem1",
            }),
          ),
        ).toBe("ok");
        // a full-year member may hold a role for one semester
        expect(
          await errorOf(
            soccer.roster.upsert({
              ...base,
              duration: "full",
              roleDuration: "sem2",
            }),
          ),
        ).toBe("ok");
        expect(errorText("ROLE_PERIOD_OUTSIDE_MEMBERSHIP")).toBe(
          "The role period must fit inside the membership period.",
        );
      });

      it("never lets a semester 2 member publish or render as a full-year head", async () => {
        // Seeded data that disagrees with itself: a head with a full-year role
        // inside a semester 2 membership, written straight to the database.
        await db.transcriptRosterEntry.deleteMany({
          where: { academicYear: AY, userID: "SEED-R05", ccaID: CHOIR },
        });
        await db.transcriptRosterEntry.create({
          data: {
            academicYear: AY,
            userID: "SEED-R05",
            ccaID: CHOIR,
            frozen: false,
            duration: "sem2",
            roleLabel: "Head",
            roleDuration: "full",
          },
        });

        await as(JCRC).transcript.periods.publish({ academicYear: AY });

        const frozen = await db.transcriptRosterEntry.findFirstOrThrow({
          where: { academicYear: AY, userID: "SEED-R05", ccaID: CHOIR },
        });
        expect(frozen).toMatchObject({
          duration: "sem2",
          roleDuration: "sem2",
          frozen: true,
        });
        // Even if bad data reaches a frozen row, the transcript clamps it.
        await db.transcriptRosterEntry.update({
          where: { id: frozen.id },
          data: { roleDuration: "full" },
        });
        const preview = await as(JCRC).transcript.preview({
          userID: "SEED-R05",
          academicYear: AY,
        });
        const main = preview.transcript.pages.find((x) => x.kind === "main");
        const rows =
          main?.kind === "main"
            ? main.sections.flatMap((x) =>
                x.kind === "involvements" ? x.rows : [],
              )
            : [];
        const choir = rows.find((r) => r.ccaName.includes("Choir"));
        expect(choir?.role).toMatch(/Sem 2/);
        expect(choir?.role).not.toMatch(/full/i);
      });

      it("validates what it is given", async () => {
        const soccer = as(SOCCER_HEAD).transcriptManage;
        const base = { ccaID: SOCCER, academicYear: AY, userID: R12.id };

        expect(
          await errorOf(
            soccer.roster.upsert({ ...base, duration: "sem3" as never }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            soccer.roster.upsert({ ...base, roleLabel: "r".repeat(61) }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            soccer.roster.upsert({
              ...base,
              extraContribution: "e".repeat(501),
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            soccer.roster.upsert({ ...base, roleLabel: "bad\u0000label" }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            soccer.roster.upsert({ ...base, academicYear: "2026" }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
      });

      it("shows the derived defaults: heads, late joiners, and full year when sem2Start is unset", async () => {
        const soccerRows = await rosterOf(SOCCER_HEAD, SOCCER);
        const head = soccerRows.find((r) => r.userID === SOCCER_HEAD.id)!;
        expect(head).toMatchObject({
          isHead: true,
          defaultRoleLabel: "Head",
          defaultRoleDuration: "full",
          roleLabel: "Captain",
        });
        const plain = soccerRows.find((r) => r.userID === R12.id)!;
        expect(plain).toMatchObject({
          isHead: false,
          defaultRoleLabel: null,
          defaultRoleDuration: null,
        });
        expect("matric" in plain).toBe(false);
        expect(plain.displayName).toBe("Seed Resident 12");

        // A member accepted after semester 2 began defaults to sem2.
        const late = await db.ccaApplication.findFirstOrThrow({
          where: {
            userID: { startsWith: "SEED-" },
            status: "accepted",
            decidedAt: { gte: SEM2_START },
          },
        });
        const lateRow = (await rosterOf(ADMIN, late.ccaID)).find(
          (r) => r.userID === late.userID,
        )!;
        expect(lateRow.defaultDuration).toBe("sem2");

        // With no semester-2 date everything defaults to a full year.
        await as(JCRC).transcript.periods.setSem2Start({
          academicYear: AY,
          sem2Start: null,
        });
        const afterClear = (await rosterOf(ADMIN, late.ccaID)).find(
          (r) => r.userID === late.userID,
        )!;
        expect(afterClear.defaultDuration).toBe("full");
        expect(
          afterClear.defaultRoleDuration === null ||
            afterClear.defaultRoleDuration === "full",
        ).toBe(true);
      });

      it("shows the frozen entries once the year is published", async () => {
        await publish();

        const result = await as(SOCCER_HEAD).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });

        expect(result.status).toBe("published");
        const frozen = await db.transcriptRosterEntry.count({
          where: { academicYear: AY, ccaID: SOCCER, frozen: true },
        });
        expect(result.rows).toHaveLength(frozen);
        expect(
          result.rows.find((r) => r.userID === SOCCER_HEAD.id),
        ).toMatchObject({ roleLabel: "Captain", duration: "full" });
      });

      it("reports an unknown CCA as not found for a manager", async () => {
        expect(
          await errorOf(
            as(JCRC).transcriptManage.roster.list({
              ccaID: 424242,
              academicYear: AY,
            }),
          ),
        ).toBe("NOT_FOUND:CCA_NOT_FOUND");
      });
    });

    /* ------------------------------------------------------------------ */
    describe("volunteering", () => {
      const record = (over: object = {}) => ({
        ccaID: RVC_CHILDREN,
        academicYear: AY,
        userID: R20.id,
        kind: "oneoff" as const,
        activity: "Beach clean-up",
        activityDate: "2026-09-12",
        hours: 4,
        ...over,
      });

      it("is refused for a CCA that is not a volunteering CCA, even for a manager", async () => {
        expect(
          await errorOf(
            as(SOCCER_HEAD).transcriptManage.volunteer.create(
              record({ ccaID: SOCCER }),
            ),
          ),
        ).toBe("PRECONDITION_FAILED:NOT_A_VOLUNTEERING_CCA");
        expect(
          await errorOf(
            as(JCRC).transcriptManage.volunteer.create(
              record({ ccaID: SOCCER }),
            ),
          ),
        ).toBe("PRECONDITION_FAILED:NOT_A_VOLUNTEERING_CCA");
      });

      it("lets a volunteering head record a one-off for a resident who is not a member", async () => {
        expect(
          await db.userCCA.count({
            where: { userID: R20.id, ccaID: RVC_CHILDREN },
          }),
        ).toBe(0);

        const { id } =
          await as(RVC_CHILDREN_HEAD).transcriptManage.volunteer.create(
            record(),
          );

        const stored = await db.volunteerRecord.findUniqueOrThrow({
          where: { id },
        });
        expect(stored).toMatchObject({
          academicYear: AY,
          userID: R20.id,
          ccaID: RVC_CHILDREN,
          kind: "oneoff",
          activity: "Beach clean-up",
          hours: 4,
          recordedBy: RVC_CHILDREN_HEAD.id,
        });
        expect(stored.activityDate?.toISOString().slice(0, 10)).toBe(
          "2026-09-12",
        );
        expect(stored.recordedAt).toBeInstanceOf(Date);
        const listed = await as(
          RVC_CHILDREN_HEAD,
        ).transcriptManage.volunteer.list({
          ccaID: RVC_CHILDREN,
          academicYear: AY,
        });
        expect(listed.find((r) => r.id === id)).toMatchObject({
          displayName: "Seed Resident 20",
          activityDate: "2026-09-12",
        });
      });

      it("records a regular entry with no date", async () => {
        const { id } = await as(
          RVC_CHILDREN_HEAD,
        ).transcriptManage.volunteer.create(
          record({
            kind: "regular",
            activityDate: undefined,
            activity: "Weekly tuition",
            hours: 1.25,
          }),
        );

        expect(
          await db.volunteerRecord.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({ kind: "regular", activityDate: null, hours: 1.25 });
      });

      it("checks the bounds and the resident", async () => {
        const head = as(RVC_CHILDREN_HEAD).transcriptManage;

        expect(
          await errorOf(head.volunteer.create(record({ hours: 0.1 }))),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(head.volunteer.create(record({ hours: 201 }))),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(head.volunteer.create(record({ hours: 1.3 }))),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            head.volunteer.create(record({ activityDate: undefined })),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            head.volunteer.create(record({ activityDate: "2026-07-31" })),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            head.volunteer.create(record({ activityDate: "2027-08-01" })),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(head.volunteer.create(record({ activity: "  " }))),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(head.volunteer.create(record({ userID: "SEED-R99" }))),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");
        expect(
          await errorOf(
            head.volunteer.create(record({ activityDate: "2026-08-01" })),
          ),
        ).toBe("ok");
        expect(
          await errorOf(
            head.volunteer.create(record({ activityDate: "2027-07-31" })),
          ),
        ).toBe("ok");
      });

      it("voids, never deletes: by the head of that CCA or a manager, and is idempotent", async () => {
        const { id } =
          await as(RVC_CHILDREN_HEAD).transcriptManage.volunteer.create(
            record(),
          );
        const before = await db.volunteerRecord.count();

        expect(
          await errorOf(
            as(RVC_PROJECTS_HEAD).transcriptManage.volunteer.void({ id }),
          ),
        ).toBe("FORBIDDEN:NOT_A_HEAD_OF_THIS_CCA");
        expect(
          await as(RVC_CHILDREN_HEAD).transcriptManage.volunteer.void({ id }),
        ).toEqual({ id, voided: true });
        const first = await db.volunteerRecord.findUniqueOrThrow({
          where: { id },
        });
        expect(first.voidedAt).toBeInstanceOf(Date);
        expect(first.voidedBy).toBe(RVC_CHILDREN_HEAD.id);
        expect(await db.volunteerRecord.count()).toBe(before);

        expect(await as(JCRC).transcriptManage.volunteer.void({ id })).toEqual({
          id,
          voided: true,
        });
        expect(
          (await db.volunteerRecord.findUniqueOrThrow({ where: { id } }))
            .voidedAt,
        ).toEqual(first.voidedAt);
        // A later void by someone else does not rewrite who voided it.
        expect(
          (await db.volunteerRecord.findUniqueOrThrow({ where: { id } }))
            .voidedBy,
        ).toBe(RVC_CHILDREN_HEAD.id);
        const listed = await as(
          RVC_CHILDREN_HEAD,
        ).transcriptManage.volunteer.list({
          ccaID: RVC_CHILDREN,
          academicYear: AY,
        });
        expect(listed.find((r) => r.id === id)).toBeUndefined();
        expect(
          await errorOf(
            as(JCRC).transcriptManage.volunteer.void({
              id: "0123456789abcdef01234567",
            }),
          ),
        ).toBe("NOT_FOUND:RECORD_NOT_FOUND");
      });
    });

    /* ------------------------------------------------------------------ */
    describe("volunteering tags", () => {
      it("lists the four RVC CCAs as volunteering", async () => {
        const list = await as(JCRC).transcriptManage.ccaTags.list();

        expect(list).toHaveLength(14);
        expect(
          list
            .filter((c) => c.isVolunteering)
            .map((c) => c.ccaName)
            .sort(),
        ).toEqual([
          "RVC Children",
          "RVC Pioneers",
          "RVC Special Needs",
          "RVC Special Projects",
        ]);
      });

      it("touches only isVolunteering, updatedAt and updatedBy on the CCA's profile", async () => {
        const before = await db.ccaProfile.findUniqueOrThrow({
          where: { ccaID: SOCCER },
        });
        await db.ccaProfile.update({
          where: { ccaID: SOCCER },
          data: {
            logoUrl: "https://blob.example/logo.png",
            bannerUrl: "https://blob.example/banner.png",
          },
        });
        const withImages = await db.ccaProfile.findUniqueOrThrow({
          where: { ccaID: SOCCER },
        });

        await as(JCRC).transcriptManage.ccaTags.setVolunteering({
          ccaID: SOCCER,
          isVolunteering: true,
        });

        const after = await db.ccaProfile.findUniqueOrThrow({
          where: { ccaID: SOCCER },
        });
        expect(after.description).toBe(before.description);
        expect(after.logoUrl).toBe(withImages.logoUrl);
        expect(after.bannerUrl).toBe(withImages.bannerUrl);
        expect(after.isVolunteering).toBe(true);
        expect(after.updatedBy).toBe(JCRC.id);
        expect(after.updatedAt).toBeInstanceOf(Date);
        // Everything except the three fields the tag may touch is unchanged.
        const untouchedPart = (row: typeof after) => ({
          ...row,
          isVolunteering: undefined,
          updatedAt: undefined,
          updatedBy: undefined,
        });
        expect(untouchedPart(after)).toEqual(untouchedPart(withImages));
      });

      it("creates a profile with only those fields for a CCA that had none, and can untag", async () => {
        expect(
          await db.ccaProfile.findUnique({ where: { ccaID: 9010 } }),
        ).toBeNull();

        await as(ADMIN).transcriptManage.ccaTags.setVolunteering({
          ccaID: 9010,
          isVolunteering: true,
        });
        const created = await db.ccaProfile.findUniqueOrThrow({
          where: { ccaID: 9010 },
        });
        expect(created).toMatchObject({
          isVolunteering: true,
          updatedBy: ADMIN.id,
        });
        expect(created.description ?? null).toBeNull();
        expect(created.logoUrl ?? null).toBeNull();

        await as(ADMIN).transcriptManage.ccaTags.setVolunteering({
          ccaID: 9010,
          isVolunteering: false,
        });
        expect(
          (await db.ccaProfile.findUniqueOrThrow({ where: { ccaID: 9010 } }))
            .isVolunteering,
        ).toBe(false);
        expect(
          await errorOf(
            as(JCRC).transcriptManage.volunteer.create({
              ccaID: 9010,
              academicYear: AY,
              userID: R12.id,
              kind: "regular",
              activity: "x",
              hours: 1,
            }),
          ),
        ).toMatch(/^FORBIDDEN|^PRECONDITION_FAILED:NOT_A_VOLUNTEERING_CCA/);
      });

      it("rejects an unknown CCA and never writes the guarded collections", async () => {
        const ccaCount = await db.cCA.count();
        const userCcaCount = await db.userCCA.count();
        const userCount = await db.user.count();

        expect(
          await errorOf(
            as(JCRC).transcriptManage.ccaTags.setVolunteering({
              ccaID: 424242,
              isVolunteering: true,
            }),
          ),
        ).toBe("NOT_FOUND:CCA_NOT_FOUND");
        await as(JCRC).transcriptManage.ccaTags.setVolunteering({
          ccaID: SOCCER,
          isVolunteering: true,
        });
        await as(SOCCER_HEAD).transcriptManage.roster.upsert({
          ccaID: SOCCER,
          academicYear: AY,
          userID: R12.id,
          duration: "sem1",
        });

        expect(await db.cCA.count()).toBe(ccaCount);
        expect(await db.userCCA.count()).toBe(userCcaCount);
        expect(await db.user.count()).toBe(userCount);
      });
    });

    /* ------------------------------------------------------------------ */
    describe("awards", () => {
      it("creates, lists, and voids without ever deleting", async () => {
        const m = as(JCRC).transcriptManage;
        const total = await db.award.count();

        const { id } = await m.awards.create({
          academicYear: AY,
          userID: R20.id,
          title: "  Best Newcomer  ",
          citation: "  For effort.  ",
        });
        expect(await db.award.count()).toBe(total + 1);
        expect(
          await db.award.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({
          userID: R20.id,
          title: "Best Newcomer",
          citation: "For effort.",
          ceremony: "Colours Awards",
          recordedBy: JCRC.id,
        });
        expect(
          (await m.awards.list({ academicYear: AY, userID: R20.id })).map(
            (a) => a.id,
          ),
        ).toEqual([id]);

        expect(await m.awards.void({ id })).toEqual({ id, voided: true });
        expect(
          (await db.award.findUniqueOrThrow({ where: { id } })).voidedBy,
        ).toBe(JCRC.id);
        expect(await db.award.count()).toBe(total + 1); // still there
        expect(
          (await db.award.findUniqueOrThrow({ where: { id } })).voidedAt,
        ).toBeInstanceOf(Date);
        expect(
          await m.awards.list({ academicYear: AY, userID: R20.id }),
        ).toEqual([]);
        expect(
          (
            await m.awards.list({
              academicYear: AY,
              userID: R20.id,
              includeVoided: true,
            })
          ).map((a) => a.id),
        ).toEqual([id]);
        expect(await m.awards.void({ id })).toEqual({ id, voided: true });
      });

      it("checks the resident and the bounds", async () => {
        const m = as(ADMIN).transcriptManage;

        expect(
          await errorOf(
            m.awards.create({
              academicYear: AY,
              userID: "SEED-R99",
              title: "T",
            }),
          ),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");
        expect(
          await errorOf(
            m.awards.create({ academicYear: AY, userID: R12.id, title: "" }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            m.awards.create({
              academicYear: AY,
              userID: R12.id,
              title: "t".repeat(121),
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            m.awards.create({
              academicYear: AY,
              userID: R12.id,
              title: "T",
              citation: "c".repeat(301),
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(m.awards.void({ id: "0123456789abcdef01234567" })),
        ).toBe("NOT_FOUND:RECORD_NOT_FOUND");
      });
    });

    /* ------------------------------------------------------------------ */
    describe("JCRC records", () => {
      const ROW = { activity: "Ran it", role: "", description: "" };
      const fields = {
        academicYear: AY,
        portfolio: "Welfare",
        position: "Treasurer",
        description: "Looks after the budget.",
        contributions: [
          {
            activity: "Balanced the books.",
            role: "Treasurer",
            description: "",
          },
        ],
        testimonial: "Reliable.",
      };

      it("lets a JCRC member save only their own record, and keeps it a placeholder", async () => {
        const before = await db.jcrcService.findUniqueOrThrow({
          where: {
            academicYear_userID: { academicYear: AY, userID: JCRC_HEAD.id },
          },
        });

        // A userID in the payload is not an input: it is dropped, not obeyed.
        await as(JCRC).transcriptManage.jcrc.saveMine({
          ...fields,
          userID: JCRC_HEAD.id,
        } as never);

        const row = await db.jcrcService.findUniqueOrThrow({
          where: { academicYear_userID: { academicYear: AY, userID: JCRC.id } },
        });
        expect(row.updatedBy).toBe(JCRC.id);
        expect(row.updatedAt).toBeInstanceOf(Date);
        const mine = await as(JCRC).transcriptManage.jcrc.mine({
          academicYear: AY,
        });
        expect(mine).toMatchObject({
          userID: JCRC.id,
          portfolio: "Welfare",
          position: "Treasurer",
          isPlaceholder: true,
        });
        const other = await db.jcrcService.findUniqueOrThrow({
          where: {
            academicYear_userID: { academicYear: AY, userID: JCRC_HEAD.id },
          },
        });
        expect(other.portfolio).toBe(before.portfolio);
        expect(other.testimonial).toBe(before.testimonial);
      });

      it("is refused for anyone without the live jcrc role, admin included", async () => {
        for (const who of [PLAIN, SOCCER_HEAD, ADMIN]) {
          expect(
            await errorOf(as(who).transcriptManage.jcrc.saveMine(fields)),
            who.id,
          ).toBe("FORBIDDEN:JCRC_MEMBER_REQUIRED");
          expect(
            await errorOf(
              as(who).transcriptManage.jcrc.mine({ academicYear: AY }),
            ),
            who.id,
          ).toBe("FORBIDDEN:JCRC_MEMBER_REQUIRED");
        }
        expect(
          await db.jcrcService.count({
            where: { userID: { in: [PLAIN.id, SOCCER_HEAD.id, ADMIN.id] } },
          }),
        ).toBe(0);
      });

      it("enforces the field limits", async () => {
        const m = as(JCRC).transcriptManage.jcrc;

        expect(
          await errorOf(
            m.saveMine({ ...fields, contributions: Array(11).fill(ROW) }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            m.saveMine({
              ...fields,
              contributions: [{ ...ROW, activity: "c".repeat(81) }],
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            m.saveMine({ ...fields, description: "d".repeat(801) }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            m.saveMine({ ...fields, testimonial: "t".repeat(1501) }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(m.saveMine({ ...fields, portfolio: "p".repeat(81) })),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            m.saveMine({
              ...fields,
              contributions: Array(10).fill(ROW),
              testimonial: "t".repeat(1500),
            }),
          ),
        ).toBe("ok");
      });

      it("stores contribution rows in order, with a blank role or description kept blank", async () => {
        const rows = [
          { activity: "Second thing", role: "", description: "" },
          { activity: "First thing", role: "Lead", description: "Did it." },
        ];

        await as(JCRC).transcriptManage.jcrc.saveMine({
          ...fields,
          contributions: rows,
        });

        const mine = await as(JCRC).transcriptManage.jcrc.mine({
          academicYear: AY,
        });
        expect(mine?.contributions).toEqual(rows);
        const stored = await db.jcrcService.findFirstOrThrow({
          where: { userID: JCRC.id, academicYear: AY },
        });
        expect(stored.contributions[0]).toEqual({
          activity: "Second thing",
          role: null,
          description: null,
        });
        const preview = await as(JCRC).transcript.preview({
          userID: JCRC.id,
          academicYear: AY,
        });
        const page = preview.transcript.pages.find((x) => x.kind === "jcrc");
        expect(page?.kind === "jcrc" ? page.jcrc.contributions : []).toEqual(
          rows,
        );
      });

      it("lets a manager save anyone's, for an existing resident only", async () => {
        await as(JCRC).transcriptManage.jcrc.saveFor({
          ...fields,
          userID: JCRC_HEAD.id,
        });

        expect(
          await db.jcrcService.findUniqueOrThrow({
            where: {
              academicYear_userID: { academicYear: AY, userID: JCRC_HEAD.id },
            },
          }),
        ).toMatchObject({
          position: "Treasurer",
          isPlaceholder: true,
          updatedBy: JCRC.id,
        });
        expect(
          await errorOf(
            as(JCRC).transcriptManage.jcrc.saveFor({
              ...fields,
              userID: "SEED-R99",
            }),
          ),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");
      });

      it("returns null for a year with no record", async () => {
        expect(
          await as(JCRC).transcriptManage.jcrc.mine({
            academicYear: "AY2027/28",
          }),
        ).toBeNull();
      });
    });

    /* ------------------------------------------------------------------ */
    describe("resident search", () => {
      it("returns at most 10, only a key, a name and a masked matric", async () => {
        const hits = await as(JCRC).transcriptManage.residents.search({
          query: "Seed",
        });

        expect(hits).toHaveLength(10);
        for (const h of hits)
          expect(Object.keys(h).sort()).toEqual([
            "displayName",
            "maskedMatric",
            "userID",
          ]);
      });

      it("never returns a full matric, for any seeded resident", async () => {
        const hits = await as(JCRC).transcriptManage.residents.search({
          query: "Seed",
        });

        expect(hits.length).toBeGreaterThan(0);
        expect(JSON.stringify(hits)).not.toMatch(/A99\d{2}000X/);
        for (const h of hits) expect(h.maskedMatric).toMatch(/^A\*{5}00X$/);
      });

      it("lets a head of a volunteering CCA search by name only, not by matric or email", async () => {
        const head = as(RVC_CHILDREN_HEAD).transcriptManage.residents;

        const byName = await head.search({ query: "Resident 12" });
        expect(byName.map((h) => h.userID)).toEqual([R12.id]);
        expect(await head.search({ query: "A9912000" })).toEqual([]);
        expect(await head.search({ query: "seed-r12" })).toEqual([]);
      });

      it("is limited to 60 requests per user per 10 minutes", async () => {
        const who = as(RVC_PROJECTS_HEAD).transcriptManage.residents;
        await db.rateLimit.deleteMany({
          where: { key: { startsWith: "transcript-search:" } },
        });

        for (let i = 0; i < 60; i += 1) await who.search({ query: "Seed" });
        const refused = await errorOf(who.search({ query: "Seed" }));
        expect(refused).toMatch(/^TOO_MANY_REQUESTS:RATE_LIMITED:\d+$/);

        // Another user's allowance is untouched.
        expect(
          await errorOf(
            as(RVC_CHILDREN_HEAD).transcriptManage.residents.search({
              query: "Seed",
            }),
          ),
        ).toBe("ok");
        await db.rateLimit.deleteMany({
          where: { key: { startsWith: "transcript-search:" } },
        });
      });

      it("finds by name and by matric", async () => {
        const byName = await as(JCRC).transcriptManage.residents.search({
          query: "Resident 12",
        });
        expect(byName).toEqual([
          {
            userID: R12.id,
            displayName: "Seed Resident 12",
            maskedMatric: "A*****00X",
          },
        ]);

        const byMatric = await as(ADMIN).transcriptManage.residents.search({
          query: "A9912000",
        });
        expect(byMatric.map((h) => h.userID)).toEqual([R12.id]);
      });

      it("needs 3 characters and is safe against regex characters", async () => {
        const m = as(JCRC).transcriptManage.residents;

        expect(await errorOf(m.search({ query: "ab" }))).toMatch(
          /^BAD_REQUEST:/,
        );
        expect(await errorOf(m.search({ query: "  ab  " }))).toMatch(
          /^BAD_REQUEST:/,
        );
        expect(await m.search({ query: "(.*)+" })).toEqual([]);
        expect(await m.search({ query: "[a-" })).toEqual([]);
      });

      it("is open to the head of a volunteering CCA, but only for finding residents", async () => {
        const hits = await as(
          RVC_CHILDREN_HEAD,
        ).transcriptManage.residents.search({
          query: "Seed",
        });

        expect(hits.length).toBeGreaterThan(0);
        expect(Object.keys(hits[0]!).sort()).toEqual([
          "displayName",
          "maskedMatric",
          "userID",
        ]);
      });

      it("is refused to residents, heads and hall office", async () => {
        for (const who of [
          PLAIN,
          SOCCER_HEAD,
          { id: PLAIN.id, roles: ["scrc"] },
        ]) {
          expect(
            await errorOf(
              as(who).transcriptManage.residents.search({ query: "Seed" }),
            ),
          ).toMatch(/^FORBIDDEN:/);
        }
      });
    });

    /* ------------------------------------------------------------------ */
    describe("the admin screens' assumptions", () => {
      it("stores the semester 2 date as midnight Singapore and shows it back as the same date", async () => {
        await as(JCRC).transcript.periods.setSem2Start({
          academicYear: AY,
          sem2Start: "2027-01-12",
        });

        const stored = await db.transcriptPeriod.findUniqueOrThrow({
          where: { academicYear: AY },
        });
        expect(stored.sem2Start?.toISOString()).toBe(
          "2027-01-11T16:00:00.000Z",
        );
        const roster = await as(JCRC).transcriptManage.roster.list({
          ccaID: SOCCER,
          academicYear: AY,
        });
        expect(roster.sem2Start).toBe("2027-01-12");
      });

      it("accepts a semester 2 date only inside the academic year", async () => {
        const c = as(JCRC).transcript.periods;

        expect(
          await errorOf(
            c.setSem2Start({ academicYear: AY, sem2Start: "2026-08-01" }),
          ),
        ).toBe("ok");
        expect(
          await errorOf(
            c.setSem2Start({ academicYear: AY, sem2Start: "2027-07-31" }),
          ),
        ).toBe("ok");
        expect(
          await errorOf(
            c.setSem2Start({ academicYear: AY, sem2Start: "2026-07-31" }),
          ),
        ).toBe("BAD_REQUEST:SEM2_START_OUTSIDE_YEAR");
        expect(
          await errorOf(
            c.setSem2Start({ academicYear: AY, sem2Start: "2027-08-01" }),
          ),
        ).toBe("BAD_REQUEST:SEM2_START_OUTSIDE_YEAR");
      });

      it("refuses an impossible semester 2 date instead of clearing the saved one", async () => {
        const c = as(JCRC).transcript.periods;
        await c.setSem2Start({ academicYear: AY, sem2Start: "2027-01-12" });

        expect(
          await errorOf(
            c.setSem2Start({ academicYear: AY, sem2Start: "2027-02-30" }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        const stored = await db.transcriptPeriod.findUniqueOrThrow({
          where: { academicYear: AY },
        });
        expect(stored.sem2Start?.toISOString()).toBe(
          "2027-01-11T16:00:00.000Z",
        );
      });

      it("returns the published count and the unmatched count for the publish summary", async () => {
        const result = await as(JCRC).transcript.periods.publish({
          academicYear: AY,
        });

        expect(result.frozen).toBeGreaterThan(0);
        expect(result.skippedUnresolved).toBe(0);
        const reopened = await as(JCRC).transcript.periods.reopen({
          academicYear: AY,
        });
        expect(reopened).toEqual({ academicYear: AY });
      });

      it("sends no full matric in any list a head or manager can read", async () => {
        const head = as(RVC_CHILDREN_HEAD).transcriptManage;
        const payloads = [
          await head.roster.list({ ccaID: RVC_CHILDREN, academicYear: AY }),
          await head.volunteer.list({ ccaID: RVC_CHILDREN, academicYear: AY }),
          await as(JCRC).transcriptManage.awards.list({
            academicYear: AY,
            includeVoided: true,
          }),
        ];

        for (const p of payloads) {
          expect(JSON.stringify(p)).not.toMatch(/A99\d{2}000X/);
          expect(JSON.stringify(p)).not.toContain("matric");
        }
      });

      it("keeps the admin tab's capability in step with who may manage transcripts", async () => {
        const { computeCapabilities } = await import(
          "~/server/api/services/roles"
        );
        const { canManageTranscriptPeriods } = await import(
          "~/lib/transcript/permissions"
        );

        for (const roles of [
          ["resident"],
          ["resident", "cca_head"],
          ["scrc"],
          ["resident", "jcrc"],
          ["admin", "resident"],
          ["jcrc", "cca_head", "resident"],
        ]) {
          expect(
            computeCapabilities(roles as never).manageCcaHeads,
            roles.join("+"),
          ).toBe(canManageTranscriptPeriods(roles));
        }
      });
    });
  },
);
