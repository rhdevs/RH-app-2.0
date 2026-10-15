import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import {
  assertCollecting,
  publish,
  publishBlocker,
  reopen,
  reopenBlocker,
  upsertSem2Start,
} from "../periods";

const SEM2 = new Date("2027-01-11T00:00:00Z");
const collecting = { status: "collecting", sem2Start: SEM2 };
const published = { status: "published", sem2Start: SEM2 };

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

describe("publishBlocker", () => {
  it.each([
    [null, "PERIOD_NOT_FOUND"],
    [{ status: "collecting", sem2Start: null }, "SEM2_START_REQUIRED"],
    [{ status: null, sem2Start: null }, "SEM2_START_REQUIRED"],
    [published, "ALREADY_PUBLISHED"],
    [{ status: "published", sem2Start: null }, "ALREADY_PUBLISHED"],
    [collecting, null],
    [{ status: null, sem2Start: SEM2 }, null],
  ])("for %j says %j", (period, expected) => {
    expect(publishBlocker(period)).toBe(expected);
  });
});

describe("reopenBlocker", () => {
  it.each([
    [null, "PERIOD_NOT_FOUND"],
    [collecting, "NOT_PUBLISHED"],
    [{ status: null, sem2Start: null }, "NOT_PUBLISHED"],
    [published, null],
  ])("for %j says %j", (period, expected) => {
    expect(reopenBlocker(period)).toBe(expected);
  });
});

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

describe("publish / reopen guards (checked before any write)", () => {
  it("publish needs a period to exist", async () => {
    expect(
      await codeOf(publish(dbWith(null).db, "AY2026/27", "SEED-R02")),
    ).toBe("NOT_FOUND:PERIOD_NOT_FOUND");
  });

  it("publish refuses without a semester-2 start date", async () => {
    const period = { status: "collecting", sem2Start: null };

    expect(
      await codeOf(publish(dbWith(period).db, "AY2026/27", "SEED-R02")),
    ).toBe("PRECONDITION_FAILED:SEM2_START_REQUIRED");
  });

  it("publish refuses a year that is already published", async () => {
    expect(
      await codeOf(publish(dbWith(published).db, "AY2026/27", "SEED-R02")),
    ).toBe("CONFLICT:ALREADY_PUBLISHED");
  });

  it("publish refuses a malformed academic year", async () => {
    expect(
      await codeOf(publish(dbWith(collecting).db, "bogus", "SEED-R02")),
    ).toBe("BAD_REQUEST:INVALID_ACADEMIC_YEAR");
  });

  it("reopen refuses a year that is not published, or that does not exist", async () => {
    expect(
      await codeOf(reopen(dbWith(collecting).db, "AY2026/27", "SEED-R02")),
    ).toBe("CONFLICT:NOT_PUBLISHED");
    expect(await codeOf(reopen(dbWith(null).db, "AY2026/27", "SEED-R02"))).toBe(
      "NOT_FOUND:PERIOD_NOT_FOUND",
    );
  });
});
