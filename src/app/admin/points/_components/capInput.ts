import {
  IHG_CAP_MAX,
  IHG_CAP_MIN,
  isValidIhgCap,
} from "~/lib/points/constants";

/** The text in an IHG cap box → a valid cap, or null when it isn't one. */
export function parseCap(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return isValidIhgCap(n) ? n : null;
}

export type CapCommit =
  | { kind: "noop" }
  | { kind: "invalid" }
  | { kind: "save"; cap: number | null };

/**
 * What leaving the cap box should do. Compares the PARSED number with the
 * stored cap, so "007" over 7 sends nothing. A blank box clears the cap.
 */
export function decideCapCommit(
  text: string,
  stored: number | null,
): CapCommit {
  if (text.trim() === "") {
    return stored === null ? { kind: "noop" } : { kind: "save", cap: null };
  }
  const cap = parseCap(text);
  if (cap === null) return { kind: "invalid" };
  return cap === stored ? { kind: "noop" } : { kind: "save", cap };
}

export const CAP_ERROR = `Whole number ${IHG_CAP_MIN}–${IHG_CAP_MAX}`;
