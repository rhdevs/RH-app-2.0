import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { assertCollecting, openTranscripts, upsertSem2Start } from "../periods";

const SEM2 = new Date("2027-01-11T00:00:00Z");
const collecting = { status: "collecting", sem2Start: SEM2 };
const published = { status: "published", sem2Start: SEM2 };
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

describe("upsertSem2Start", () => {
  it("refuses a date outside the academic year", async () => {
    const { db, upsert } = dbWith(collecting);

    expect(
      await codeOf(
        upsertSem2Start(db, "AY2026/27", new Date("2028-01-11T00:00:00Z")),
      ),
    ).toBe("BAD_REQUEST:SEM2_START_OUTSIDE_YEAR");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses to change a published year", async () => {
    const { db, upsert } = dbWith(published);

    expect(await codeOf(upsertSem2Start(db, "AY2026/27", SEM2))).toBe(
      "FORBIDDEN:PERIOD_PUBLISHED",
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it("writes a valid date for a collecting year", async () => {
    const { db, upsert } = dbWith(collecting);

    await upsertSem2Start(db, "AY2026/27", SEM2);

    expect(upsert).toHaveBeenCalledWith({
      where: { academicYear: "AY2026/27" },
      create: {
        academicYear: "AY2026/27",
        sem2Start: SEM2,
        status: "collecting",
      },
      update: { sem2Start: SEM2 },
    });
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
});
