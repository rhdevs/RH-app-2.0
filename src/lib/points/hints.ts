import type { Range } from "~/lib/points/constants";
import { withinRange } from "~/lib/points/meanSd";

/** Two decimal places everywhere a leader sees a statistic. */
const fixed = (n: number): string => n.toFixed(2);

export function meanHint(avg: number, range: Readonly<Range>): string | null {
  if (Number.isNaN(avg) || withinRange(avg, range.meanMin, range.meanMax)) {
    return null;
  }
  const target = `target ${fixed(range.meanMin)}–${fixed(range.meanMax)}`;
  return avg > range.meanMax
    ? `Average is ${fixed(avg)} — lower some scores (${target}).`
    : `Average is ${fixed(avg)} — raise some scores (${target}).`;
}

export function sdHint(sd: number, range: Readonly<Range>): string | null {
  if (Number.isNaN(sd) || withinRange(sd, range.sdMin, range.sdMax)) {
    return null;
  }
  const target = `target SD ${fixed(range.sdMin)}–${fixed(range.sdMax)}`;
  return sd < range.sdMin
    ? `Spread is ${fixed(sd)} — scores are too similar; spread them out (${target}).`
    : `Spread is ${fixed(sd)} — scores are too far apart; bring them closer (${target}).`;
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
