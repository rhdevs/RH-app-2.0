import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/server/db", () => ({ db: {} }));

import {
  CALENDAR_ROW_MAX,
  readPublishedEvents,
} from "~/server/api/services/calendar/read";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    eventID: i + 1,
    ccaID: null,
    title: `Event ${i + 1}`,
    publicDescription: null,
    location: null,
    startTime: 1_800_000_000 + i,
    endTime: null,
    updatedAt: null,
  }));

const dbWith = (n: number) =>
  ({
    event: { findMany: vi.fn(() => Promise.resolve(rows(n))) },
    cCA: { findMany: vi.fn(() => Promise.resolve([])) },
  }) as never;

describe("the row ceiling is never silent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks the database for no more than the ceiling", async () => {
    const db = dbWith(1);
    await readPublishedEvents(db, 0, 2_000_000_000);
    const args = (
      db as unknown as {
        event: { findMany: { mock: { calls: Array<[{ take: number }]> } } };
      }
    ).event.findMany.mock.calls[0]![0];
    expect(args.take).toBe(CALENDAR_ROW_MAX);
  });

  it("logs a warning with the count when a read hits the ceiling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const items = await readPublishedEvents(
      dbWith(CALENDAR_ROW_MAX),
      0,
      2_000_000_000,
    );

    expect(items).toHaveLength(CALENDAR_ROW_MAX);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
      evt: "calendar_row_cap_hit",
      layer: "events",
      count: CALENDAR_ROW_MAX,
      cap: CALENDAR_ROW_MAX,
    });
  });

  it("is quiet below the ceiling", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await readPublishedEvents(dbWith(CALENDAR_ROW_MAX - 1), 0, 2_000_000_000);

    expect(warn).not.toHaveBeenCalled();
  });
});
