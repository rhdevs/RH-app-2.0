import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import type { createCaller as CreateCaller } from "~/server/api/root";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { parseCsv } from "~/app/admin/_lib/csv";
import {
  guessMapping,
  rowsFromTable,
  type Decision,
  type ImportRow,
} from "~/lib/transcript/awardImport";

/**
 * INTEGRATION TESTS of the awards CSV import against the LOCAL development
 * database (skipped unless DATABASE_URL is localhost and the database is
 * `rhapp_transcript_dev`; run `npm run test:db`). The seed is re-run before every
 * test. The sample file (scripts/dev/sample-awards.csv) is built to give 8 Ready,
 * 1 Not found, 2 Duplicate and 1 Invalid row against the seeded data.
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

const R = (n: number, roles: string[]) => ({
  id: `SEED-R${String(n).padStart(2, "0")}`,
  roles,
});
const ADMIN = R(1, ["admin", "resident"]);
const JCRC = R(2, ["jcrc", "resident"]);
const SOCCER_HEAD = R(4, ["cca_head", "resident"]);
const PLAIN = R(9, ["resident"]);

describe.skipIf(!isLocalDevDatabase(process.env.DATABASE_URL))(
  "awards CSV import (local database)",
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

    const sample = (): ImportRow[] => {
      const table = parseCsv(
        readFileSync("scripts/dev/sample-awards.csv", "utf8"),
      );
      return rowsFromTable(table, guessMapping(table[0]!), true);
    };
    const retiredID = async () =>
      (
        await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "retired award" },
        })
      ).id;
    const decisions = async (): Promise<Decision[]> => [
      { nameKey: "hall spirit award", action: "create" },
      {
        nameKey: "retired award",
        action: "existing",
        awardTypeID: await retiredID(),
      },
    ];
    const live = { OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }] };
    const commit = async (
      who: { id: string; roles: string[] } = JCRC,
      rows: ImportRow[] = sample(),
      over: object = {},
    ) =>
      as(who).awardImport.commit({
        academicYear: AY,
        fileName: "sample-awards.csv",
        rows,
        decisions: await decisions(),
        ...over,
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

    /* ---------------------------------------------------------------- */
    describe("who may import", () => {
      it("lets JCRC and admin preview, and refuses everyone else", async () => {
        for (const who of [JCRC, ADMIN]) {
          expect(
            await errorOf(
              as(who).awardImport.preview({ academicYear: AY, rows: sample() }),
            ),
          ).toBe("ok");
        }
        for (const who of [SOCCER_HEAD, PLAIN]) {
          expect(
            await errorOf(
              as(who).awardImport.preview({ academicYear: AY, rows: sample() }),
            ),
          ).toMatch(/^FORBIDDEN:/);
          expect(await errorOf(commit(who))).toMatch(/^FORBIDDEN:/);
        }
        expect(
          await errorOf(
            as(null).awardImport.preview({ academicYear: AY, rows: [] }),
          ),
        ).toMatch(/^UNAUTHORIZED:/);
        expect(
          await db.awardImportBatch.count({
            where: { fileName: "sample-awards.csv" },
          }),
        ).toBe(0);
      });

      it("refuses a published year, for the preview and the commit", async () => {
        await publish();
        expect(
          await errorOf(
            as(JCRC).awardImport.preview({ academicYear: AY, rows: sample() }),
          ),
        ).toBe("PRECONDITION_FAILED:PERIOD_PUBLISHED");
        // The commit names residents, so it is a per-resident correction:
        // refused until every one of them is unlocked.
        expect(await errorOf(commit(JCRC))).toBe(
          "FORBIDDEN:ONLY_UNLOCKED_RESIDENTS",
        );
        expect(
          await db.awardImportBatch.count({
            where: { fileName: "sample-awards.csv" },
          }),
        ).toBe(0);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("preview", () => {
      it("classifies the sample as designed, resolving emails and a NUSNET id", async () => {
        const result = await as(JCRC).awardImport.preview({
          academicYear: AY,
          rows: sample(),
        });

        expect(result.counts).toEqual({
          ready: 8,
          not_found: 1,
          duplicate: 2,
          invalid: 1,
        });
        const by = (n: number) => result.rows.find((r) => r.row === n)!;
        expect(by(1)).toMatchObject({
          status: "ready",
          userID: "SEED-R05",
          displayName: "Seed Resident 05",
        });
        expect(by(6)).toMatchObject({ status: "ready", userID: "SEED-R10" }); // "seed-r10" (NUSNET)
        expect(by(9).status).toBe("not_found");
        expect(by(10)).toMatchObject({
          status: "duplicate",
          reason: "Listed earlier in the file (row 1).",
        });
        expect(by(11)).toMatchObject({
          status: "duplicate",
          reason: "Already has this award for the year.",
        });
        expect(by(12)).toMatchObject({
          status: "invalid",
          reason: "The citation is longer than 300 characters.",
        });
      });

      it("lists the unknown names: a new one, and one an archived award already holds", async () => {
        const result = await as(JCRC).awardImport.preview({
          academicYear: AY,
          rows: sample(),
        });

        expect(
          result.unknown.map((u) => [
            u.name,
            u.rows,
            u.archivedTypeID !== null,
          ]),
        ).toEqual([
          ["Hall Spirit Award", 1, false],
          ["Retired Award", 1, true],
        ]);
        expect(result.types.map((t) => t.name)).not.toContain("Retired Award");
        expect(result.archivedTypes.map((t) => t.name)).toEqual([
          "Retired Award",
        ]);
      });

      it("writes nothing", async () => {
        const before = {
          awards: await db.award.count(),
          types: await db.awardType.count(),
          batches: await db.awardImportBatch.count(),
        };
        await as(JCRC).awardImport.preview({
          academicYear: AY,
          rows: sample(),
        });
        expect({
          awards: await db.award.count(),
          types: await db.awardType.count(),
          batches: await db.awardImportBatch.count(),
        }).toEqual(before);
      });

      it("treats a removed award as no duplicate", async () => {
        const held = await db.award.findFirstOrThrow({
          where: { userID: "SEED-R13", title: "Full Colours", ...live },
        });
        await as(JCRC).awards.remove({ id: held.id });
        const result = await as(JCRC).awardImport.preview({
          academicYear: AY,
          rows: sample(),
        });
        expect(result.rows.find((r) => r.row === 11)!.status).toBe("ready");
      });

      it("takes 2,000 rows, and refuses 2,001 with a plain message", async () => {
        const rows = (n: number) =>
          Array.from({ length: n }, (_, i) => ({
            identifier: `seed-r05@u.nus.edu`,
            award: `A${i}`,
          }));
        expect(
          await errorOf(
            as(JCRC).awardImport.preview({
              academicYear: AY,
              rows: rows(2_001),
            }),
          ),
        ).toMatch(/^BAD_REQUEST:/);
        expect(
          await errorOf(
            as(JCRC).awardImport.preview({
              academicYear: AY,
              rows: rows(2_000),
            }),
          ),
        ).toBe("ok");
      });
    });

    /* ---------------------------------------------------------------- */
    describe("commit", () => {
      it("is refused while any unknown name is undecided, and writes nothing", async () => {
        const before = await db.award.count();
        expect(
          await errorOf(
            as(JCRC).awardImport.commit({
              academicYear: AY,
              rows: sample(),
              decisions: [{ nameKey: "hall spirit award", action: "create" }],
            }),
          ),
        ).toBe("BAD_REQUEST:UNDECIDED_AWARD_NAMES");
        expect(await db.award.count()).toBe(before);
        expect(
          await db.awardType.count({
            where: { normalizedName: "hall spirit award" },
          }),
        ).toBe(0);
        expect(
          await db.awardImportBatch.count({
            where: { fileName: "sample-awards.csv" },
          }),
        ).toBe(0);
      });

      it("imports the Ready rows under one batch and reports the rest with reasons", async () => {
        const result = await commit();

        expect(result.imported).toBe(8);
        expect(result.skipped.map((s) => s.row)).toEqual([9, 10, 11, 12]);
        expect(result.skipped.find((s) => s.row === 9)!.reason).toMatch(
          /No resident/,
        );
        expect(result.created).toEqual(["Hall Spirit Award"]);

        const batch = await db.awardImportBatch.findUniqueOrThrow({
          where: { id: result.batchId },
        });
        expect(batch).toMatchObject({
          academicYear: AY,
          fileName: "sample-awards.csv",
          rowCount: 12,
          importedCount: 8,
          skippedCount: 4,
          createdBy: JCRC.id,
        });
        expect(batch.createdAt).toBeTruthy();
        const awards = await db.award.findMany({
          where: { importBatchID: result.batchId },
        });
        expect(awards).toHaveLength(8);
        expect(
          awards.every((a) => a.recordedBy === JCRC.id && a.awardTypeID),
        ).toBe(true);
      });

      it("takes the row's citation, else the award's default", async () => {
        const result = await commit();
        const of = async (userID: string) =>
          db.award.findFirstOrThrow({
            where: { importBatchID: result.batchId, userID },
          });

        expect((await of("SEED-R05")).citation).toBe(
          "For outstanding contribution to hall life.",
        ); // default
        expect((await of("SEED-R06")).citation).toBe(
          "For tireless service to the hall.",
        ); // own
        expect((await of("SEED-R08")).citation ?? null).toBeNull(); // no default on that award
      });

      it("creates a catalogue entry for a Create decision, with no default citation", async () => {
        await commit();
        const t = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "hall spirit award" },
        });
        expect(t).toMatchObject({
          name: "Hall Spirit Award",
          createdBy: JCRC.id,
        });
        expect(t.defaultCitation ?? null).toBeNull();
        expect(t.archivedAt ?? null).toBeNull();
        const a = await db.award.findFirstOrThrow({
          where: { userID: "SEED-R11", title: "Hall Spirit Award" },
        });
        expect(a.awardTypeID).toBe(t.id);
      });

      it("keeps an archived award archived when 'Use existing' picks it", async () => {
        const result = await commit();
        const id = await retiredID();
        const t = await db.awardType.findUniqueOrThrow({ where: { id } });
        expect(t.archivedAt).toBeTruthy();
        const a = await db.award.findFirstOrThrow({
          where: { importBatchID: result.batchId, userID: "SEED-R16" },
        });
        expect(a).toMatchObject({ awardTypeID: id, title: "Retired Award" });
      });

      it("refuses Create for a name an archived award holds, and a missing 'existing' award", async () => {
        const rows: ImportRow[] = [
          { identifier: "seed-r16@u.nus.edu", award: "Retired Award" },
        ];
        expect(
          await errorOf(
            as(JCRC).awardImport.commit({
              academicYear: AY,
              rows,
              decisions: [{ nameKey: "retired award", action: "create" }],
            }),
          ),
        ).toBe("CONFLICT:AWARD_NAME_TAKEN");
        expect(
          await errorOf(
            as(JCRC).awardImport.commit({
              academicYear: AY,
              rows,
              decisions: [
                {
                  nameKey: "retired award",
                  action: "existing",
                  awardTypeID: "f".repeat(24),
                },
              ],
            }),
          ),
        ).toBe("NOT_FOUND:AWARD_TYPE_GONE");
        expect(
          await db.awardImportBatch.count({ where: { fileName: null } }),
        ).toBe(0);
      });

      it("maps a new name onto an existing award, and checks the duplicate by that award", async () => {
        const full = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        const result = await as(JCRC).awardImport.commit({
          academicYear: AY,
          rows: [
            { identifier: "seed-r13@u.nus.edu", award: "Honours" }, // R13 already holds Full Colours
            { identifier: "seed-r20@u.nus.edu", award: "Honours" },
          ],
          decisions: [
            { nameKey: "honours", action: "existing", awardTypeID: full.id },
          ],
        });
        expect(result.imported).toBe(1);
        expect(result.skipped).toEqual([
          expect.objectContaining({
            row: 1,
            reason: "Already has this award for the year.",
          }),
        ]);
        const a = await db.award.findFirstOrThrow({
          where: { userID: "SEED-R20", ...live, title: "Full Colours" },
        });
        expect(a.awardTypeID).toBe(full.id);
      });

      it("skips the rows the user skipped", async () => {
        const result = await commit(JCRC, sample(), { skipRows: [1, 2] });
        expect(result.imported).toBe(6);
        expect(
          result.skipped
            .filter((s) => s.reason === "Skipped by you.")
            .map((s) => s.row),
        ).toEqual([1, 2]);
      });

      it("does not ask about a new name whose only rows were skipped", async () => {
        const rows = sample();
        const result = await as(JCRC).awardImport.commit({
          academicYear: AY,
          rows,
          decisions: [
            {
              nameKey: "retired award",
              action: "existing",
              awardTypeID: await retiredID(),
            },
          ],
          skipRows: [7], // the only "Hall Spirit Award" row
        });
        expect(result.imported).toBe(7);
        expect(
          await db.awardType.count({
            where: { normalizedName: "hall spirit award" },
          }),
        ).toBe(0);
      });

      it("re-checks everything: a row made a duplicate after the preview is skipped, not failed", async () => {
        const preview = await as(JCRC).awardImport.preview({
          academicYear: AY,
          rows: sample(),
        });
        expect(preview.rows[0]!.status).toBe("ready");
        // Someone gives SEED-R05 Full Colours between the preview and the commit.
        await as(ADMIN).awards.assign({
          academicYear: AY,
          awardTypeID: (
            await db.awardType.findUniqueOrThrow({
              where: { normalizedName: "full colours" },
            })
          ).id,
          recipients: [{ userID: "SEED-R05" }],
        });

        const result = await commit();

        expect(result.imported).toBe(7);
        expect(result.skipped.find((s) => s.row === 1)).toMatchObject({
          reason: "Already has this award for the year.",
        });
        expect(
          await db.award.count({
            where: { userID: "SEED-R05", title: "Full Colours", ...live },
          }),
        ).toBe(1);
      });

      it("never trusts the client: a row that is invalid is skipped even if sent as is", async () => {
        const rows: ImportRow[] = [
          {
            identifier: "seed-r05@u.nus.edu",
            award: "Full Colours",
            citation: "x".repeat(301),
          },
          { identifier: "nobody@u.nus.edu", award: "Full Colours" },
        ];
        const result = await as(JCRC).awardImport.commit({
          academicYear: AY,
          rows,
          decisions: [],
        });
        expect(result.imported).toBe(0);
        expect(result.skipped).toHaveLength(2);
        expect(
          await db.award.count({ where: { importBatchID: result.batchId } }),
        ).toBe(0);
      });

      it("is not run twice by accident: the same file again skips every row as a duplicate", async () => {
        await commit();
        const again = await commit();
        expect(again.imported).toBe(0);
        expect(
          again.skipped.filter(
            (s) => s.reason === "Already has this award for the year.",
          ),
        ).toHaveLength(10);
      });

      it("shows on the resident's transcript with its citation", async () => {
        await commit();
        const input = await loader.loadTranscriptInput(db, "SEED-R06", AY, {
          now: NOW,
        });
        expect(input.awards).toEqual([
          {
            title: "Full Colours",
            academicYear: AY,
            citation: "For tireless service to the hall.",
          },
        ]);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("a large upload", () => {
      it("imports 2000 rows in chunks under one batch", async () => {
        // 20 residents x 100 new award names.
        const rows: ImportRow[] = [];
        const keys: Decision[] = [];
        for (let a = 0; a < 100; a += 1) {
          const name = `Bulk Award ${String(a).padStart(3, "0")}`;
          keys.push({ nameKey: name.toLowerCase(), action: "create" });
          for (let n = 1; n <= 20; n += 1) {
            rows.push({
              identifier: `seed-r${String(n).padStart(2, "0")}@u.nus.edu`,
              award: name,
              citation: n % 2 === 0 ? "For the bulk test." : "",
            });
          }
        }
        expect(rows).toHaveLength(2000);

        const started = Date.now();
        const result = await as(JCRC).awardImport.commit({
          academicYear: AY,
          fileName: "bulk.csv",
          rows,
          decisions: keys,
        });
        const seconds = (Date.now() - started) / 1000;
        console.log(
          `[awards import] 2000 rows committed in ${seconds.toFixed(1)} s`,
        );

        expect(result.imported).toBe(2000);
        expect(result.skipped).toEqual([]);
        expect(result.created).toHaveLength(100);
        const batch = await db.awardImportBatch.findUniqueOrThrow({
          where: { id: result.batchId },
        });
        expect(batch).toMatchObject({
          rowCount: 2000,
          importedCount: 2000,
          skippedCount: 0,
        });
        expect(
          await db.award.count({ where: { importBatchID: result.batchId } }),
        ).toBe(2000);
        expect(seconds).toBeLessThan(120);
      }, 300_000);
    });

    /* ---------------------------------------------------------------- */
    describe("two uploads at once, and batch statuses (F20, F16)", () => {
      const tinyRows = (names: string[]): ImportRow[] =>
        names.flatMap((award) =>
          [1, 2, 3, 4, 5, 6].map((n) => ({
            identifier: `seed-r${String(n).padStart(2, "0")}@u.nus.edu`,
            award,
            citation: "",
          })),
        );

      it("never stores the same award twice when two managers import together", async () => {
        const rows = tinyRows(["Full Colours"]);
        const go = (who: typeof JCRC, fileName: string) =>
          as(who).awardImport.commit({
            academicYear: AY,
            fileName,
            rows,
            decisions: [],
          });

        const [a, b] = await Promise.all([
          go(JCRC, "a.csv"),
          go(ADMIN, "b.csv"),
        ]);

        expect(a.imported + b.imported).toBe(
          await db.award.count({
            where: {
              academicYear: AY,
              importBatchID: { not: null },
              userID: {
                in: rows.map((r) => r.identifier.split("@")[0]!.toUpperCase()),
              },
              ...live,
              title: "Full Colours",
            },
          }),
        );
        const dupes = await db.award.groupBy({
          by: ["userID"],
          where: { academicYear: AY, title: "Full Colours", ...live },
          _count: { _all: true },
        });
        for (const d of dupes) expect(d._count._all).toBe(1);
        // Whatever the other upload had already written is skipped, not failed.
        const skippedReasons = [...a.skipped, ...b.skipped].map(
          (s) => s.reason,
        );
        expect(
          skippedReasons.every((r) => r.includes("Already has this award")),
        ).toBe(true);
        for (const id of [a.batchId, b.batchId]) {
          expect(
            (await db.awardImportBatch.findUniqueOrThrow({ where: { id } }))
              .status,
          ).toBe("complete");
        }
      }, 120_000);

      it("marks a finished upload complete, with its counts", async () => {
        const r = await commit();
        const batch = await db.awardImportBatch.findUniqueOrThrow({
          where: { id: r.batchId },
        });
        expect(batch.status).toBe("complete");
        expect(batch.importedCount).toBe(r.imported);
        const listed = (
          await as(JCRC).awardBatches.list({ academicYear: AY })
        ).find((b) => b.id === r.batchId);
        expect(listed?.status).toBe("complete");
      });

      it("shows an upload cut off long ago as interrupted, and Undo works on it", async () => {
        const batch = await db.awardImportBatch.create({
          data: {
            academicYear: AY,
            fileName: "mid.csv",
            rowCount: 3,
            importedCount: 0,
            skippedCount: 0,
            status: "importing",
            createdBy: JCRC.id,
            createdAt: new Date(Date.now() - 20 * 60 * 1000),
          },
        });
        const t = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        await db.award.create({
          data: {
            academicYear: AY,
            userID: "SEED-R20",
            title: "Full Colours",
            awardTypeID: t.id,
            importBatchID: batch.id,
            activeKey: `${AY}|SEED-R20|${t.id}`,
          },
        });

        const listed = (
          await as(JCRC).awardBatches.list({ academicYear: AY })
        ).find((b) => b.id === batch.id);
        expect(listed).toMatchObject({ status: "interrupted", activeCount: 1 });
        const undone = await as(JCRC).awardBatches.undo({ batchId: batch.id });
        expect(undone.removed).toBe(1);
        expect(
          (
            await db.award.findFirstOrThrow({
              where: { importBatchID: batch.id },
            })
          ).activeKey,
        ).toMatch(/\|removed\|/);
      });

      it("when the partial marker cannot be saved, logs code and name only and still says the upload stopped", async () => {
        const service = await import("../awardImport");
        const logged = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        try {
          let transactions = 0;
          const failing = new Proxy(db, {
            get(target, prop, receiver) {
              if (prop === "$transaction") {
                return (...args: unknown[]) => {
                  transactions += 1;
                  if (transactions === 2) {
                    return Promise.reject(new Error("secret detail"));
                  }
                  return (
                    target.$transaction as unknown as (
                      ...a: unknown[]
                    ) => Promise<unknown>
                  )(...args);
                };
              }
              if (prop === "awardImportBatch") {
                return new Proxy(target.awardImportBatch, {
                  get(m, p) {
                    if (p === "update") {
                      return () =>
                        Promise.reject(
                          Object.assign(
                            new Error("marker failed for SEED-R01"),
                            {
                              code: "P1001",
                            },
                          ),
                        );
                    }
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
          const rows: ImportRow[] = [];
          const keys: Decision[] = [];
          for (let a = 0; a < 25; a += 1) {
            const name = `Marker Award ${String(a).padStart(2, "0")}`;
            keys.push({ nameKey: name.toLowerCase(), action: "create" });
            for (let n = 1; n <= 20; n += 1) {
              rows.push({
                identifier: `seed-r${String(n).padStart(2, "0")}@u.nus.edu`,
                award: name,
                citation: "",
              });
            }
          }

          const message = await errorOf(
            service.awardImportCommit(failing, JCRC.id, {
              academicYear: AY,
              fileName: "marker.csv",
              rows,
              decisions: keys,
            } as never),
          );

          expect(message).toBe("CONFLICT:UPLOAD_PARTIAL:200");
          const line = logged.mock.calls
            .map((c) => String(c[0]))
            .find((l) => l.includes("award_batch_mark_failed"))!;
          const parsed = JSON.parse(line) as Record<string, string>;
          expect(Object.keys(parsed).sort()).toEqual([
            "academicYear",
            "batchId",
            "code",
            "evt",
            "name",
          ]);
          expect(parsed.code).toBe("P1001");
          expect(line).not.toContain("SEED-R01");
        } finally {
          logged.mockRestore();
        }
      }, 300_000);
    });

    /* ---------------------------------------------------------------- */
    describe("a batch that never says how it ended (F36, F37)", () => {
      const rows = (): ImportRow[] =>
        [1, 2, 3, 4].map((n) => ({
          identifier: `seed-r${String(n).padStart(2, "0")}@u.nus.edu`,
          award: "Full Colours",
          citation: "",
        }));
      const sixteenMinutesAfter = (d: Date | null) =>
        new Date((d ?? new Date()).getTime() + 16 * 60 * 1000);

      it("returns success when the final 'complete' marker cannot be saved, and History shows it as interrupted with the computed count", async () => {
        const service = await import("../awardImport");
        const logged = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        try {
          const failing = new Proxy(db, {
            get(target, prop, receiver) {
              if (prop === "awardImportBatch") {
                return new Proxy(target.awardImportBatch, {
                  get(m, p) {
                    if (p === "update") {
                      return () =>
                        Promise.reject(
                          Object.assign(new Error("no marker for SEED-R01"), {
                            code: "P1001",
                          }),
                        );
                    }
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

          const result = await service.awardImportCommit(failing, JCRC.id, {
            academicYear: AY,
            fileName: "marker-end.csv",
            rows: rows(),
            decisions: [],
          } as never);

          expect(result.imported).toBeGreaterThan(0);
          // Tried twice, each failure logged with code and name only.
          const lines = logged.mock.calls
            .map((c) => String(c[0]))
            .filter((l) => l.includes("award_batch_mark_failed"));
          expect(lines).toHaveLength(2);
          expect(lines.join(" ")).not.toContain("SEED-R01");

          const batch = await db.awardImportBatch.findUniqueOrThrow({
            where: { id: result.batchId },
          });
          expect(batch.status).toBe("importing");
          const { awardBatchesList } = await import("../manageAwards");

          // Young: still importing. Old: interrupted, count computed from the awards.
          const young = (await awardBatchesList(db, AY, new Date())).find(
            (b) => b.id === result.batchId,
          );
          expect(young?.status).toBe("importing");
          const old = (
            await awardBatchesList(db, AY, sixteenMinutesAfter(batch.createdAt))
          ).find((b) => b.id === result.batchId);
          expect(old).toMatchObject({
            status: "interrupted",
            importedCount: result.imported,
            activeCount: result.imported,
          });
        } finally {
          logged.mockRestore();
        }
      }, 120_000);

      it("refuses to undo an upload that is still importing, and allows it once it is interrupted", async () => {
        const { awardBatchUndo } = await import("../manageAwards");
        const t = await db.awardType.findUniqueOrThrow({
          where: { normalizedName: "full colours" },
        });
        const batch = await db.awardImportBatch.create({
          data: {
            academicYear: AY,
            fileName: "busy.csv",
            rowCount: 1,
            importedCount: 0,
            skippedCount: 0,
            status: "importing",
            createdBy: JCRC.id,
            createdAt: new Date(),
          },
        });
        await db.award.create({
          data: {
            academicYear: AY,
            userID: "SEED-R20",
            title: "Full Colours",
            awardTypeID: t.id,
            importBatchID: batch.id,
            activeKey: `${AY}|SEED-R20|${t.id}`,
          },
        });

        expect(
          await errorOf(as(JCRC).awardBatches.undo({ batchId: batch.id })),
        ).toBe("CONFLICT:BATCH_IN_PROGRESS");
        expect(
          await db.award.count({ where: { importBatchID: batch.id, ...live } }),
        ).toBe(1);
        const { errorText } = await import("~/lib/transcript/adminView");
        expect(errorText("BATCH_IN_PROGRESS")).toBe(
          "This upload is still being imported. Try again in a moment.",
        );

        const undone = await awardBatchUndo(
          db,
          JCRC.id,
          batch.id,
          sixteenMinutesAfter(batch.createdAt),
        );
        expect(undone.removed).toBe(1);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("an upload that stops part way", () => {
      it("keeps what was written as a partial batch, says so, and Undo removes exactly it", async () => {
        const service = await import("../awardImport");
        const rows: ImportRow[] = [];
        const keys: Decision[] = [];
        for (let a = 0; a < 25; a += 1) {
          const name = `Partial Award ${String(a).padStart(2, "0")}`;
          keys.push({ nameKey: name.toLowerCase(), action: "create" });
          for (let n = 1; n <= 20; n += 1) {
            rows.push({
              identifier: `seed-r${String(n).padStart(2, "0")}@u.nus.edu`,
              award: name,
              citation: "",
            });
          }
        }
        expect(rows).toHaveLength(500); // three chunks of at most 200

        // The second chunk's transaction fails.
        let chunks = 0;
        const flaky = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "$transaction") {
              return (...args: unknown[]) => {
                chunks += 1;
                if (chunks === 2) {
                  return Promise.reject(new Error("database went away"));
                }
                return (
                  target.$transaction as unknown as (
                    ...a: unknown[]
                  ) => Promise<unknown>
                )(...args);
              };
            }
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });

        const message = await errorOf(
          service.awardImportCommit(flaky, JCRC.id, {
            academicYear: AY,
            fileName: "partial.csv",
            rows,
            decisions: keys,
          } as never),
        );
        expect(message).toBe("CONFLICT:UPLOAD_PARTIAL:200");

        const batch = await db.awardImportBatch.findFirstOrThrow({
          where: { fileName: "partial.csv" },
        });
        expect(batch).toMatchObject({
          status: "partial",
          rowCount: 500,
          importedCount: 200,
          skippedCount: 300,
        });
        expect(
          await db.award.count({ where: { importBatchID: batch.id } }),
        ).toBe(200);

        const listed = (
          await as(JCRC).awardBatches.list({ academicYear: AY })
        ).find((b) => b.id === batch.id);
        expect(listed).toMatchObject({ status: "partial", activeCount: 200 });

        // Undo removes exactly that batch's awards, and nobody else's.
        const others = await db.award.count({
          where: { importBatchID: { not: batch.id }, ...live },
        });
        const undone = await as(JCRC).awardBatches.undo({ batchId: batch.id });
        expect(undone.removed).toBe(200);
        expect(
          await db.award.count({
            where: { importBatchID: { not: batch.id }, ...live },
          }),
        ).toBe(others);
      }, 300_000);

      it("explains it in plain words", async () => {
        const { errorText } = await import("~/lib/transcript/adminView");
        expect(errorText("UPLOAD_PARTIAL:200")).toBe(
          "The upload stopped part way: 200 imported. Undo it from History, fix the file, and upload again.",
        );
      });

      it("logs a published-year correction in the same transaction as the awards of each chunk", async () => {
        await publish();
        for (const n of [5, 6]) {
          await as(JCRC).corrections.unlock({
            userID: `SEED-R0${n}`,
            academicYear: AY,
            reason: "Late awards",
          });
        }
        const result = await as(JCRC).awardImport.commit({
          academicYear: AY,
          fileName: "published.csv",
          rows: [
            {
              identifier: "seed-r05@u.nus.edu",
              award: "Hall Spirit Award",
              citation: "",
            },
            {
              identifier: "seed-r06@u.nus.edu",
              award: "Hall Spirit Award",
              citation: "",
            },
          ],
          decisions: [{ nameKey: "hall spirit award", action: "create" }],
        });
        expect(result.imported).toBe(2);
        const lines = await db.residentEvent.findMany({
          where: { academicYear: AY, action: "correction" },
        });
        expect(lines.map((l) => l.summary).sort()).toEqual([
          "Awards: Hall Spirit Award assigned (upload)",
          "Awards: Hall Spirit Award assigned (upload)",
        ]);
      });
    });

    /* ---------------------------------------------------------------- */
    describe("undo", () => {
      it("works on an imported batch and removes only that batch", async () => {
        const first = await commit();
        const other = await as(JCRC).awardImport.commit({
          academicYear: AY,
          fileName: "second.csv",
          rows: [
            {
              identifier: "seed-r18@u.nus.edu",
              award: "Service Excellence Award",
            },
          ],
          decisions: [],
        });
        expect(other.imported).toBe(1);
        const seededActive = await db.award.count({
          where: { academicYear: AY, importBatchID: null, ...live },
        });

        const undone = await as(JCRC).awardBatches.undo({
          batchId: first.batchId,
        });

        expect(undone.removed).toBe(8);
        expect(
          await db.award.count({
            where: { importBatchID: first.batchId, ...live },
          }),
        ).toBe(0);
        expect(
          await db.award.count({ where: { importBatchID: first.batchId } }),
        ).toBe(8); // kept, removed
        expect(
          await db.award.count({
            where: { importBatchID: other.batchId, ...live },
          }),
        ).toBe(1);
        expect(
          await db.award.count({
            where: { academicYear: AY, importBatchID: null, ...live },
          }),
        ).toBe(seededActive);
        // Both uploads are listed; only the first is undone.
        const list = await as(JCRC).awardBatches.list({ academicYear: AY });
        expect(list.find((b) => b.id === first.batchId)).toMatchObject({
          undone: true,
          activeCount: 0,
        });
        expect(list.find((b) => b.id === other.batchId)).toMatchObject({
          undone: false,
          activeCount: 1,
        });
        expect(
          await errorOf(as(JCRC).awardBatches.undo({ batchId: first.batchId })),
        ).toBe("CONFLICT:BATCH_ALREADY_UNDONE");
      });

      it("leaves a catalogue entry the import created in place", async () => {
        const result = await commit();
        await as(JCRC).awardBatches.undo({ batchId: result.batchId });
        expect(
          await db.awardType.count({
            where: { normalizedName: "hall spirit award" },
          }),
        ).toBe(1);
      });
    });
  },
);
