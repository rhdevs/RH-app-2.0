import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dayKeyOfEpoch,
  formatSgtClock,
  monthGrid,
  monthOfDayKey,
  monthTitle,
  sgtMidnight,
  shiftMonth,
  todayKey,
} from "../month";

/** The two machine clocks the proposal's A8 names: UTC-12 and UTC. */
const ZONES = [
  ["UTC-12", "Etc/GMT+12"],
  ["UTC", "UTC"],
] as const;

describe("A8: today is the Singapore day, whatever the machine's clock", () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.TZ;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });

  it.each(ZONES)(
    "00:00 UTC is 08:00 in Singapore, with the clock at %s",
    (_n, tz) => {
      process.env.TZ = tz;
      vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
      expect(todayKey()).toBe("2026-11-01");
      expect(formatSgtClock(Math.floor(Date.now() / 1000))).toMatch(
        /^8:00\s?am$/i,
      );
    },
  );

  it.each(ZONES)(
    "15:59 UTC is still the same Singapore day, with the clock at %s",
    (_n, tz) => {
      process.env.TZ = tz;
      vi.setSystemTime(new Date("2026-11-01T15:59:59Z"));
      expect(todayKey()).toBe("2026-11-01");
    },
  );

  it.each(ZONES)(
    "16:00 UTC is already the next Singapore day, with the clock at %s",
    (_n, tz) => {
      process.env.TZ = tz;
      vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
      expect(todayKey()).toBe("2026-11-02");
    },
  );

  it.each(ZONES)(
    "puts an event on its Singapore day, with the clock at %s",
    (_n, tz) => {
      process.env.TZ = tz;
      // 07:30 Singapore on 2 Nov is 23:30 UTC on 1 Nov.
      const at = Date.UTC(2026, 10, 1, 23, 30) / 1000;
      expect(dayKeyOfEpoch(at)).toBe("2026-11-02");
      expect(formatSgtClock(at)).toMatch(/^7:30\s?am$/i);
    },
  );
});

describe("monthGrid", () => {
  it("covers whole weeks, Monday first, around November 2026", () => {
    const g = monthGrid(2026, 11);
    // 1 Nov 2026 is a Sunday, so the grid starts Monday 26 Oct.
    expect(g.days[0]).toBe("2026-10-26");
    // Six lead days plus 30 days is 36, so six weeks, ending Sunday 6 Dec.
    expect(g.days).toHaveLength(42);
    expect(g.days[g.days.length - 1]).toBe("2026-12-06");
    expect(g.to - g.from).toBe(42 * 86_400);
  });

  it("starts at Singapore midnight, not UTC midnight", () => {
    const g = monthGrid(2026, 11);
    expect(g.from).toBe(sgtMidnight(2026, 10, 26));
    expect(new Date(g.from * 1000).toISOString()).toBe(
      "2026-10-25T16:00:00.000Z",
    );
  });

  it("handles a month that starts on Monday with no lead days", () => {
    // 1 Jun 2026 is a Monday.
    const g = monthGrid(2026, 6);
    expect(g.days[0]).toBe("2026-06-01");
    expect(g.days).toHaveLength(35);
  });

  it("rolls December into January", () => {
    const g = monthGrid(2026, 12);
    expect(g.days).toContain("2026-12-31");
    expect(g.days[g.days.length - 1]! >= "2026-12-31").toBe(true);
  });

  it("an event at the last minute of the month is inside the window", () => {
    const g = monthGrid(2026, 2);
    const last = sgtMidnight(2026, 3, 1) - 60;
    expect(last >= g.from && last < g.to).toBe(true);
  });
});

describe("month helpers", () => {
  it("shifts across year ends", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 6, 1)).toEqual({ year: 2026, month: 7 });
  });

  it("reads a month from a day key and titles it", () => {
    expect(monthOfDayKey("2026-11-02")).toEqual({ year: 2026, month: 11 });
    expect(monthTitle(2026, 11)).toBe("November 2026");
  });
});
