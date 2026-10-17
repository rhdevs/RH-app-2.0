import type { Range } from "~/lib/points/constants";
import { withinRange } from "~/lib/points/meanSd";

/** Two decimal places everywhere a leader sees a statistic. */
const fixed = (n: number): string => n.toFixed(2);

/**
 * A mean or SD for display next to its allowed range. Two decimals normally; but
 * the check is exact, so a value just outside the range that 2 dp would round onto
 * (or inside) the edge gets the fewest extra decimals (up to 4) that show it is
 * outside, e.g. 5.003 against a maximum of 5, instead of a contradictory "5.00".
 */
export function formatStat(value: number, min: number, max: number): string {
  const base = fixed(value);
  if (!Number.isFinite(value) || withinRange(value, min, max)) return base;
  const outside = (s: string): boolean => Number(s) < min || Number(s) > max;
  if (outside(base)) return base;
  for (const places of [3, 4]) {
    const text = value.toFixed(places);
    if (outside(text)) return text;
  }
  return value.toFixed(4);
}

export function meanHint(avg: number, range: Readonly<Range>): string | null {
  if (Number.isNaN(avg) || withinRange(avg, range.meanMin, range.meanMax)) {
    return null;
  }
  const target = `target ${fixed(range.meanMin)}–${fixed(range.meanMax)}`;
  return avg > range.meanMax
    ? `Average is ${formatStat(avg, range.meanMin, range.meanMax)} — lower some scores (${target}).`
    : `Average is ${formatStat(avg, range.meanMin, range.meanMax)} — raise some scores (${target}).`;
}

export function sdHint(sd: number, range: Readonly<Range>): string | null {
  if (Number.isNaN(sd) || withinRange(sd, range.sdMin, range.sdMax)) {
    return null;
  }
  const target = `target SD ${fixed(range.sdMin)}–${fixed(range.sdMax)}`;
  return sd < range.sdMin
    ? `Spread is ${formatStat(sd, range.sdMin, range.sdMax)} — scores are too similar; spread them out (${target}).`
    : `Spread is ${formatStat(sd, range.sdMin, range.sdMax)} — scores are too far apart; bring them closer (${target}).`;
}

/** Plain-English advice, average first. Empty when both are within range. */
export function adjustmentHint(
  stats: { mean: number; sd: number },
  range: Readonly<Range>,
): string[] {
  return [meanHint(stats.mean, range), sdHint(stats.sd, range)].filter(
    (h): h is string => h !== null,
  );
}

/**
 * The hints worth showing as advice: those not already listed as an export
 * blocker with the same text, so no line appears twice in the summary.
 */
export function advisoryHints(
  hints: readonly string[],
  blockerMessages: readonly string[],
): string[] {
  const shown = new Set(blockerMessages);
  return hints.filter((h) => !shown.has(h));
}
