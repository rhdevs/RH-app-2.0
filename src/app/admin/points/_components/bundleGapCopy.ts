import type { BundleCca } from "~/lib/points/bundleCsv";

const MAX_NAMES = 5;

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

/** "A, B, C, D, E … and 2 more": up to five names, then the rest as a count. */
export function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length - MAX_NAMES;
  return rest > 0 ? `${shown} … and ${rest} more` : shown;
}

/**
 * The amber lines on the confirm dialog: the CCAs with no type yet and the sports
 * with no IHG result or cap yet. Empty when nothing is missing.
 */
export function bundleGapLines(
  ccas: readonly BundleCca[],
  gaps: { type: readonly number[]; ihg: readonly number[] },
): string[] {
  const nameById = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
  const names = (ids: readonly number[]): string[] =>
    ids.map((id) => nameById.get(id) ?? `CCA ${id}`);
  const lines: string[] = [];
  if (gaps.type.length > 0) {
    const n = gaps.type.length;
    lines.push(
      `${n} ${plural(n, "CCA has", "CCAs have")} no type yet: ${nameList(names(gaps.type))}.`,
    );
  }
  if (gaps.ihg.length > 0) {
    const n = gaps.ihg.length;
    lines.push(
      `${n} ${plural(n, "sport has", "sports have")} no IHG result or cap yet: ${nameList(names(gaps.ihg))}.`,
    );
  }
  return lines;
}
