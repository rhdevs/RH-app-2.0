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
