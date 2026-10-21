import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import * as periods from "../periods";
import {
  assertCollecting,
  openTranscripts,
  upsertDownloadBy,
} from "../periods";

const collecting = { status: "collecting" };
const published = { status: "published" };
/** A moment inside AY2026/27, so the year has begun. */
const NOW = new Date("2027-03-01T00:00:00Z");

/** A database that knows only the period row, and fails the test if more is touched. */
function dbWith(period: object | null) {
  const findUnique = vi.fn(async () => period);
  const upsert = vi.fn();
  const db = {
    transcriptPeriod: { findUnique, upsert },
    cCA: {
      findMany: () => {
        throw new Error("must not read CCAs");
      },
    },
    $transaction: () => {
      throw new Error("must not open a transaction");
    },
  } as unknown as PrismaClient;
  return { db, upsert };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TRPCError) return `${error.code}:${error.message}`;
    throw error;
  }
  return "ok";
}

describe("assertCollecting", () => {
  it("lets a collecting year through", async () => {
    expect(
      await codeOf(assertCollecting(dbWith(collecting).db, "AY2026/27")),
    ).toBe("ok");
  });

  it("lets a year with no period row through: it has never been published", async () => {
    expect(await codeOf(assertCollecting(dbWith(null).db, "AY2026/27"))).toBe(
      "ok",
    );
  });

  it("refuses a published year, so edits are locked", async () => {
    expect(
      await codeOf(assertCollecting(dbWith(published).db, "AY2026/27")),
    ).toBe("FORBIDDEN:PERIOD_PUBLISHED");
  });

  it("refuses a malformed academic year", async () => {
    expect(await codeOf(assertCollecting(dbWith(null).db, "2026"))).toBe(
      "BAD_REQUEST:INVALID_ACADEMIC_YEAR",
    );
  });
});

describe("no semester 2 start date", () => {
  it("has no function to set one", () => {
    expect(periods).not.toHaveProperty("upsertSem2Start");
  });
});

