import { describe, expect, it } from "vitest";

import { DEFAULT_RANGE } from "~/lib/points/constants";
import {
  adjustmentHint,
  advisoryHints,
  formatStat,
  meanHint,
  sdHint,
} from "~/lib/points/hints";

describe("adjustmentHint", () => {
  it("is empty when both are inside the range", () => {
    expect(adjustmentHint({ mean: 12, sd: 3 }, DEFAULT_RANGE)).toEqual([]);
  });

  it("is empty exactly on the edges", () => {
    expect(adjustmentHint({ mean: 14, sd: 2 }, DEFAULT_RANGE)).toEqual([]);
    expect(adjustmentHint({ mean: 10, sd: 5 }, DEFAULT_RANGE)).toEqual([]);
  });

  it("says to lower a high average", () => {
    expect(adjustmentHint({ mean: 15.2, sd: 3 }, DEFAULT_RANGE)).toEqual([
      "Average is 15.20 — lower some scores (target 10.00–14.00).",
    ]);
  });

  it("says to raise a low average", () => {
    expect(adjustmentHint({ mean: 8, sd: 3 }, DEFAULT_RANGE)).toEqual([
      "Average is 8.00 — raise some scores (target 10.00–14.00).",
    ]);
  });

  it("says to spread out scores that are too similar", () => {
    expect(adjustmentHint({ mean: 12, sd: 1.4 }, DEFAULT_RANGE)).toEqual([
      "Spread is 1.40 — scores are too similar; spread them out (target SD 2.00–5.00).",
    ]);
  });

  it("says to bring scores closer when they are too far apart", () => {
    expect(adjustmentHint({ mean: 12, sd: 6.1 }, DEFAULT_RANGE)).toEqual([
      "Spread is 6.10 — scores are too far apart; bring them closer (target SD 2.00–5.00).",
    ]);
  });

  it("gives both hints, average first", () => {
    const hints = adjustmentHint({ mean: 15.2, sd: 6.1 }, DEFAULT_RANGE);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toMatch(/^Average/);
    expect(hints[1]).toMatch(/^Spread/);
  });

  it("uses the range it is given", () => {
    const waived = { meanMin: 14, meanMax: 17, sdMin: 1, sdMax: 3 };
    expect(adjustmentHint({ mean: 15.5, sd: 1.3 }, waived)).toEqual([]);
  });

  it("exposes the two hints separately", () => {
    expect(meanHint(12, DEFAULT_RANGE)).toBeNull();
    expect(sdHint(3, DEFAULT_RANGE)).toBeNull();
    expect(meanHint(15.2, DEFAULT_RANGE)).toMatch(/lower/);
    expect(sdHint(6.1, DEFAULT_RANGE)).toMatch(/closer/);
  });

  it("gives no hints for statistics that are not numbers", () => {
    expect(
      adjustmentHint({ mean: Number.NaN, sd: Number.NaN }, DEFAULT_RANGE),
    ).toEqual([]);
  });
});

describe("advisoryHints", () => {
  const hints = ["Average is too high.", "Spread is too low."];

  it("keeps every hint when nothing blocks the export", () => {
    expect(advisoryHints(hints, [])).toEqual(hints);
  });

  it("drops hints already shown as an export blocker", () => {
    expect(advisoryHints(hints, ["Spread is too low."])).toEqual([
      "Average is too high.",
    ]);
  });

  it("is empty when every hint is a blocker", () => {
    expect(advisoryHints(hints, [...hints, "5 members need a score"])).toEqual(
      [],
    );
  });
});

describe("formatStat", () => {
  it("rounds to 2 dp when the value is inside the range", () => {
    expect(formatStat(12.857, 10, 14)).toBe("12.86");
  });

  it("shows 3 dp for a value just above the maximum that 2 dp would hide", () => {
    expect(formatStat(5.003, 2, 5)).toBe("5.003");
  });

  it("shows 3 dp for a value just below the minimum that 2 dp would hide", () => {
    expect(formatStat(4.996, 5, 8)).toBe("4.996");
  });

  it("uses 2 dp when the rounding already shows the value is outside", () => {
    expect(formatStat(5.2, 2, 5)).toBe("5.20");
    expect(formatStat(1.5, 2, 5)).toBe("1.50");
  });

  it("goes to 4 dp when 3 dp still lands on the boundary", () => {
    expect(formatStat(5.0004, 2, 5)).toBe("5.0004");
  });

  it("shows a value exactly on the boundary as 2 dp", () => {
    expect(formatStat(5, 2, 5)).toBe("5.00");
    expect(formatStat(2, 2, 5)).toBe("2.00");
  });

  it("is used in the hints so the number never contradicts the target", () => {
    expect(sdHint(5.003, { ...DEFAULT_RANGE, sdMin: 2, sdMax: 5 })).toContain(
      "5.003",
    );
  });
});

describe("formatStat tolerance", () => {
  it("shows 2 dp for a value that passes the check only through the tolerance", () => {
    expect(formatStat(5 + 1e-15, 2, 5)).toBe("5.00");
    expect(formatStat(2 - 1e-15, 2, 5)).toBe("2.00");
  });
});
