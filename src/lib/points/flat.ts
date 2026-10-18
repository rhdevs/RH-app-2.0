/**
 * FLAT-POINTS CCAs: JCRC marks a CCA as flat and sets one value. Every member
 * receives that value as the whole CCA's points (the sandbox applies the maths;
 * the app only stores and exports it). Leaders of a flat CCA do nothing.
 */

export const FLAT_POINTS_MIN = 0;
export const FLAT_POINTS_MAX = 50;
const MAX_DECIMALS = 2;

const hasAtMostTwoDecimals = (n: number): boolean =>
  Math.abs(n * 10 ** MAX_DECIMALS - Math.round(n * 10 ** MAX_DECIMALS)) < 1e-9;

/** Why this is not a usable flat value, or null when it is fine. */
export function flatPointsProblem(n: number): string | null {
  if (!Number.isFinite(n)) return "Enter a number, e.g. 10 or 7.5.";
  if (n < FLAT_POINTS_MIN || n > FLAT_POINTS_MAX) {
    return `Points must be between ${FLAT_POINTS_MIN} and ${FLAT_POINTS_MAX}.`;
  }
  if (!hasAtMostTwoDecimals(n)) {
    return `Use at most ${MAX_DECIMALS} decimal places.`;
  }
  return null;
}

export const isValidFlatPoints = (n: number): boolean =>
  flatPointsProblem(n) === null;

const NUMBER_TEXT = /^\d+(\.\d+)?$/;

export type FlatTextResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

/** The "points each" box: plain numbers only, then the same range and decimal rules. */
export function parseFlatPointsText(text: string): FlatTextResult {
  const trimmed = text.trim();
  if (!NUMBER_TEXT.test(trimmed)) {
    return { ok: false, message: "Enter a number, e.g. 10 or 7.5." };
  }
  const value = Number(trimmed);
  const problem = flatPointsProblem(value);
  return problem ? { ok: false, message: problem } : { ok: true, value };
}

/** 12 → "12", 7.5 → "7.5": plain numbers, no trailing zeros. */
export const formatFlatPoints = (n: number): string =>
  String(Number(n.toFixed(MAX_DECIMALS)));

/** What a leader of a flat CCA sees instead of the entry page, or null for a normal CCA. */
export function flatNotice(flatPoints: number | null): string | null {
  if (flatPoints === null) return null;
  return `This CCA uses flat points set by JCRC: every member receives ${formatFlatPoints(flatPoints)} points for this CCA. No action needed.`;
}
