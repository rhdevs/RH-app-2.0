import { describe, expect, it } from "vitest";

import type { PointsEntry } from "~/lib/points/entries";
import {
  applyEntryPatch,
  parseScoreText,
} from "../_components/usePointsEntries";

describe("parseScoreText", () => {
  it.each([
    ["", null],
    ["  ", null],
    ["7", 7],
    [" 7 ", 7],
    ["07", 7],
    ["20", 20],
  ])("reads %j as %j", (text, expected) => {
    expect(parseScoreText(text)).toBe(expected);
  });

  it.each([["7.0"], ["-1"], ["1e1"], ["\uFF12"], ["abc"], ["7a"], ["+3"]])(
    "reads %j as not a number (NaN)",
    (text) => {
      expect(Number.isNaN(parseScoreText(text))).toBe(true);
    },
  );
});

const entry = (n: number, basePoints: number | null): PointsEntry => ({
  rowKey: `u:${n}`,
  matric: `A99${String(n).padStart(5, "0")}Z`,
  name: `Test Member ${n}`,
  resolved: true,
  basePoints,
  semesterOnly: false,
  outgoingRole: "none",
  incomingRole: "none",
  ihg: false,
});

describe("applyEntryPatch (the edit gate)", () => {
  const entries = [entry(1, 5), entry(2, null)];

  it("changes only the named row while entry is open", () => {
    const next = applyEntryPatch(entries, true, "u:2", { basePoints: 9 });
    expect(next).not.toBe(entries);
    expect(next.map((e) => e.basePoints)).toEqual([5, 9]);
    expect(entries.map((e) => e.basePoints)).toEqual([5, null]);
  });

  it("returns the very same list, untouched, while entry is closed", () => {
    const next = applyEntryPatch(entries, false, "u:2", { basePoints: 9 });
    expect(next).toBe(entries);
    expect(entries.map((e) => e.basePoints)).toEqual([5, null]);
  });
});
