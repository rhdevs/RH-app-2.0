import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import {
  assertCollecting,
  backToCollecting,
  closeYear,
  publish,
  reopen,
  upsertSem2Start,
} from "../periods";

const SEM2 = new Date("2027-01-11T00:00:00Z");
const collecting = { status: "collecting", sem2Start: SEM2 };
const published = { status: "published", sem2Start: SEM2 };
const closed = { status: "closed", sem2Start: SEM2 };
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

describe("year transitions are checked before any write", () => {
  const who = "SEED-R02";

  it("close needs a period with a semester 2 date", async () => {
    expect(
      await codeOf(closeYear(dbWith(null).db, "AY2026/27", who, NOW)),
    ).toBe("PRECONDITION_FAILED:SEM2_START_REQUIRED");
    const noDate = { status: "collecting", sem2Start: null };
    expect(
      await codeOf(closeYear(dbWith(noDate).db, "AY2026/27", who, NOW)),
    ).toBe("PRECONDITION_FAILED:SEM2_START_REQUIRED");
  });

  it("close refuses a year that has not begun", async () => {
    expect(
      await codeOf(closeYear(dbWith(collecting).db, "AY2027/28", who, NOW)),
    ).toBe("PRECONDITION_FAILED:YEAR_NOT_STARTED");
  });

  it("close refuses a year that is already closed or published", async () => {
    expect(
      await codeOf(closeYear(dbWith(closed).db, "AY2026/27", who, NOW)),
    ).toBe("CONFLICT:NOT_COLLECTING");
    expect(
      await codeOf(closeYear(dbWith(published).db, "AY2026/27", who, NOW)),
    ).toBe("CONFLICT:NOT_COLLECTING");
  });

  it("publish works only from closed", async () => {
    expect(
      await codeOf(publish(dbWith(collecting).db, "AY2026/27", who, NOW)),
    ).toBe("CONFLICT:NOT_CLOSED");
    expect(
      await codeOf(publish(dbWith(published).db, "AY2026/27", who, NOW)),
    ).toBe("CONFLICT:NOT_CLOSED");
    expect(await codeOf(publish(dbWith(null).db, "AY2026/27", who, NOW))).toBe(
      "CONFLICT:NOT_CLOSED",
    );
  });

  it("reopen for review works only from published", async () => {
    expect(
      await codeOf(reopen(dbWith(collecting).db, "AY2026/27", who, NOW)),
    ).toBe("CONFLICT:NOT_PUBLISHED");
    expect(await codeOf(reopen(dbWith(closed).db, "AY2026/27", who, NOW))).toBe(
      "CONFLICT:NOT_PUBLISHED",
    );
    expect(await codeOf(reopen(dbWith(null).db, "AY2026/27", who, NOW))).toBe(
      "CONFLICT:NOT_PUBLISHED",
    );
  });

  it("back to collecting works only from closed", async () => {
    expect(
      await codeOf(backToCollecting(dbWith(collecting).db, "AY2026/27", "SEED-R02", NOW)),
    ).toBe("CONFLICT:NOT_CLOSED");
    expect(
      await codeOf(backToCollecting(dbWith(published).db, "AY2026/27", "SEED-R02", NOW)),
    ).toBe("CONFLICT:NOT_CLOSED");
  });

  it("every transition refuses a malformed academic year", async () => {
    expect(
      await codeOf(closeYear(dbWith(collecting).db, "bogus", who, NOW)),
    ).toBe("BAD_REQUEST:INVALID_ACADEMIC_YEAR");
    expect(await codeOf(publish(dbWith(closed).db, "bogus", who, NOW))).toBe(
      "BAD_REQUEST:INVALID_ACADEMIC_YEAR",
    );
    expect(await codeOf(reopen(dbWith(published).db, "2026", who, NOW))).toBe(
      "BAD_REQUEST:INVALID_ACADEMIC_YEAR",
    );
  });
});
