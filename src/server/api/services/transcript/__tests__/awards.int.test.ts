import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { awardActiveKey } from "~/lib/transcript/awards";

/**
 * INTEGRATION TESTS of awards (catalogue, assignment, bulk edits, upload
 * history) against the LOCAL development database (skipped unless DATABASE_URL
 * is localhost and the database is `rhapp_transcript_dev`; run `npm run
 * test:db`). The seed is re-run before every test. It gives a catalogue of five
 * awards (one archived, "Retired Award"); SEED-R04 holds "Colours Award,
 * Soccer"; SEED-R12 holds "Service Excellence Award" and "Outstanding
 * Newcomer"; SEED-R13 to R15 hold "Full Colours" from the upload
 * "colours-2026.csv".
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
const SOCCER_HEAD = R(4, ["cca_head", "resident"]);
const PLAIN = R(9, ["resident"]);
const SCRC = { id: PLAIN.id, roles: ["scrc", "resident"] };

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "awards (local database)",
  { timeout: 120_000 },
  () => {
    let db: PrismaClient;
    let createCaller: typeof CreateCaller;
    let loader: typeof import("../loader");
    let retention: typeof import("../retention");
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
      loader = await import("../loader");
      retention = await import("../retention");
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

    const type = (normalizedName: string) =>
      db.awardType.findUniqueOrThrow({ where: { normalizedName } });
    const fullColours = () => type("full colours");

    const live = { OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }] };
    const awardsOf = (userID: string, title?: string) =>
      db.award.findMany({
        where: {
          academicYear: AY,
          userID,
          ...(title ? { title } : {}),
          ...live,
        },
      });

    const publish = () =>
      db.transcriptPeriod.update({
        where: { academicYear: AY },
        data: {
          status: "published",
          publishedAt: new Date(),
          publishedBy: ADMIN.id,
        },
      });

    const assign = async (
      who: { id: string; roles: string[] },
      name: string,
      recipients: Array<{ userID: string; citation?: string | null }>,
    ) =>
      as(who).awards.assign({
        academicYear: AY,
        awardTypeID: (await type(name.toLowerCase())).id,
        recipients,
      });

    /* ---------------------------------------------------------------- */
    describe("one active award per year, person and award (F20)", () => {
      it("gives the award once when it is submitted five times at once", async () => {
        const t = await fullColours();
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            as(JCRC).awards.assign({
              academicYear: AY,
              awardTypeID: t.id,
              recipients: [{ userID: "SEED-R20" }],
            }),
          ),
        );

        expect(await awardsOf("SEED-R20", "Full Colours")).toHaveLength(1);
        expect(results.reduce((n, r) => n + r.assigned, 0)).toBe(1);
        expect(results.filter((r) => r.assigned === 0)).toHaveLength(4);
        for (const r of results.filter((x) => x.assigned === 0)) {
          expect(r.skipped.map((s) => s.userID)).toEqual(["SEED-R20"]);
        }
      });

      it("frees the key on remove and takes it back on restore", async () => {
        const a = (await awardsOf("SEED-R13", "Full Colours"))[0]!;
        const key = a.activeKey;
        expect(key).toBe(`${AY}|SEED-R13|${a.awardTypeID}`);

        await as(JCRC).awards.remove({ id: a.id });
        const removed = await db.award.findUniqueOrThrow({
          where: { id: a.id },
        });
        expect(removed.activeKey).toBe(`${key}|removed|${a.id}`);

        await as(JCRC).awards.restore({ id: a.id });
        const back = await db.award.findUniqueOrThrow({ where: { id: a.id } });
        expect(back.activeKey).toBe(key);
        expect(back.voidedAt ?? null).toBeNull();
      });

      it("lets someone be given the award again after a removal", async () => {
        const a = (await awardsOf("SEED-R13", "Full Colours"))[0]!;
        await as(JCRC).awards.remove({ id: a.id });

        const again = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R13" },
        ]);

        expect(again.assigned).toBe(1);
        expect(await awardsOf("SEED-R13", "Full Colours")).toHaveLength(1);
      });

      it("refuses to restore when an active twin exists: ALREADY_HAS_AWARD", async () => {
        const a = (await awardsOf("SEED-R13", "Full Colours"))[0]!;
        await as(JCRC).awards.remove({ id: a.id });
        await assign(JCRC, "Full Colours", [{ userID: "SEED-R13" }]);

        expect(await errorOf(as(JCRC).awards.restore({ id: a.id }))).toBe(
          "CONFLICT:ALREADY_HAS_AWARD",
        );
        expect(
          (await db.award.findUniqueOrThrow({ where: { id: a.id } })).voidedAt,
        ).not.toBeNull();
        const { errorText } = await import("~/lib/transcript/adminView");
        expect(errorText("ALREADY_HAS_AWARD")).toMatch(
          /already has this award/,
        );
      });

      it("refuses a second active copy at the database, whatever the code does", async () => {
        const a = (await awardsOf("SEED-R13", "Full Colours"))[0]!;
        await expect(
          db.award.create({
            data: {
              academicYear: AY,
              userID: a.userID,
              title: a.title,
              awardTypeID: a.awardTypeID,
              activeKey: a.activeKey,
            },
          }),
        ).rejects.toMatchObject({ code: "P2002" });
      });

      it("renaming an award with no catalogue entry moves its key, and refuses a clash", async () => {
        await db.award.create({
          data: {
            academicYear: AY,
            userID: "SEED-R20",
            title: "Old Plaque",
            activeKey: `${AY}|SEED-R20|title:old plaque`,
          },
        });
        await db.award.create({
          data: {
            academicYear: AY,
            userID: "SEED-R20",
            title: "New Plaque",
            activeKey: `${AY}|SEED-R20|title:new plaque`,
          },
        });
        const old = await db.award.findFirstOrThrow({
          where: { userID: "SEED-R20", title: "Old Plaque" },
        });

        expect(
          await errorOf(
            as(JCRC).awards.update({
              id: old.id,
              title: "New  Plaque",
              citation: null,
            }),
          ),
        ).toBe("CONFLICT:AWARD_DUPLICATE");
        expect(
          await errorOf(
            as(JCRC).awards.update({
              id: old.id,
              title: "Third Plaque",
              citation: null,
            }),
          ),
        ).toBe("ok");
        expect(
          (await db.award.findUniqueOrThrow({ where: { id: old.id } }))
            .activeKey,
        ).toBe(`${AY}|SEED-R20|title:third plaque`);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("an edit that loses a race with a remove (F38)", () => {
      it("is refused with AWARD_REMOVED and leaves the removed key alone", async () => {
        const { awardUpdate } = await import("../manageAwards");
        await db.award.create({
          data: {
            academicYear: AY,
            userID: "SEED-R20",
            title: "Old Plaque",
            activeKey: `${AY}|SEED-R20|title:old plaque`,
          },
        });
        const stale = await db.award.findFirstOrThrow({
          where: { userID: "SEED-R20", title: "Old Plaque" },
        });
        // The remove wins the race...
        await as(JCRC).awards.remove({ id: stale.id });
        const removedKey = (
          await db.award.findUniqueOrThrow({ where: { id: stale.id } })
        ).activeKey;
        expect(removedKey).toBe(`${stale.activeKey}|removed|${stale.id}`);

        // ...and the edit, which read the award before it was removed, writes after.
        const racing = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "award") {
              return new Proxy(target.award, {
                get(m, p) {
                  if (p === "findUnique") return () => Promise.resolve(stale);
                  const v: unknown = Reflect.get(m, p, m);
                  return typeof v === "function"
                    ? (v as (...a: unknown[]) => unknown).bind(m)
                    : v;
                },
              });
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

        expect(
          await errorOf(
            awardUpdate(racing, JCRC.id, {
              id: stale.id,
              title: "New Plaque",
              citation: null,
            }),
          ),
        ).toBe("CONFLICT:AWARD_REMOVED");
        const after = await db.award.findUniqueOrThrow({
          where: { id: stale.id },
        });
        expect(after.activeKey).toBe(removedKey);
        expect(after.title).toBe("Old Plaque");
        expect(after.voidedAt).not.toBeNull();
      });
    });

    /* ---------------------------------------------------------------- */
    describe("assigning to a big list (F25b)", () => {
      it("gives the award to a list of 500 and still reports an unknown person", async () => {
        const t = await fullColours();
        const known = Array.from(
          { length: 20 },
          (_, i) => `SEED-R${String(i + 1).padStart(2, "0")}`,
        );
        const recipients = Array.from({ length: 500 }, (_, i) => ({
          userID: known[i % known.length]!,
        }));

        const started = Date.now();
        const result = await as(JCRC).awards.assign({
          academicYear: AY,
          awardTypeID: t.id,
          recipients,
        });

        expect(Date.now() - started).toBeLessThan(30_000);
        expect(result.assigned + result.skipped.length).toBe(500);
        expect(result.assigned).toBeGreaterThan(0);

        expect(
          await errorOf(
            as(JCRC).awards.assign({
              academicYear: AY,
              awardTypeID: t.id,
              recipients: [
                ...recipients.slice(0, 5),
                { userID: "NO-SUCH-USER" },
              ],
            }),
          ),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");
      }, 120_000);
    });

    /* ---------------------------------------------------------------- */
    describe("bulk restore (F25)", () => {
      it("restores 300 removed awards quickly, in memory twin checks, and refuses twins", async () => {
        const t = await fullColours();
        const year = AY;
        // 300 removed awards for 300 made-up people, plus one active twin.
        const people = Array.from({ length: 300 }, (_, i) => `BULK-${i}`);
        const now = new Date();
        await db.award.createMany({
          data: people.map((userID, i) => ({
            academicYear: year,
            userID,
            title: "Full Colours",
            awardTypeID: t.id,
            voidedAt: now,
            voidedBy: ADMIN.id,
            activeKey: `${year}|${userID}|${t.id}|removed|bulk${i}`,
          })),
        });
        await db.award.create({
          data: {
            academicYear: year,
            userID: "BULK-0",
            title: "Full Colours",
            awardTypeID: t.id,
            activeKey: `${year}|BULK-0|${t.id}`,
          },
        });
        try {
          const ids = (
            await db.award.findMany({
              where: {
                userID: { startsWith: "BULK-" },
                voidedAt: { not: null },
              },
              select: { id: true },
            })
          ).map((a) => a.id);
          expect(ids).toHaveLength(300);

          const started = Date.now();
          const result = await as(JCRC).awards.bulkRestore({ ids });
          const seconds = (Date.now() - started) / 1000;

          expect(result.restored).toBe(299);
          expect(result.skipped).toHaveLength(1);
          expect(result.skipped[0]).toContain("Full Colours");
          expect(seconds).toBeLessThan(30);
          expect(
            await db.award.count({
              where: { userID: { startsWith: "BULK-" }, ...live },
            }),
          ).toBe(300);
        } finally {
          await db.award.deleteMany({
            where: { userID: { startsWith: "BULK-" } },
          });
        }
      }, 120_000);
    });

    /* ---------------------------------------------------------------- */
    describe("self-recorded awards (F25a)", () => {
      it("flags an award a manager recorded for themselves, and only that", async () => {
        const t = await fullColours();
        await as(JCRC).awards.assign({
          academicYear: AY,
          awardTypeID: t.id,
          recipients: [{ userID: JCRC.id }, { userID: "SEED-R20" }],
        });

        const list = await as(JCRC).awards.list({ academicYear: AY });
        const mine = list.find(
          (a) => a.userID === JCRC.id && a.title === "Full Colours",
        );
        const theirs = list.find((a) => a.userID === "SEED-R20");
        expect(mine?.selfRecorded).toBe(true);
        expect(theirs?.selfRecorded).toBe(false);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("who may manage awards", () => {
      it("lets JCRC and admin, and nobody else, use every award procedure", async () => {
        const calls = async (who: { id: string; roles: string[] } | null) => {
          const m = as(who);
          const t = await fullColours();
          const a = await db.award.findFirstOrThrow({
            where: { userID: "SEED-R12", ...live },
          });
          const batch = await db.awardImportBatch.findFirstOrThrow();
          return [
            () => m.awards.list({ academicYear: AY }),
            () =>
              m.awards.assign({
                academicYear: AY,
                awardTypeID: t.id,
                recipients: [{ userID: "SEED-R20" }],
              }),
            () => m.awards.update({ id: a.id, title: "X", citation: null }),
            () => m.awards.remove({ id: a.id }),
            () => m.awards.restore({ id: a.id }),
            () => m.awards.bulkRemove({ ids: [a.id] }),
            () => m.awards.bulkRestore({ ids: [a.id] }),
            () => m.awardTypes.list({}),
            () => m.awardTypes.create({ name: "Another" }),
            () => m.awardTypes.update({ id: t.id, name: "Full Colours" }),
            () => m.awardTypes.archive({ id: t.id }),
            () => m.awardTypes.restore({ id: t.id }),
            () => m.awardBatches.list({ academicYear: AY }),
            () => m.awardBatches.undo({ batchId: batch.id }),
          ];
        };

        for (const who of [ADMIN, JCRC]) {
          for (const call of await calls(who)) {
            expect(await errorOf(call())).toBe("ok");
          }
          reseed();
        }
        for (const who of [SOCCER_HEAD, PLAIN, SCRC]) {
          for (const call of await calls(who)) {
            expect(await errorOf(call())).toMatch(/^FORBIDDEN:/);
          }
        }
        for (const call of await calls(null)) {
          expect(await errorOf(call())).toMatch(/^UNAUTHORIZED:/);
        }
      }, 180_000);
    });

    /* ---------------------------------------------------------------- */
    describe("the catalogue", () => {
      it("lists live entries by default and archived ones on request, with how many were given", async () => {
        const live = await as(JCRC).awardTypes.list({});
        expect(live.map((t) => t.name).sort()).toEqual([
          "Colours Award, Soccer",
          "Full Colours",
          "Outstanding Newcomer",
          "Service Excellence Award",
        ]);
        const all = await as(JCRC).awardTypes.list({ includeArchived: true });
        expect(all).toHaveLength(5);
        expect(all.find((t) => t.name === "Retired Award")?.archived).toBe(
          true,
        );
        expect(all.find((t) => t.name === "Full Colours")?.awardCount).toBe(3);
      });

      it("creates an entry, recording who and when", async () => {
        const made = await as(JCRC).awardTypes.create({
          name: "  Best   Newcomer ",
          defaultCitation: "For a fine first year.",
        });
        const row = await db.awardType.findUniqueOrThrow({
          where: { id: made.id },
        });
        expect(row).toMatchObject({
          name: "Best   Newcomer",
          normalizedName: "best newcomer",
          defaultCitation: "For a fine first year.",
          createdBy: JCRC.id,
        });
        expect(row.createdAt).toBeTruthy();
      });

      it("refuses a name that is the same once case and spaces are ignored, archived or not", async () => {
        const m = as(JCRC);
        for (const name of [
          "full colours",
          "  FULL   COLOURS ",
          "Retired Award",
          "retired  award",
        ]) {
          expect(await errorOf(m.awardTypes.create({ name }))).toBe(
            "CONFLICT:AWARD_NAME_TAKEN",
          );
        }
        const count = await db.awardType.count();
        expect(await db.awardType.count()).toBe(count);
      });

      it("refuses a rename onto another entry's name, but lets an entry keep its own", async () => {
        const t = await fullColours();
        expect(
          await errorOf(
            as(JCRC).awardTypes.update({
              id: t.id,
              name: "outstanding newcomer",
            }),
          ),
        ).toBe("CONFLICT:AWARD_NAME_TAKEN");
        expect(
          await errorOf(
            as(JCRC).awardTypes.update({ id: t.id, name: "FULL COLOURS" }),
          ),
        ).toBe("ok");
      });

      it("does not change past awards when an entry is renamed", async () => {
        const t = await fullColours();
        await as(JCRC).awardTypes.update({
          id: t.id,
          name: "Honours",
          defaultCitation: "New default.",
        });

        const kept = await awardsOf("SEED-R13");
        expect(kept.find((a) => a.awardTypeID === t.id)?.title).toBe(
          "Full Colours",
        );
        const input = await loader.loadTranscriptInput(db, "SEED-R13", AY, {
          now: NOW,
        });
        expect(input.awards.map((a) => a.title)).toContain("Full Colours");
        expect(input.awards.map((a) => a.title)).not.toContain("Honours");
      });

      it("archives and restores, and never deletes", async () => {
        const t = await fullColours();
        const before = await db.awardType.count();
        await as(JCRC).awardTypes.archive({ id: t.id });
        const row = await db.awardType.findUniqueOrThrow({
          where: { id: t.id },
        });
        expect(row.archivedAt).toBeTruthy();
        expect(row.archivedBy).toBe(JCRC.id);
        expect(
          (await as(JCRC).awardTypes.list({})).map((x) => x.id),
        ).not.toContain(t.id);
        expect(await db.awardType.count()).toBe(before);

        await as(JCRC).awardTypes.restore({ id: t.id });
        expect(
          (await db.awardType.findUniqueOrThrow({ where: { id: t.id } }))
            .archivedAt ?? null,
        ).toBeNull();
      });

      it("still allows catalogue writes while the year is published", async () => {
        await publish();
        expect(
          await errorOf(
            as(JCRC).awardTypes.create({ name: "Mid-publication" }),
          ),
        ).toBe("ok");
        const t = await fullColours();
        expect(await errorOf(as(JCRC).awardTypes.archive({ id: t.id }))).toBe(
          "ok",
        );
      });

      it("rejects bad names and citations", async () => {
        const m = as(JCRC);
        for (const bad of [
          { name: "   " },
          { name: "x".repeat(81) },
          { name: "ok", defaultCitation: "x".repeat(301) },
          { name: "a\u0000b" },
        ]) {
          expect(await errorOf(m.awardTypes.create(bad as never))).toMatch(
            /^BAD_REQUEST:/,
          );
        }
      });
    });

    /* ---------------------------------------------------------------- */
    describe("assigning an award", () => {
      it("creates one award per person with the award's name and default citation", async () => {
        const result = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R20" },
          { userID: "SEED-R19", citation: "Led the freshmen." },
        ]);

        expect(result.assigned).toBe(2);
        expect(result.skipped).toEqual([]);
        const [a] = await awardsOf("SEED-R20", "Full Colours");
        expect(a).toMatchObject({
          academicYear: AY,
          title: "Full Colours",
          citation: "For outstanding contribution to hall life.",
          recordedBy: JCRC.id,
        });
        expect(a!.awardTypeID).toBe((await fullColours()).id);
        const [b] = await awardsOf("SEED-R19", "Full Colours");
        expect(b!.citation).toBe("Led the freshmen.");
      });

      it("skips people who already have it and names them", async () => {
        const result = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R13" },
          { userID: "SEED-R20" },
          { userID: "SEED-R14" },
        ]);

        expect(result.assigned).toBe(1);
        expect(result.skipped.map((s) => s.userID).sort()).toEqual([
          "SEED-R13",
          "SEED-R14",
        ]);
        expect(result.skipped[0]!.displayName).toBeTruthy();
        expect(await awardsOf("SEED-R13", "Full Colours")).toHaveLength(1);
      });

      it("skips a person listed twice in the same request", async () => {
        const result = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R20" },
          { userID: "SEED-R20" },
        ]);
        expect(result.assigned).toBe(1);
        expect(result.skipped).toHaveLength(1);
        expect(await awardsOf("SEED-R20", "Full Colours")).toHaveLength(1);
      });

      it("treats an old award with the same name and no catalogue entry as a duplicate", async () => {
        await db.award.create({
          data: {
            academicYear: AY,
            userID: "SEED-R20",
            title: "  full   COLOURS ",
            recordedBy: JCRC.id,
            activeKey: awardActiveKey({
              academicYear: AY,
              userID: "SEED-R20",
              awardTypeID: null,
              title: "  full   COLOURS ",
            }),
          },
        });
        const result = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R20" },
        ]);
        expect(result.assigned).toBe(0);
        expect(result.skipped).toHaveLength(1);
      });

      it("does not count a removed award as a duplicate, or an award of another year", async () => {
        const m = as(JCRC);
        const r13 = (await awardsOf("SEED-R13", "Full Colours"))[0]!;
        await m.awards.remove({ id: r13.id });
        await db.award.create({
          data: {
            academicYear: OLD,
            userID: "SEED-R20",
            title: "Full Colours",
            awardTypeID: (await fullColours()).id,
            activeKey: `${OLD}|SEED-R20|${(await fullColours()).id}`,
          },
        });

        const result = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R13" },
          { userID: "SEED-R20" },
        ]);
        expect(result.assigned).toBe(2);
      });

      it("is all or nothing: an unknown resident refuses the whole request", async () => {
        const before = await db.award.count();
        expect(
          await errorOf(
            assign(JCRC, "Full Colours", [
              { userID: "SEED-R20" },
              { userID: "NO-SUCH-RESIDENT" },
            ]),
          ),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND");
        expect(await db.award.count()).toBe(before);
      });

      it("refuses an archived award, and an unknown one", async () => {
        expect(
          await errorOf(
            assign(JCRC, "Retired Award", [{ userID: "SEED-R20" }]),
          ),
        ).toBe("CONFLICT:AWARD_TYPE_ARCHIVED");
        expect(
          await errorOf(
            as(JCRC).awards.assign({
              academicYear: AY,
              awardTypeID: "f".repeat(24),
              recipients: [{ userID: "SEED-R20" }],
            }),
          ),
        ).toBe("NOT_FOUND:AWARD_TYPE_NOT_FOUND");
      });

      it("refuses nobody, and takes more than 300 people (only a hidden cap refuses)", async () => {
        const t = await fullColours();
        expect(
          await errorOf(
            as(JCRC).awards.assign({
              academicYear: AY,
              awardTypeID: t.id,
              recipients: [],
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            as(JCRC).awards.assign({
              academicYear: AY,
              awardTypeID: t.id,
              recipients: Array.from({ length: 301 }, (_, i) => ({
                userID: `SEED-X${i}`,
              })),
            }),
          ),
        ).toBe("NOT_FOUND:RESIDENT_NOT_FOUND"); // 301 is no reason to refuse
        expect(
          await errorOf(
            as(JCRC).awards.assign({
              academicYear: AY,
              awardTypeID: t.id,
              recipients: Array.from({ length: 2001 }, (_, i) => ({
                userID: `SEED-X${i}`,
              })),
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("the awards of a year", () => {
      it("lists with names, who recorded them and when, and filters by search", async () => {
        const all = await as(JCRC).awards.list({ academicYear: AY });
        expect(all.length).toBeGreaterThanOrEqual(6);
        const soccer = all.find((a) => a.userID === "SEED-R04")!;
        expect(soccer.displayName).toBe("Seed Resident 04");
        expect(soccer.recordedByName).toBe("Seed Resident 02");
        expect(soccer.awardTypeID).toBeTruthy();

        const byAward = await as(JCRC).awards.list({
          academicYear: AY,
          search: "full col",
        });
        expect(byAward.map((a) => a.userID).sort()).toEqual([
          "SEED-R13",
          "SEED-R14",
          "SEED-R15",
        ]);
        const byName = await as(JCRC).awards.list({
          academicYear: AY,
          search: "resident 12",
        });
        expect(byName.every((a) => a.userID === "SEED-R12")).toBe(true);
        expect(byName).toHaveLength(2);
      });

      it("hides removed awards unless asked", async () => {
        const hidden = await as(JCRC).awards.list({ academicYear: AY });
        expect(hidden.some((a) => a.title === "Recorded in error")).toBe(false);
        const shown = await as(JCRC).awards.list({
          academicYear: AY,
          includeRemoved: true,
        });
        expect(
          shown.find((a) => a.title === "Recorded in error")?.removed,
        ).toBe(true);
      });

      it("edits an award's title and citation, recording who and when", async () => {
        const a = (await awardsOf("SEED-R04"))[0]!;
        await as(JCRC).awards.update({
          id: a.id,
          title: "Colours Award, Football",
          citation: null,
        });
        const row = await db.award.findUniqueOrThrow({ where: { id: a.id } });
        expect(row).toMatchObject({
          title: "Colours Award, Football",
          updatedBy: JCRC.id,
        });
        expect(row.citation ?? null).toBeNull();
        expect(row.updatedAt).toBeTruthy();
        expect(row.awardTypeID).toBe(a.awardTypeID);
      });

      it("will not edit a removed award until it is restored", async () => {
        const a = (await awardsOf("SEED-R04"))[0]!;
        await as(JCRC).awards.remove({ id: a.id });
        expect(
          await errorOf(
            as(JCRC).awards.update({ id: a.id, title: "X", citation: null }),
          ),
        ).toBe("CONFLICT:AWARD_REMOVED");
      });

      it("removes and restores one award, never deleting it", async () => {
        const a = (await awardsOf("SEED-R04"))[0]!;
        const before = await db.award.count();
        await as(ADMIN).awards.remove({ id: a.id });
        let row = await db.award.findUniqueOrThrow({ where: { id: a.id } });
        expect(row.voidedAt).toBeTruthy();
        expect(row.voidedBy).toBe(ADMIN.id);
        expect(await db.award.count()).toBe(before);

        await as(JCRC).awards.restore({ id: a.id });
        row = await db.award.findUniqueOrThrow({ where: { id: a.id } });
        expect(row.voidedAt ?? null).toBeNull();
        expect(row.updatedBy).toBe(JCRC.id);
      });

      it("refuses to restore an award the person now holds again", async () => {
        const a = (await awardsOf("SEED-R13", "Full Colours"))[0]!;
        await as(JCRC).awards.remove({ id: a.id });
        await assign(JCRC, "Full Colours", [{ userID: "SEED-R13" }]);
        expect(await errorOf(as(JCRC).awards.restore({ id: a.id }))).toBe(
          "CONFLICT:ALREADY_HAS_AWARD",
        );
      });

      it("removes and restores many at once", async () => {
        const ids = (
          await db.award.findMany({ where: { title: "Full Colours", ...live } })
        ).map((a) => a.id);
        expect(ids).toHaveLength(3);
        expect(await as(JCRC).awards.bulkRemove({ ids })).toEqual({
          removed: 3,
        });
        expect(await as(JCRC).awards.bulkRemove({ ids })).toEqual({
          removed: 0,
        });
        expect(await awardsOf("SEED-R13", "Full Colours")).toHaveLength(0);

        const back = await as(JCRC).awards.bulkRestore({ ids });
        expect(back).toEqual({ restored: 3, skipped: [] });
        expect(await awardsOf("SEED-R13", "Full Colours")).toHaveLength(1);
      });

      it("skips, and names, an award a bulk restore would duplicate", async () => {
        const mine = await db.award.findMany({
          where: { title: "Full Colours", ...live },
        });
        const ids = mine.map((a) => a.id);
        await as(JCRC).awards.bulkRemove({ ids });
        await assign(JCRC, "Full Colours", [{ userID: "SEED-R13" }]);

        const back = await as(JCRC).awards.bulkRestore({ ids });
        expect(back.restored).toBe(2);
        expect(back.skipped).toHaveLength(1);
        expect(back.skipped[0]).toContain("Full Colours");
        expect(await awardsOf("SEED-R13", "Full Colours")).toHaveLength(1);
      });

      it("takes more than 500 awards at once (only a hidden cap refuses), and refuses an unknown id", async () => {
        const id = (await awardsOf("SEED-R04"))[0]!.id;
        expect(
          await errorOf(
            as(JCRC).awards.bulkRemove({
              ids: Array.from({ length: 2001 }, () => id),
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            as(JCRC).awards.bulkRemove({ ids: [id, "f".repeat(24)] }),
          ),
        ).toBe("NOT_FOUND:RECORD_NOT_FOUND");
        expect(
          (await db.award.findUniqueOrThrow({ where: { id } })).voidedAt ??
            null,
        ).toBeNull();
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a published year", () => {
      it("refuses every write to its awards, with the existing message", async () => {
        const a = (await awardsOf("SEED-R04"))[0]!;
        const batch = await db.awardImportBatch.findFirstOrThrow();
        const t = await fullColours();
        await publish();
        // Every award write names residents, so a manager is refused until
        // each of them is unlocked.
        const denied = "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS";

        for (const who of [JCRC, ADMIN]) {
          const m = as(who);
          const calls = [
            () =>
              m.awards.assign({
                academicYear: AY,
                awardTypeID: t.id,
                recipients: [{ userID: "SEED-R20" }],
              }),
            () => m.awards.update({ id: a.id, title: "X", citation: null }),
            () => m.awards.remove({ id: a.id }),
            () => m.awards.restore({ id: a.id }),
            () => m.awards.bulkRemove({ ids: [a.id] }),
            () => m.awards.bulkRestore({ ids: [a.id] }),
            () => m.awardBatches.undo({ batchId: batch.id }),
          ];
          for (const call of calls) expect(await errorOf(call())).toBe(denied);
        }
        // Reading is still allowed.
        expect(
          (await as(JCRC).awards.list({ academicYear: AY })).length,
        ).toBeGreaterThan(0);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("archived awards and the transcript", () => {
      it("hides an archived award from the catalogue list but keeps its awards on transcripts", async () => {
        const t = await type("colours award, soccer");
        await as(JCRC).awardTypes.archive({ id: t.id });

        expect(
          (await as(JCRC).awardTypes.list({})).map((x) => x.id),
        ).not.toContain(t.id);
        const input = await loader.loadTranscriptInput(db, "SEED-R04", AY, {
          now: NOW,
        });
        expect(input.awards.map((a) => a.title)).toContain(
          "Colours Award, Soccer",
        );
        expect(
          await errorOf(
            assign(JCRC, "Colours Award, Soccer", [{ userID: "SEED-R20" }]),
          ),
        ).toBe("CONFLICT:AWARD_TYPE_ARCHIVED");
      });

      it("never loads a removed award", async () => {
        const a = (await awardsOf("SEED-R04"))[0]!;
        await as(JCRC).awards.remove({ id: a.id });
        const input = await loader.loadTranscriptInput(db, "SEED-R04", AY, {
          now: NOW,
        });
        expect(input.awards).toEqual([]);
        await as(JCRC).awards.restore({ id: a.id });
        expect(
          (await loader.loadTranscriptInput(db, "SEED-R04", AY, { now: NOW }))
            .awards,
        ).toHaveLength(1);
      });

      it("loads an award's citation", async () => {
        const input = await loader.loadTranscriptInput(db, "SEED-R13", AY, {
          now: NOW,
        });
        expect(input.awards).toEqual([
          {
            title: "Full Colours",
            academicYear: AY,
            citation: "For outstanding contribution to hall life.",
          },
        ]);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("upload history", () => {
      const batch = () => db.awardImportBatch.findFirstOrThrow();

      it("lists the seeded upload with who, when and how many are still active", async () => {
        const list = await as(JCRC).awardBatches.list({ academicYear: AY });
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          fileName: "colours-2026.csv",
          rowCount: 4,
          importedCount: 3,
          skippedCount: 1,
          createdByName: "Seed Resident 02",
          undone: false,
          activeCount: 3,
        });
        expect(await as(JCRC).awardBatches.list({ academicYear: OLD })).toEqual(
          [],
        );
      });

      it("undoes an upload: removes only its still-active awards and records who", async () => {
        const b = await batch();
        const one = (await awardsOf("SEED-R14", "Full Colours"))[0]!;
        await as(JCRC).awards.remove({ id: one.id }); // already removed by hand
        const manual = await assign(JCRC, "Full Colours", [
          { userID: "SEED-R20" },
        ]);
        expect(manual.assigned).toBe(1);

        const result = await as(ADMIN).awardBatches.undo({ batchId: b.id });

        expect(result.removed).toBe(2);
        const row = await db.awardImportBatch.findUniqueOrThrow({
          where: { id: b.id },
        });
        expect(row.undoneAt).toBeTruthy();
        expect(row.undoneBy).toBe(ADMIN.id);
        // Nobody from the upload is left; the hand-made award and others are untouched.
        for (const u of ["SEED-R13", "SEED-R14", "SEED-R15"]) {
          expect(await awardsOf(u, "Full Colours")).toHaveLength(0);
        }
        expect(await awardsOf("SEED-R20", "Full Colours")).toHaveLength(1);
        expect(await awardsOf("SEED-R04")).toHaveLength(1);
        expect(await awardsOf("SEED-R12")).toHaveLength(2);
        // The removed awards are still in the database.
        expect(await db.award.count({ where: { importBatchID: b.id } })).toBe(
          3,
        );
      });

      it("cannot be undone twice", async () => {
        const b = await batch();
        await as(JCRC).awardBatches.undo({ batchId: b.id });
        const removedAt = (
          await db.award.findFirstOrThrow({ where: { importBatchID: b.id } })
        ).voidedAt;

        expect(
          await errorOf(as(JCRC).awardBatches.undo({ batchId: b.id })),
        ).toBe("CONFLICT:BATCH_ALREADY_UNDONE");
        expect(
          (await db.award.findFirstOrThrow({ where: { importBatchID: b.id } }))
            .voidedAt,
        ).toEqual(removedAt);
        const list = await as(JCRC).awardBatches.list({ academicYear: AY });
        expect(list[0]!.undone).toBe(true);
        expect(list[0]!.activeCount).toBe(0);
      });

      it("refuses an unknown batch", async () => {
        expect(
          await errorOf(
            as(JCRC).awardBatches.undo({ batchId: "f".repeat(24) }),
          ),
        ).toBe("NOT_FOUND:BATCH_NOT_FOUND");
      });

      it("lets an undone upload's awards be restored one by one", async () => {
        const b = await batch();
        await as(JCRC).awardBatches.undo({ batchId: b.id });
        const a = await db.award.findFirstOrThrow({
          where: { importBatchID: b.id },
        });
        await as(JCRC).awards.restore({ id: a.id });
        expect(await awardsOf(a.userID, "Full Colours")).toHaveLength(1);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("purging a year", () => {
      it("removes the year's awards and uploads but never the catalogue", async () => {
        const t = await fullColours();
        const oldBatch = await db.awardImportBatch.create({
          data: {
            academicYear: OLD,
            fileName: "old.csv",
            rowCount: 1,
            importedCount: 1,
            skippedCount: 0,
            createdBy: JCRC.id,
          },
        });
        await db.award.create({
          data: {
            academicYear: OLD,
            userID: "SEED-R12",
            title: "Full Colours",
            awardTypeID: t.id,
            importBatchID: oldBatch.id,
            activeKey: `${OLD}|SEED-R12|${t.id}`,
          },
        });
        const current = {
          awards: await db.award.count({ where: { academicYear: AY } }),
          batches: await db.awardImportBatch.count({
            where: { academicYear: AY },
          }),
          types: await db.awardType.count(),
        };

        const dry = await retention.purgeAcademicYear(db, OLD, {
          dryRun: true,
        });
        expect(dry).toMatchObject({ Award: 1, AwardImportBatch: 1 });
        const purged = await retention.purgeAcademicYear(db, OLD);
        expect(purged).toMatchObject({ Award: 1, AwardImportBatch: 1 });

        expect(await db.award.count({ where: { academicYear: OLD } })).toBe(0);
        expect(
          await db.awardImportBatch.count({ where: { academicYear: OLD } }),
        ).toBe(0);
        expect(await db.award.count({ where: { academicYear: AY } })).toBe(
          current.awards,
        );
        expect(
          await db.awardImportBatch.count({ where: { academicYear: AY } }),
        ).toBe(current.batches);
        expect(await db.awardType.count()).toBe(current.types);
        expect(Object.keys(purged)).not.toContain("AwardType");
      });
    });
  },
);
