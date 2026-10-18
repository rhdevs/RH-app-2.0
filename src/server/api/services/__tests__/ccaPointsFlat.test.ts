import { describe, expect, it } from "vitest";

import {
  hasWaiver,
  isFlatRow,
  waiverRows,
  type ConfigRowLike,
} from "~/server/api/services/ccaPointsConfig";

const row = (patch: Partial<ConfigRowLike> = {}): ConfigRowLike => ({
  meanMin: null,
  meanMax: null,
  sdMin: null,
  sdMax: null,
  note: null,
  flatPoints: null,
  ...patch,
});

describe("one per-CCA row can be a waiver, a flat marking, or both", () => {
  it("is flat only when flatPoints is a number (0 counts)", () => {
    expect(isFlatRow(row({ flatPoints: 10 }))).toBe(true);
    expect(isFlatRow(row({ flatPoints: 0 }))).toBe(true);
    expect(isFlatRow(row())).toBe(false);
    expect(isFlatRow(null)).toBe(false);
  });

  it("is a waiver when a range field or a note is set", () => {
    expect(hasWaiver(row({ meanMax: 15 }))).toBe(true);
    expect(hasWaiver(row({ note: "performing group" }))).toBe(true);
    expect(hasWaiver(row({ flatPoints: 10 }))).toBe(false);
    expect(hasWaiver(row())).toBe(false);
    expect(hasWaiver(null)).toBe(false);
  });

  it("lists only real waivers, not rows that exist just to mark a CCA flat", () => {
    const rows = [
      row({ meanMin: 8, note: "w" }),
      row({ flatPoints: 10 }),
      row({ meanMin: 9, note: "both", flatPoints: 5 }),
    ];
    expect(waiverRows(rows)).toEqual([rows[0], rows[2]]);
  });
});
