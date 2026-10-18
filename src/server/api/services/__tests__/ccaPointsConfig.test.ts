import { describe, expect, it } from "vitest";

import { DEFAULT_RANGE } from "~/lib/points/constants";
import {
  ccaScope,
  DEFAULT_SCOPE,
  rangeProblem,
  resolveRange,
} from "~/server/api/services/ccaPointsConfig";

const row = (
  patch: Partial<
    Record<"meanMin" | "meanMax" | "sdMin" | "sdMax", number | null>
  >,
) => ({ meanMin: null, meanMax: null, sdMin: null, sdMax: null, ...patch });

describe("scopes", () => {
  it("names the default row and per-CCA rows", () => {
    expect(DEFAULT_SCOPE).toBe("default");
    expect(ccaScope(12)).toBe("cca:12");
  });
});

describe("resolveRange", () => {
  it("is the built-in default when there are no rows at all", () => {
    expect(resolveRange(null, null)).toEqual({
      range: DEFAULT_RANGE,
      waivedFields: [],
      isWaived: false,
    });
  });

  it("uses the default row when there is no override", () => {
    const result = resolveRange(
      row({ meanMin: 8, meanMax: 12, sdMin: 1, sdMax: 4 }),
      null,
    );
    expect(result.range).toEqual({
      meanMin: 8,
      meanMax: 12,
      sdMin: 1,
      sdMax: 4,
    });
    expect(result.isWaived).toBe(false);
  });

  it("falls back from the default row to the built-in value, per field", () => {
    const result = resolveRange(row({ meanMax: 16 }), null);
    expect(result.range).toEqual({ ...DEFAULT_RANGE, meanMax: 16 });
  });

  it("falls back override -> default row -> built-in, per field", () => {
    const result = resolveRange(
      row({ meanMin: 9, meanMax: 13 }),
      row({ meanMax: 17, sdMax: 3 }),
    );
    expect(result.range).toEqual({
      meanMin: 9, // default row
      meanMax: 17, // override
      sdMin: 2, // built-in
      sdMax: 3, // override
    });
    expect(result.waivedFields).toEqual(["meanMax", "sdMax"]);
    expect(result.isWaived).toBe(true);
  });

  it("keeps an override of 0 instead of falling back", () => {
    const result = resolveRange(null, row({ sdMin: 0 }));
    expect(result.range.sdMin).toBe(0);
    expect(result.waivedFields).toEqual(["sdMin"]);
  });

  it("an override row with every field blank is not a waiver", () => {
    expect(resolveRange(null, row({}))).toEqual({
      range: DEFAULT_RANGE,
      waivedFields: [],
      isWaived: false,
    });
  });

  it("does not mutate its inputs", () => {
    const d = Object.freeze(row({ meanMin: 9 }));
    const o = Object.freeze(row({ meanMax: 17 }));
    expect(() => resolveRange(d, o)).not.toThrow();
  });
});

describe("rangeProblem", () => {
  it("is null for a sound range, including min equal to max", () => {
    expect(rangeProblem(DEFAULT_RANGE)).toBeNull();
    expect(
      rangeProblem({ meanMin: 12, meanMax: 12, sdMin: 3, sdMax: 3 }),
    ).toBeNull();
  });

  it("names the mean when its minimum is above its maximum", () => {
    expect(
      rangeProblem({ meanMin: 15, meanMax: 10, sdMin: 2, sdMax: 5 }),
    ).toMatch(/average/i);
  });

  it("names the spread when its minimum is above its maximum", () => {
    expect(
      rangeProblem({ meanMin: 10, meanMax: 14, sdMin: 6, sdMax: 5 }),
    ).toMatch(/spread/i);
  });
});
