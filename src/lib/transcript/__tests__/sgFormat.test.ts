import { describe, expect, it } from "vitest";
import {
  formatSgDate,
  instantToSgDate,
  sgDateToInstant,
  storedCalendarDate,
} from "../sgDate";

describe("Singapore calendar dates", () => {
  it("shows an instant whose UTC date differs from its Singapore date as the Singapore date", () => {
    // 16:30 UTC on 14 October is 00:30 on 15 October in Singapore.
    const instant = new Date("2026-10-14T16:30:00Z");

    expect(instant.toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(instantToSgDate(instant)).toBe("2026-10-15");
    expect(formatSgDate(instant)).toBe("15 Oct 2026");
  });

  it("shows the semester 2 start as the date that was typed", () => {
    const stored = sgDateToInstant("2027-01-11")!;

    expect(stored.toISOString()).toBe("2027-01-10T16:00:00.000Z");
    expect(formatSgDate(stored)).toBe("11 Jan 2027");
  });

  it("does not depend on the machine's time zone", () => {
    const before = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
        process.env.TZ = tz;
        expect(formatSgDate("2026-12-31T16:00:00Z")).toBe("1 Jan 2027");
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("accepts an ISO string, as a value from the API arrives", () => {
    expect(formatSgDate("2026-07-31T16:00:00.000Z")).toBe("1 Aug 2026");
  });

  it("handles month and year boundaries", () => {
    expect(formatSgDate(new Date("2026-02-28T15:59:59Z"))).toBe("28 Feb 2026");
    expect(formatSgDate(new Date("2026-02-28T16:00:00Z"))).toBe("1 Mar 2026");
  });

  it("reads a stored calendar date (UTC midnight) as itself, unshifted", () => {
    const stored = new Date("2026-11-02T00:00:00Z");

    expect(storedCalendarDate(stored)).toBe("2026-11-02");
    // Shifting it as an instant would be the wrong reading.
    expect(instantToSgDate(stored)).toBe("2026-11-02");
    const lateUtc = new Date("2026-11-02T20:00:00Z");
    expect(storedCalendarDate(lateUtc)).toBe("2026-11-02");
    expect(instantToSgDate(lateUtc)).toBe("2026-11-03");
  });
});
