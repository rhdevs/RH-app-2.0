import { isValidScore, type PointsEntry } from "~/lib/points/entries";

export type SortKey = "name" | "score";

export type ListView = {
  search: string;
  unscoredOnly: boolean;
  sort: SortKey;
};

export const DEFAULT_VIEW: ListView = {
  search: "",
  unscoredOnly: false,
  sort: "name",
};

const scored = (e: PointsEntry): boolean =>
  e.basePoints !== null && isValidScore(e.basePoints);

const byName = (a: PointsEntry, b: PointsEntry): number =>
  (a.name ?? "").localeCompare(b.name ?? "", "en", { sensitivity: "base" });

/** Highest score first; unscored and invalid entries last, then by name. */
const byScore = (a: PointsEntry, b: PointsEntry): number => {
  const sa = scored(a) ? (a.basePoints ?? 0) : -1;
  const sb = scored(b) ? (b.basePoints ?? 0) : -1;
  return sb - sa || byName(a, b);
};

const matchesSearch = (e: PointsEntry, q: string): boolean =>
  q === "" ||
  (e.name ?? "").toLowerCase().includes(q) ||
  (e.matric ?? "").toLowerCase().includes(q);

/** The rows to show, in display order. Filtering never changes the data. */
export function visibleEntries(
  entries: readonly PointsEntry[],
  view: ListView,
): PointsEntry[] {
  const q = view.search.trim().toLowerCase();
  return entries
    .filter((e) => matchesSearch(e, q))
    .filter((e) => !view.unscoredOnly || !scored(e))
    .sort(view.sort === "name" ? byName : byScore);
}

/**
 * `visibleEntries`, except that the row being edited is HELD: it stays visible
 * even if typing has made it fall outside "Unscored only", and rows keep the order
 * they had (`previousOrder`) instead of re-sorting on every keystroke. The search
 * still applies to the held row, and an empty `previousOrder` (the caller clears it
 * when the filter, sort or search changes) means a fresh sort. With nothing held
 * this is exactly `visibleEntries`, which is how the filter and sort re-apply once
 * the leader moves on.
 */
export function heldVisibleEntries(
  entries: readonly PointsEntry[],
  view: ListView,
  heldKey: string | null,
  previousOrder: readonly string[],
): PointsEntry[] {
  if (heldKey === null) return visibleEntries(entries, view);
  const q = view.search.trim().toLowerCase();
  const fresh = entries
    .filter((e) => matchesSearch(e, q))
    .filter((e) => e.rowKey === heldKey || !view.unscoredOnly || !scored(e))
    .sort(view.sort === "name" ? byName : byScore);
  if (previousOrder.length === 0) return fresh;
  const position = new Map(previousOrder.map((key, i) => [key, i]));
  const known = fresh
    .filter((e) => position.has(e.rowKey))
    .sort(
      (a, b) => (position.get(a.rowKey) ?? 0) - (position.get(b.rowKey) ?? 0),
    );
  return [...known, ...fresh.filter((e) => !position.has(e.rowKey))];
}
