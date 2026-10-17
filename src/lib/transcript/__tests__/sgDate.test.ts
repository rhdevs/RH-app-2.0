import { describe, expect, it } from "vitest";
import { instantToSgDate, sgDateToInstant } from "../sgDate";

describe("sgDateToInstant", () => {
  it("is midnight Singapore: 16:00 UTC the evening before", () => {
    expect(sgDateToInstant("2027-01-11")?.toISOString()).toBe(
      "2027-01-10T16:00:00.000Z",
    );
  });

  it("crosses the year boundary correctly", () => {
    expect(sgDateToInstant("2027-01-01")?.toISOString()).toBe(
      "2026-12-31T16:00:00.000Z",
    );
  });

  it("handles a leap day", () => {
    expect(sgDateToInstant("2028-02-29")?.toISOString()).toBe(
      "2028-02-28T16:00:00.000Z",
    );
  });

  it.each([
    "2027-02-30",
    "2027-13-01",
    "2027-1-1",
    "",
    "tomorrow",
    "2027-01-11T00:00",
  ])("rejects %j", (value) => {
    expect(sgDateToInstant(value)).toBeNull();
  });
});

describe("instantToSgDate", () => {
  it("shows the Singapore date, even where the UTC date is the day before", () => {
    const instant = new Date("2027-01-10T16:00:00Z");

    expect(instant.toISOString().slice(0, 10)).toBe("2027-01-10"); // the UTC date
    expect(instantToSgDate(instant)).toBe("2027-01-11"); // the Singapore date
  });

  it("switches day exactly at 16:00 UTC", () => {
    expect(instantToSgDate(new Date("2027-01-10T15:59:59.999Z"))).toBe(
      "2027-01-10",
    );
    expect(instantToSgDate(new Date("2027-01-10T16:00:00.000Z"))).toBe(
      "2027-01-11",
    );
  });

  it("agrees with UTC midnight (which is 08:00 in Singapore)", () => {
    expect(instantToSgDate(new Date("2027-01-11T00:00:00Z"))).toBe(
      "2027-01-11",
    );
  });
});

describe("round trip", () => {
  it("returns the same calendar date for every day of two years", () => {
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 731; i += 1) {
      const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);

      expect(instantToSgDate(sgDateToInstant(date)!)).toBe(date);
    }
  });
});
