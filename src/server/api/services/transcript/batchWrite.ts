/**
 * Helpers for saves that change many rows in one transaction (T9): rows that
 * get the same new values are written together with one updateMany, in id
 * lists of at most ID_CHUNK, instead of one write per row. A long save then
 * takes a few round trips, not thousands, and so spends far less time open to
 * a write conflict on the year's period row.
 */

/** The most ids put in one `{ id: { in } }` filter. */
export const ID_CHUNK = 1_000;

/** `items` in consecutive slices of at most `size`. */
export function chunks<T>(items: readonly T[], size: number = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** `items` grouped by `keyOf`, groups and items in first-seen order. */
export function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

/**
 * Run `write` once per slice of the ids of `items` that share the values
 * `valuesOf` gives them: one updateMany per (values, slice), never one per row.
 */
export async function updateGrouped<T extends { id: string }, V>(
  items: readonly T[],
  valuesOf: (item: T) => V,
  write: (ids: string[], values: V) => Promise<unknown>,
): Promise<void> {
  for (const group of groupBy(items, (i) => JSON.stringify(valuesOf(i)))) {
    const values = valuesOf(group[0]!);
    for (const slice of chunks(group)) {
      await write(
        slice.map((i) => i.id),
        values,
      );
    }
  }
}
