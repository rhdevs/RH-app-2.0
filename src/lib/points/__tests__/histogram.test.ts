import { describe, expect, it } from "vitest";

import type { PointsEntry } from "~/lib/points/entries";
import { scoreHistogram } from "~/lib/points/histogram";

const entry = (basePoints: number | null): PointsEntry => ({
  rowKey: `u:${String(basePoints)}`,
  matric: "A9900001Z",
  name: "Test Member",
  resolved: true,
  basePoints,
  semesterOnly: false,
  outgoingRole: "none",
  incomingRole: "none",
  ihg: false,
});

describe("scoreHistogram", () => {
  it("has 21 buckets, one per score 0-20", () => {
    expect(scoreHistogram([])).toEqual(new Array(21).fill(0));
  });

  it("counts each valid score", () => {
    const counts = scoreHistogram([0, 20, 12, 12, 7].map(entry));
    expect(counts[0]).toBe(1);
    expect(counts[20]).toBe(1);
    expect(counts[12]).toBe(2);
    expect(counts[7]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("ignores blank, out-of-range and non-whole scores", () => {
    const counts = scoreHistogram([null, 21, -1, 7.5, Number.NaN].map(entry));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
