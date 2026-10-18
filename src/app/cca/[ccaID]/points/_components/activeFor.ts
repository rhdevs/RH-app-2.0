/**
 * "Active for" is how a leader sees `semesterOnly`: Full year (false, the
 * default) or 1 sem (true). Only the wording changes — the stored field, the
 * draft and the CSV column (semesterOnly Y/N) stay exactly as they were.
 */
export type ActiveFor = "full_year" | "one_sem";

export const ACTIVE_FOR_OPTIONS: readonly {
  value: ActiveFor;
  label: string;
}[] = [
  { value: "full_year", label: "Full year" },
  { value: "one_sem", label: "1 sem" },
];

export const ACTIVE_FOR_HELP =
  "Choose '1 sem' if this member was only active for one semester. Score them as usual — their full score counts in your CCA's average/spread check, and JCRC halves it later.";

export const activeForOf = (semesterOnly: boolean): ActiveFor =>
  semesterOnly ? "one_sem" : "full_year";

/** Anything other than "one_sem" is the default, Full year. */
export const semesterOnlyOf = (value: string): boolean => value === "one_sem";

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/**
 * Radiogroup keyboard: with two options every arrow key moves to the other one
 * (and selects it). Any other key is not ours, so null.
 */
export function activeForAfterKey(
  current: ActiveFor,
  key: string,
): ActiveFor | null {
  if (!ARROWS.has(key)) return null;
  return current === "full_year" ? "one_sem" : "full_year";
}
