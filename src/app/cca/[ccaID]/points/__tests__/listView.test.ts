import { describe, expect, it } from "vitest";

import type { PointsEntry } from "~/lib/points/entries";
import {
  DEFAULT_VIEW,
  heldVisibleEntries,
  visibleEntries,
  type ListView,
} from "../_components/listView";

const entry = (
  n: number,
  basePoints: number | null,
  name = `Test Member ${n}`,
): PointsEntry => ({
  rowKey: `u:${n}`,
  matric: `A99${String(n).padStart(5, "0")}Z`,
  name,
  resolved: true,
  basePoints,
  semesterOnly: false,
  outgoingRole: "none",
  incomingRole: "none",
  ihg: false,
});

const keys = (rows: readonly PointsEntry[]): string[] =>
  rows.map((r) => r.rowKey);

const UNSCORED: ListView = { ...DEFAULT_VIEW, unscoredOnly: true };
const BY_SCORE: ListView = { ...DEFAULT_VIEW, sort: "score" };

describe("heldVisibleEntries", () => {
  it("behaves like visibleEntries when nothing is held", () => {
    const entries = [entry(1, 5), entry(2, null), entry(3, 9)];
    expect(heldVisibleEntries(entries, UNSCORED, null, [])).toEqual(
      visibleEntries(entries, UNSCORED),
    );
    expect(keys(heldVisibleEntries(entries, BY_SCORE, null, []))).toEqual([
      "u:3",
      "u:1",
      "u:2",
    ]);
  });

  it("keeps a held row visible under unscoredOnly while '1' then '5' is typed", () => {
    const before = [entry(1, null), entry(2, null), entry(3, null)];
    const order = keys(visibleEntries(before, UNSCORED));

    const afterOne = [entry(1, 1), entry(2, null), entry(3, null)];
    expect(keys(heldVisibleEntries(afterOne, UNSCORED, "u:1", order))).toEqual([
      "u:1",
      "u:2",
      "u:3",
    ]);

    const afterFifteen = [entry(1, 15), entry(2, null), entry(3, null)];
    expect(
      keys(heldVisibleEntries(afterFifteen, UNSCORED, "u:1", order)),
    ).toEqual(["u:1", "u:2", "u:3"]);
  });

  it("drops the row once the leader moves on", () => {
    const entries = [entry(1, 15), entry(2, null), entry(3, null)];
    const order = ["u:1", "u:2", "u:3"];
    expect(keys(heldVisibleEntries(entries, UNSCORED, "u:1", order))).toEqual([
      "u:1",
      "u:2",
      "u:3",
    ]);
    // Focus moved to row 2: row 1 is no longer held and the filter applies again.
    expect(keys(heldVisibleEntries(entries, UNSCORED, "u:2", order))).toEqual([
      "u:2",
      "u:3",
    ]);
    expect(keys(heldVisibleEntries(entries, UNSCORED, null, order))).toEqual([
      "u:2",
      "u:3",
    ]);
  });

  it("applies the filter to every row but the held one", () => {
    const entries = [entry(1, 15), entry(2, 3), entry(3, null)];
    // Row 2 is held and scored, row 1 is scored and not held, row 3 is unscored.
    const out = heldVisibleEntries(entries, UNSCORED, "u:2", [
      "u:1",
      "u:2",
      "u:3",
    ]);
    expect(keys(out)).toEqual(["u:2", "u:3"]);
    expect(keys(heldVisibleEntries(entries, UNSCORED, null, []))).toEqual([
      "u:3",
    ]);
  });

  it("keeps the score-sort order while held and re-sorts after moving on", () => {
    const before = [entry(1, 10), entry(2, 5), entry(3, null)];
    const order = keys(visibleEntries(before, BY_SCORE)); // 1, 2, 3
    expect(order).toEqual(["u:1", "u:2", "u:3"]);

    // Row 2 is being edited and now outscores row 1.
    const after = [entry(1, 10), entry(2, 20), entry(3, null)];
    expect(keys(heldVisibleEntries(after, BY_SCORE, "u:2", order))).toEqual([
      "u:1",
      "u:2",
      "u:3",
    ]);
    expect(keys(heldVisibleEntries(after, BY_SCORE, null, order))).toEqual([
      "u:2",
      "u:1",
      "u:3",
    ]);
  });

  it("applies a changed search immediately, even to the held row", () => {
    const entries = [
      entry(1, null, "Alice Tan"),
      entry(2, null, "Bob Lim"),
      entry(3, null, "Alicia Wong"),
    ];
    const order = ["u:1", "u:2", "u:3"];
    const view: ListView = { ...UNSCORED, search: "ali" };
    expect(keys(heldVisibleEntries(entries, view, "u:2", order))).toEqual([
      "u:1",
      "u:3",
    ]);
    expect(keys(heldVisibleEntries(entries, view, "u:1", order))).toEqual([
      "u:1",
      "u:3",
    ]);
  });

  it("applies a changed filter immediately when the stored order is cleared", () => {
    const entries = [entry(1, 4), entry(2, null), entry(3, 9)];
    // A filter/sort change clears the stored order, so the fresh sort is used.
    expect(keys(heldVisibleEntries(entries, BY_SCORE, "u:1", []))).toEqual([
      "u:3",
      "u:1",
      "u:2",
    ]);
    expect(keys(heldVisibleEntries(entries, DEFAULT_VIEW, null, []))).toEqual([
      "u:1",
      "u:2",
      "u:3",
    ]);
  });

  it("places a member the old order has never seen after the known ones", () => {
    const entries = [entry(1, null), entry(2, null), entry(3, null)];
    expect(
      keys(heldVisibleEntries(entries, DEFAULT_VIEW, "u:1", ["u:3", "u:1"])),
    ).toEqual(["u:3", "u:1", "u:2"]);
  });

  it("does not mutate its inputs", () => {
    const entries = Object.freeze([
      Object.freeze(entry(1, 15)),
      Object.freeze(entry(2, null)),
    ]) as readonly PointsEntry[];
    const order = Object.freeze(["u:2", "u:1"]) as readonly string[];
    const view = Object.freeze({ ...UNSCORED });
    expect(() => heldVisibleEntries(entries, view, "u:1", order)).not.toThrow();
    expect(keys(entries)).toEqual(["u:1", "u:2"]);
    expect(order).toEqual(["u:2", "u:1"]);
  });
});
