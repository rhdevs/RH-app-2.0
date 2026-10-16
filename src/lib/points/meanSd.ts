import { DEFAULT_RANGE, TOLERANCE, type Range } from "~/lib/points/constants";

/**
 * Same semantics as rh-points-sandbox/src/engine/meanSd.ts:
 *  - mean and POPULATION standard deviation (divide by N, not N-1)
 *  - bounds are INCLUSIVE, with a tolerance of 1e-9
 *  - each range field falls back to its default independently
 */

export type RangeOverride = {
  [K in keyof Range]?: number | null | undefined;
};

export type MeanSdCheck = {
  mean: number;
  sd: number;
  meanOk: boolean;
  sdOk: boolean;
  ok: boolean;
};

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function populationSd(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const centre = mean(values);
  const squares = values.reduce((sum, v) => sum + (v - centre) ** 2, 0);
  return Math.sqrt(squares / values.length);
}

/** Inclusive range test with the shared tolerance. NaN is never inside. */
export function withinRange(value: number, min: number, max: number): boolean {
  return value >= min - TOLERANCE && value <= max + TOLERANCE;
}

export function checkMeanSd(
  scores: readonly number[],
  range: Readonly<Range>,
): MeanSdCheck {
  const avg = mean(scores);
  const sd = populationSd(scores);
  const meanOk = withinRange(avg, range.meanMin, range.meanMax);
  const sdOk = withinRange(sd, range.sdMin, range.sdMax);
  return { mean: avg, sd, meanOk, sdOk, ok: meanOk && sdOk };
}

/** Each blank (null/undefined) field takes the fallback's value, independently. */
export function fillRange(
  override: RangeOverride,
  fallback: Readonly<Range> = DEFAULT_RANGE,
): Range {
  return {
    meanMin: override.meanMin ?? fallback.meanMin,
    meanMax: override.meanMax ?? fallback.meanMax,
    sdMin: override.sdMin ?? fallback.sdMin,
    sdMax: override.sdMax ?? fallback.sdMax,
  };
}

/** Plain-English reason a range cannot be saved, or null when it is sound. */
export function rangeProblem(range: Readonly<Range>): string | null {
  if (range.meanMin > range.meanMax) {
    return "The average's minimum can't be above its maximum.";
  }
  if (range.sdMin > range.sdMax) {
    return "The spread's minimum can't be above its maximum.";
  }
  return null;
}