describe("upsertDownloadBy", () => {
  const DAY = new Date("2027-12-30T16:00:00Z");

  it("writes the date for a valid year", async () => {
    const { db, upsert } = dbWith(collecting);

    await upsertDownloadBy(db, "AY2026/27", DAY);

    expect(upsert).toHaveBeenCalledWith({
      where: { academicYear: "AY2026/27" },
      create: {
        academicYear: "AY2026/27",
        downloadBy: DAY,
        status: "collecting",
      },
      update: { downloadBy: DAY },
      select: periods.PERIOD_FIELDS,
    });
  });

  it("runs again when it loses a write conflict on the period row (T4)", async () => {
    const { db, upsert } = dbWith(collecting);
    upsert
      .mockRejectedValueOnce(Object.assign(new Error("c"), { code: "P2034" }))
      .mockResolvedValue({ academicYear: "AY2026/27" });

    await upsertDownloadBy(db, "AY2026/27", DAY);

    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("sets the date on the row a head's first save created at the same moment (T4)", async () => {
    const { db, upsert } = dbWith(null);
    const update = vi.fn().mockResolvedValue({ academicYear: "AY2026/27" });
    (db.transcriptPeriod as unknown as { update: typeof update }).update =
      update;
    upsert.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002" }),
    );

    await upsertDownloadBy(db, "AY2026/27", DAY);

    expect(update).toHaveBeenCalledWith({
      where: { academicYear: "AY2026/27" },
      data: { downloadBy: DAY },
      select: periods.PERIOD_FIELDS,
    });
  });

  it("refuses a year before transcripts began, and a malformed one", async () => {
    const { db, upsert } = dbWith(null);

    expect(await codeOf(upsertDownloadBy(db, "AY2025/26", DAY))).toBe(
      "BAD_REQUEST:YEAR_BEFORE_START",
    );
    expect(await codeOf(upsertDownloadBy(db, "2026", DAY))).toBe(
      "BAD_REQUEST:INVALID_ACADEMIC_YEAR",
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("Open transcripts is checked before any write", () => {
  const open = (period: object | null, year = "AY2026/27", now = NOW) =>
    codeOf(openTranscripts(dbWith(period).db, year, "SEED-R02", now));

  it("refuses a year that is already open", async () => {
    expect(await open(published)).toBe("CONFLICT:ALREADY_PUBLISHED");
  });

  it("refuses a future year", async () => {
    expect(await open(collecting, "AY2027/28")).toBe(
      "PRECONDITION_FAILED:YEAR_NOT_STARTED",
    );
  });

  it("refuses a past year still collecting: its member lists changed in August", async () => {
    const sep2027 = new Date("2027-09-10T04:00:00Z"); // AY2027/28
    expect(await open(collecting, "AY2026/27", sep2027)).toBe(
      "PRECONDITION_FAILED:YEAR_ENDED",
    );
    expect(await open(null, "AY2026/27", sep2027)).toBe(
      "PRECONDITION_FAILED:YEAR_ENDED",
    );
  });

  it("refuses a malformed academic year", async () => {
    expect(await open(collecting, "2026")).toBe(
      "BAD_REQUEST:INVALID_ACADEMIC_YEAR",
    );
  });

  it("refuses a year before transcripts began (F32)", async () => {
    expect(await open(collecting, "AY2025/26")).toBe(
      "BAD_REQUEST:YEAR_BEFORE_START",
    );
    expect(await open(published, "AY2024/25")).toBe(
      "BAD_REQUEST:YEAR_BEFORE_START",
    );
  });
});

describe("opening fails with a coded error, not a raw one (F35)", () => {
  it("logs only the year, code and name, and throws OPEN_FAILED", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const db = {
        transcriptPeriod: {
          findUnique: async () => ({ status: "collecting" }),
          updateMany: () =>
            Promise.reject(
              Object.assign(new Error("secret detail SEED-R01"), {
                code: "P1001",
              }),
            ),
        },
        cCA: { findMany: async () => [] },
        ccaYearFreeze: { findMany: async () => [] },
      } as unknown as PrismaClient;

      const code = await codeOf(
        openTranscripts(
          db,
          "AY2026/27",
          "SEED-R02",
          new Date("2027-03-01T00:00:00Z"),
        ),
      );

      expect(code).toBe("INTERNAL_SERVER_ERROR:OPEN_FAILED");
      const line = String(logged.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toEqual({
        evt: "transcript_open_failed",
        academicYear: "AY2026/27",
        code: "P1001",
        name: "Error",
      });
      expect(line).not.toContain("secret");
    } finally {
      logged.mockRestore();
    }
  });
});

/* ---- the Open transcripts run, with the lock itself stubbed (F1, F45, F30) ---- */

const freezeCcaMock = vi.hoisted(() => vi.fn());
vi.mock("../freeze", () => ({ freezeCca: freezeCcaMock }));

/**
 * A database holding CCAs and their lock records (ccaID -> openRunID). The
 * stubbed freezeCca writes the lock record as the real one does, inside its
 * own transaction.
 */
function runDb(ccaIDs: number[]) {
  const ccas = ccaIDs.map((ccaID) => ({ ccaID, ccaName: `CCA ${ccaID}` }));
  const locks = new Map<number, string>();
  /** When a lock was made, where not NOW. */
  const lockedAt = new Map<number, Date>();
  const claim = vi.fn(async () => ({ count: 1 }));
  // Sorted only when asked to, as the database does.
  const ccaReads = vi.fn(async (args?: { orderBy?: { ccaID?: string } }) =>
    args?.orderBy?.ccaID === "asc"
      ? [...ccas].sort((a, b) => a.ccaID - b.ccaID)
      : [...ccas],
  );
  const db = {
    transcriptPeriod: {
      findUnique: async () => ({ status: "collecting" }),
      updateMany: claim,
    },
    cCA: { findMany: ccaReads },
    ccaYearFreeze: {
      findMany: async () =>
        [...locks].map(([ccaID, openRunID]) => ({
          ccaID,
          openRunID,
          frozenAt: lockedAt.get(ccaID) ?? NOW,
        })),
    },
  } as unknown as PrismaClient;
  freezeCcaMock.mockReset();
  freezeCcaMock.mockImplementation(
    async (_db: unknown, input: { ccaID: number; openRunID: string }) => {
      const replaced = locks.has(input.ccaID);
      locks.set(input.ccaID, input.openRunID);
      lockedAt.delete(input.ccaID);
      return { replaced, unresolvedCount: 0 };
    },
  );
  return { db, ccas, locks, lockedAt, claim, ccaReads };
}

const lockedIDs = () =>
  freezeCcaMock.mock.calls.map((c) => (c[1] as { ccaID: number }).ccaID);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("Open transcripts runs in steps (F1)", () => {
  it("returns opened: false with a runID, and claims nothing, when a step runs out of time", async () => {
    const { db, claim } = runDb([3, 1, 2]);

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      budgetMs: 0,
    });

    expect(r).toMatchObject({
      opened: false,
      lockedInRun: 1,
      totalCcas: 3,
      lockedNow: 1,
      failures: [],
    });
    expect(r.runID).toMatch(UUID);
    // In ccaID order: the first CCA is the lowest id.
    expect(lockedIDs()).toEqual([1]);
    expect(claim).not.toHaveBeenCalled();
  });

  it("a continuation skips the CCAs this run locked, and claims once all are done", async () => {
    const { db, locks, claim } = runDb([1, 2, 3]);
    locks.set(1, "run-a").set(2, "run-a");

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: "run-a",
    });

    expect(lockedIDs()).toEqual([3]);
    expect(r).toMatchObject({
      opened: true,
      runID: "run-a",
      lockedInRun: 3,
      totalCcas: 3,
      lockedNow: 1,
    });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("a new press without a runID locks every CCA again, including those an earlier run locked", async () => {
    const { db, locks, lockedAt, claim } = runDb([1, 2, 3]);
    locks.set(1, "old").set(2, "old").set(3, "old");
    for (const id of [1, 2, 3])
      lockedAt.set(id, new Date(NOW.getTime() - 5 * 60_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW);

    expect(lockedIDs()).toEqual([1, 2, 3]);
    expect(r.runID).not.toBe("old");
    expect(r).toMatchObject({ opened: true, lockedNow: 3, relocked: 3 });
    expect([...locks.values()]).toEqual([r.runID, r.runID, r.runID]);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("does not continue a run idle for 11 minutes: a new run locks every CCA (F52)", async () => {
    const { db, locks, lockedAt } = runDb([1, 2, 3]);
    locks.set(1, "run-a").set(2, "run-a");
    for (const id of [1, 2])
      lockedAt.set(id, new Date(NOW.getTime() - 11 * 60_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: "run-a",
    });

    expect(r.runID).not.toBe("run-a");
    expect(r.runID).toMatch(UUID);
    expect(lockedIDs()).toEqual([1, 2, 3]);
    expect([...locks.values()]).toEqual([r.runID, r.runID, r.runID]);
  });

  it("still continues a run idle for only 5 minutes (F52)", async () => {
    const { db, locks, lockedAt } = runDb([1, 2, 3]);
    locks.set(1, "run-a").set(2, "run-a");
    for (const id of [1, 2])
      lockedAt.set(id, new Date(NOW.getTime() - 5 * 60_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: "run-a",
    });

    expect(r.runID).toBe("run-a");
    expect(lockedIDs()).toEqual([3]);
  });

  it("continues a long run that is still live: first lock 15 minutes old, latest 1 minute old (F56)", async () => {
    const { db, locks, lockedAt } = runDb([1, 2, 3]);
    locks.set(1, "run-a").set(2, "run-a");
    lockedAt.set(1, new Date(NOW.getTime() - 15 * 60_000));
    lockedAt.set(2, new Date(NOW.getTime() - 60_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: "run-a",
    });

    expect(r.runID).toBe("run-a");
    expect(lockedIDs()).toEqual([3]);
    expect(r).toMatchObject({ opened: true, lockedInRun: 3 });
  });

  it("starts a new run when even the latest lock is 11 minutes old (F56)", async () => {
    const { db, locks, lockedAt } = runDb([1, 2, 3]);
    locks.set(1, "run-a").set(2, "run-a");
    lockedAt.set(1, new Date(NOW.getTime() - 15 * 60_000));
    lockedAt.set(2, new Date(NOW.getTime() - 11 * 60_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: "run-a",
    });

    expect(r.runID).not.toBe("run-a");
    expect(lockedIDs()).toEqual([1, 2, 3]);
  });

  it("refuses a new press while another run locked a CCA 10 seconds ago (F75)", async () => {
    const { db, locks, lockedAt, claim } = runDb([1, 2, 3]);
    locks.set(1, "run-a");
    lockedAt.set(1, new Date(NOW.getTime() - 10_000));

    expect(
      await codeOf(openTranscripts(db, "AY2026/27", "SEED-R02", NOW)),
    ).toBe("CONFLICT:OPEN_IN_PROGRESS");
    // An unknown runID starts a new run too, so it is refused as well.
    expect(
      await codeOf(
        openTranscripts(db, "AY2026/27", "SEED-R02", NOW, { runID: "nobody" }),
      ),
    ).toBe("CONFLICT:OPEN_IN_PROGRESS");
    expect(freezeCcaMock).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("starts a new run when the other run's latest lock is 90 seconds old (F75)", async () => {
    const { db, locks, lockedAt } = runDb([1, 2]);
    locks.set(1, "run-a");
    lockedAt.set(1, new Date(NOW.getTime() - 90_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW);

    expect(r.runID).not.toBe("run-a");
    expect(r).toMatchObject({ opened: true, lockedNow: 2 });
  });

  it("never refuses a continuation of the live run, even with its locks seconds old (F75)", async () => {
    const { db, locks, lockedAt } = runDb([1, 2, 3]);
    locks.set(1, "run-a").set(2, "run-a");
    lockedAt.set(1, new Date(NOW.getTime() - 10_000));
    lockedAt.set(2, new Date(NOW.getTime() - 5_000));

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: "run-a",
    });

    expect(r).toMatchObject({ opened: true, runID: "run-a", lockedNow: 1 });
  });

  it("stops the run when one CCA fails: opened false, the failure returned, no claim", async () => {
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const { db, claim } = runDb([1, 2, 3]);
      const lock = freezeCcaMock.getMockImplementation()!;
      freezeCcaMock.mockImplementation(
        async (d: unknown, input: { ccaID: number; openRunID: string }) => {
          if (input.ccaID === 2) {
            throw Object.assign(new Error("boom"), { code: "P2010" });
          }
          return lock(d, input);
        },
      );

      const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW);

      expect(r).toMatchObject({
        opened: false,
        failures: [{ name: "CCA 2", code: "P2010" }],
        lockedInRun: 2,
        totalCcas: 3,
      });
      expect(claim).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it.each([
    ["E0123456 duplicate key for member", undefined, "UNKNOWN"],
    ["FREEZE_RACE", undefined, "FREEZE_RACE"],
    ["boom", "P2034", "P2034"],
    ["boom", "E0123456", "UNKNOWN"],
    ["PERIOD_PUBLISHED", undefined, "PERIOD_PUBLISHED"],
  ])(
    "a lock failure with message %j and code %j is reported as %s (F71)",
    async (message, code, expected) => {
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const { db } = runDb([1]);
        freezeCcaMock.mockRejectedValue(
          Object.assign(new Error(message), { code }),
        );

        const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW);

        expect(r.failures).toEqual([{ name: "CCA 1", code: expected }]);
        expect(String(logged.mock.calls[0]?.[0])).not.toContain("E0123456");
      } finally {
        logged.mockRestore();
      }
    },
  );

  it("opens the year over several requests of the real loop, each continuing the same run (F30)", async () => {
    const { db, claim } = runDb([1, 2, 3, 4]);
    let r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      budgetMs: 0,
    });
    const runID = r.runID;
    const progress = [r.lockedInRun];
    while (!r.opened) {
      expect(r.failures).toEqual([]);
      expect(claim).not.toHaveBeenCalled();
      r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
        runID,
        budgetMs: 0,
      });
      progress.push(r.lockedInRun);
    }

    expect(progress).toEqual([1, 2, 3, 4]);
    expect(lockedIDs()).toEqual([1, 2, 3, 4]);
    expect(r.runID).toBe(runID);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe("a CCA created during the run is not missed (F45)", () => {
  it("does not claim when a CCA appears between the last lock and the claim check", async () => {
    const { db, ccas, claim, ccaReads } = runDb([1, 2]);
    // The first read (the step's list) has two CCAs; a third is created
    // before the read right before the claim.
    ccaReads.mockImplementationOnce(async () => {
      const first = [...ccas];
      ccas.push({ ccaID: 3, ccaName: "CCA 3" });
      return first;
    });

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW);

    expect(lockedIDs()).toEqual([1, 2]);
    expect(r).toMatchObject({ opened: false, lockedInRun: 2, totalCcas: 3 });
    expect(claim).not.toHaveBeenCalled();

    // The client's next request continues the run: it locks the new CCA only.
    const next = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: r.runID,
    });
    expect(lockedIDs()).toEqual([1, 2, 3]);
    expect(next).toMatchObject({ opened: true, lockedInRun: 3, totalCcas: 3 });
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("counts a lock another run made at the same time, never a stale one from before this run", async () => {
    const { db, ccas, locks, lockedAt, claim, ccaReads } = runDb([1, 2]);
    // CCA 3 appears mid-run with a lock from a run that stopped last week.
    ccaReads.mockImplementationOnce(async () => {
      const first = [...ccas];
      ccas.push({ ccaID: 3, ccaName: "CCA 3" });
      locks.set(3, "stopped-run");
      lockedAt.set(3, new Date(NOW.getTime() - 7 * 86_400_000));
      return first;
    });

    const r = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW);
    expect(r.opened).toBe(false);
    expect(claim).not.toHaveBeenCalled();

    // A run pressed at the same moment locks CCA 3 just after this request
    // read its list (so this request leaves CCA 3 alone): that lock is current.
    locks.set(3, "other-run");
    lockedAt.delete(3);
    ccaReads.mockImplementationOnce(async () => [
      { ccaID: 1, ccaName: "CCA 1" },
    ]);
    const next = await openTranscripts(db, "AY2026/27", "SEED-R02", NOW, {
      runID: r.runID,
    });
    expect(next.opened).toBe(true);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
