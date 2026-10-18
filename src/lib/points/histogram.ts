import { SCORE_MAX, SCORE_MIN } from "~/lib/points/constants";
import { isValidScore, type PointsEntry } from "~/lib/points/entries";

/** How many members have each score from 0 to 20. Invalid or blank scores are skipped. */
export function scoreHistogram(entries: readonly PointsEntry[]): number[] {
  const counts = new Array<number>(SCORE_MAX - SCORE_MIN + 1).fill(0);
  for (const e of entries) {
    if (e.basePoints === null || !isValidScore(e.basePoints)) continue;
    const i = e.basePoints - SCORE_MIN;
    counts[i] = (counts[i] ?? 0) + 1;
  }
  return counts;
}
