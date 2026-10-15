import { describe, expect, it } from "vitest";
import {
  currentAcademicYear,
  isValidAcademicYear,
  parseAcademicYear,
} from "../academicYear";

describe("currentAcademicYear", () => {
  it("starts a new academic year on 1 August, Singapore time", () => {
    // 2026-08-01 00:00 SGT is 2026-07-31 16:00 UTC.
    expect(currentAcademicYear(new Date("2026-07-31T15:59:59Z"))).toBe(
      "AY2025/26",
    );
    expect(currentAcademicYear(new Date("2026-07-31T16:00:00Z"))).toBe(
      "AY2026/27",
    );
  });

  it("covers the whole year from August to the following July", () => {
    expect(currentAcademicYear(new Date("2026-08-15T00:00:00Z"))).toBe(
      "AY2026/27",
    );
    expect(currentAcademicYear(new Date("2027-01-11T00:00:00Z"))).toBe(
      "AY2026/27",
    );
    expect(currentAcademicYear(new Date("2027-07-30T00:00:00Z"))).toBe(
      "AY2026/27",
    );
  });

  it("rolls over the century correctly", () => {
    expect(currentAcademicYear(new Date("2099-09-01T00:00:00Z"))).toBe(
      "AY2099/00",
    );
  });
});

describe("parseAcademicYear", () => {
  it("returns the bounds of a valid year", () => {
    const ay = parseAcademicYear("AY2026/27");

    expect(ay?.startYear).toBe(2026);
    expect(ay?.start.toISOString()).toBe("2026-07-31T16:00:00.000Z");
    expect(ay?.endExclusive.toISOString()).toBe("2027-07-31T16:00:00.000Z");
  });

  it.each([
    "AY2026/28",
    "AY2026-27",
    "2026/27",
    "AY26/27",
    "AY2026/2027",
    "",
    "ay2026/27",
  ])("rejects %j", (value) => {
    expect(parseAcademicYear(value)).toBeNull();
    expect(isValidAcademicYear(value)).toBe(false);
  });

  it("accepts the year that ends in 00", () => {
    expect(isValidAcademicYear("AY2099/00")).toBe(true);
  });

  it("agrees with currentAcademicYear on the year it names", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    const ay = parseAcademicYear(currentAcademicYear(now))!;

    expect(now >= ay.start && now < ay.endExclusive).toBe(true);
  });
});
