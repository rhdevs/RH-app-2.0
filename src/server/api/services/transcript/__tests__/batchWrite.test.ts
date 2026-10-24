import { describe, expect, it, vi } from "vitest";
import { ID_CHUNK, chunks, groupBy, updateGrouped } from "../batchWrite";

describe("chunks", () => {
  it("slices in order, the last slice holding the rest", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
  });
});

describe("groupBy", () => {
  it("keeps groups and items in first-seen order", () => {
    expect(groupBy(["a1", "b1", "a2", "c1", "b2"], (s) => s[0]!)).toEqual([
      ["a1", "a2"],
      ["b1", "b2"],
      ["c1"],
    ]);
  });
});

describe("updateGrouped", () => {
  it("writes once per distinct value and id slice, never once per row", async () => {
    const rows = Array.from({ length: 2 * ID_CHUNK + 2 }, (_, i) => ({
      id: `r${i}`,
      hours: i % 2 === 0 ? 1.5 : null,
    }));
    const write = vi.fn((_ids: string[], _hours: number | null) =>
      Promise.resolve(),
    );

    await updateGrouped(rows, (r) => r.hours, write);

    // Two values of ID_CHUNK + 1 rows each: two slices per value.
    expect(write).toHaveBeenCalledTimes(4);
    const written = write.mock.calls.flatMap(([ids, hours]) =>
      ids.map((id) => [id, hours] as const),
    );
    expect(written).toHaveLength(rows.length);
    expect(new Map(written)).toEqual(new Map(rows.map((r) => [r.id, r.hours])));
    for (const [ids] of write.mock.calls) {
      expect(ids.length).toBeLessThanOrEqual(ID_CHUNK);
    }
  });

  it("does nothing for no rows", async () => {
    const write = vi.fn();
    await updateGrouped([], () => 1, write);
    expect(write).not.toHaveBeenCalled();
  });
});
