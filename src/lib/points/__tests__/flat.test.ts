import { describe, expect, it } from "vitest";

import {
  FLAT_POINTS_MAX,
  flatNotice,
  flatPointsProblem,
  formatFlatPoints,
  isValidFlatPoints,
  parseFlatPointsText,
} from "~/lib/points/flat";

describe("flat points validation", () => {
  it.each([0, 1, 7.5, 12.25, 10, FLAT_POINTS_MAX])("accepts %s", (n) => {
    expect(isValidFlatPoints(n)).toBe(true);
    expect(flatPointsProblem(n)).toBeNull();
  });

  it.each([-1, -0.01, 50.01, 51, 1.234, Number.NaN, Infinity])(
    "rejects %s",
    (n) => {
      expect(isValidFlatPoints(n)).toBe(false);
      expect(flatPointsProblem(n)).not.toBeNull();
    },
  );

  it("is 0 to 50 with at most 2 decimals", () => {
    expect(FLAT_POINTS_MAX).toBe(50);
    expect(flatPointsProblem(60)).toMatch(/0 and 50/);
    expect(flatPointsProblem(1.234)).toMatch(/2 decimal/);
  });
});

describe("parseFlatPointsText", () => {
  it("reads numbers, trimming spaces", () => {
    expect(parseFlatPointsText(" 7.5 ")).toEqual({ ok: true, value: 7.5 });
    expect(parseFlatPointsText("10")).toEqual({ ok: true, value: 10 });
  });

  it("explains blank and non-numeric text", () => {
    expect(parseFlatPointsText("")).toMatchObject({ ok: false });
    expect(parseFlatPointsText("abc")).toEqual({
      ok: false,
      message: "Enter a number, e.g. 10 or 7.5.",
    });
    expect(parseFlatPointsText("1e3")).toMatchObject({ ok: false });
  });

  it("applies the range and decimal rules", () => {
    expect(parseFlatPointsText("51")).toMatchObject({ ok: false });
    expect(parseFlatPointsText("1.234")).toMatchObject({ ok: false });
  });
});

describe("formatFlatPoints", () => {
  it("has no trailing zeros", () => {
    expect(formatFlatPoints(12)).toBe("12");
    expect(formatFlatPoints(7.5)).toBe("7.5");
    expect(formatFlatPoints(7.25)).toBe("7.25");
  });
});

describe("leader page for a flat CCA", () => {
  it("says no action is needed and names the value", () => {
    expect(flatNotice(10)).toBe(
      "This CCA uses flat points set by JCRC: every member receives 10 points for this CCA. No action needed.",
    );
    expect(flatNotice(7.5)).toContain("receives 7.5 points");
  });

  it("is null for a normal CCA", () => {
    expect(flatNotice(null)).toBeNull();
  });
});
