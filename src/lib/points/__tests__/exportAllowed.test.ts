import { describe, expect, it } from "vitest";

import { exportAllowedNow, type PointsEntry } from "~/lib/points/entries";

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

// Scores 10, 12, 14, 16: mean 13, population SD sqrt(5) ≈ 2.236.
const entries = [entry(1, 10), entry(2, 12), entry(3, 14), entry(4, 16)];
const range = { meanMin: 12, meanMax: 14, sdMin: 2, sdMax: 3 };

describe("exportAllowedNow", () => {
  it("allows an export when entry is open and the scores pass the fresh range", () => {
    expect(
      exportAllowedNow(entries, { entryOpen: true, range, ihg: null }),
    ).toEqual({
      allowed: true,
      blockers: [],
    });
  });

  it("blocks when JCRC has closed entry since the page loaded", () => {
    const result = exportAllowedNow(entries, {
      entryOpen: false,
      range,
      ihg: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(["NOT_OPEN"]);
  });

  it("blocks when the range changed and the mean no longer passes", () => {
    const result = exportAllowedNow(entries, {
      entryOpen: true,
      ihg: null,
      range: { ...range, meanMin: 14, meanMax: 15 },
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(["MEAN_OUT_OF_RANGE"]);
  });

  it("blocks when the range changed and the spread no longer passes", () => {
    const result = exportAllowedNow(entries, {
      entryOpen: true,
      ihg: null,
      range: { ...range, sdMin: 0, sdMax: 1 },
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(["SD_OUT_OF_RANGE"]);
  });

  it("still allows when the range widened", () => {
    const result = exportAllowedNow(entries, {
      entryOpen: true,
      ihg: null,
      range: { meanMin: 0, meanMax: 20, sdMin: 0, sdMax: 10 },
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks when JCRC has lowered the IHG cap below the ticks", () => {
    const ticked = entries.map((e) => ({ ...e, ihg: true }));
    const result = exportAllowedNow(ticked, {
      entryOpen: true,
      range,
      ihg: { result: "2nd", cap: 3 },
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers.map((b) => b.code)).toEqual(["IHG_OVER_CAP"]);
  });

  it("does not mutate the entries", () => {
    const frozen = Object.freeze(entries.map((e) => Object.freeze({ ...e })));
    expect(() =>
      exportAllowedNow(frozen, { entryOpen: false, range, ihg: null }),
    ).not.toThrow();
  });
});
