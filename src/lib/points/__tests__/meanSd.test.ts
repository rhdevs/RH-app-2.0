import { describe, expect, it } from "vitest";

import {
  DEFAULT_RANGE,
  MEAN_LIMITS,
  SD_LIMITS,
  TOLERANCE,
} from "~/lib/points/constants";
import {
  checkMeanSd,
  fillRange,
  mean,
  populationSd,
} from "~/lib/points/meanSd";

// Same scores as the sandbox's worked example E8 (rh-points-sandbox/docs/points-spec.md).
const E8_SCORES = [20, 20, 15, 12, 10, 8, 5];

describe("constants", () => {
  it("matches the sandbox's meanSdDefault", () => {
    expect(DEFAULT_RANGE).toEqual({
      meanMin: 10,
      meanMax: 14,
      sdMin: 2,
      sdMax: 5,
    });
    expect(TOLERANCE).toBe(1e-9);
  });

  it("limits what JCRC may configure", () => {
    expect(MEAN_LIMITS).toEqual([0, 20]);
    expect(SD_LIMITS).toEqual([0, 10]);
  });
});

describe("mean and population SD", () => {
  it("E8: mean 12.857 and population SD 5.357", () => {
    expect(mean(E8_SCORES)).toBeCloseTo(12.857, 3);
    expect(populationSd(E8_SCORES)).toBeCloseTo(5.357, 3);
  });

  it("divides by N, not N-1", () => {
    expect(populationSd([0, 2])).toBe(1);
  });

  it("is NaN for no scores", () => {
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(Number.isNaN(populationSd([]))).toBe(true);
  });
});

describe("checkMeanSd", () => {
  it("E8: the mean passes and the SD fails the default 2-5", () => {
    const result = checkMeanSd(E8_SCORES, DEFAULT_RANGE);
    expect(result.meanOk).toBe(true);
    expect(result.sdOk).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("accepts scores inside both ranges", () => {
    expect(checkMeanSd([10, 12, 14, 16], DEFAULT_RANGE).ok).toBe(true);
  });

  it("bounds are inclusive at both ends", () => {
    const exact = { meanMin: 1, meanMax: 1, sdMin: 1, sdMax: 1 };
    expect(checkMeanSd([0, 2], exact).ok).toBe(true);
  });

  it("tolerates noise below 1e-9 and rejects a larger miss", () => {
    const within = {
      meanMin: 1 + TOLERANCE / 2,
      meanMax: 5,
      sdMin: 0,
      sdMax: 5,
    };
    const outside = {
      meanMin: 1 + TOLERANCE * 10,
      meanMax: 5,
      sdMin: 0,
      sdMax: 5,
    };
    expect(checkMeanSd([0, 2], within).meanOk).toBe(true);
    expect(checkMeanSd([0, 2], outside).meanOk).toBe(false);
  });

  it("fails on an empty list", () => {
    const result = checkMeanSd([], DEFAULT_RANGE);
    expect(result.ok).toBe(false);
    expect(Number.isNaN(result.mean)).toBe(true);
  });
});

describe("fillRange", () => {
  it("falls back to the default for each blank field independently", () => {
    expect(
      fillRange({ meanMax: 12, sdMin: null, sdMax: undefined }, DEFAULT_RANGE),
    ).toEqual({ meanMin: 10, meanMax: 12, sdMin: 2, sdMax: 5 });
  });

  it("keeps an override of 0", () => {
    expect(fillRange({ sdMin: 0 }, DEFAULT_RANGE).sdMin).toBe(0);
  });

  it("defaults the fallback itself to the built-in range", () => {
    expect(fillRange({})).toEqual(DEFAULT_RANGE);
  });
});
