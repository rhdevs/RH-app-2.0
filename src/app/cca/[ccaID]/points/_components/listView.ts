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

/** The rows to show, in display order. Filtering never changes the data. */
export function visibleEntries(
  entries: readonly PointsEntry[],
  view: ListView,
): PointsEntry[] {
  const q = view.search.trim().toLowerCase();
  return entries
    .filter(
      (e) =>
        q === "" ||
        (e.name ?? "").toLowerCase().includes(q) ||
        (e.matric ?? "").toLowerCase().includes(q),
    )
    .filter((e) => !view.unscoredOnly || !scored(e))
    .sort(view.sort === "name" ? byName : byScore);
}
