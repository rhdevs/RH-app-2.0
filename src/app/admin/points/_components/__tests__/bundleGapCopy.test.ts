import { describe, expect, it } from "vitest";

import type { BundleCca } from "~/lib/points/bundleCsv";
import { bundleGapLines, nameList } from "../bundleGapCopy";

const cca = (ccaID: number, ccaName: string): BundleCca => ({
  ccaID,
  ccaName,
  flatPoints: null,
  type: null,
  isSport: false,
  ihgResult: null,
  ihgCap: null,
});

describe("nameList", () => {
  it("lists up to five names in full", () => {
    expect(nameList(["A", "B", "C", "D", "E"])).toBe("A, B, C, D, E");
  });

  it("truncates after five with a count of the rest", () => {
    expect(nameList(["A", "B", "C", "D", "E", "F", "G"])).toBe(
      "A, B, C, D, E … and 2 more",
    );
  });
});

describe("bundleGapLines", () => {
  const ccas = [cca(1, "Soccer"), cca(2, "Choir"), cca(3, "Drama")];

  it("returns nothing when no gaps exist", () => {
    expect(bundleGapLines(ccas, { type: [], ihg: [] })).toEqual([]);
  });

  it("uses the singular for one gap", () => {
    expect(bundleGapLines(ccas, { type: [2], ihg: [1] })).toEqual([
      "1 CCA has no type yet: Choir.",
      "1 sport has no IHG result or cap yet: Soccer.",
    ]);
  });

  it("uses the plural and names each CCA", () => {
    expect(bundleGapLines(ccas, { type: [1, 3], ihg: [] })).toEqual([
      "2 CCAs have no type yet: Soccer, Drama.",
    ]);
  });

  it("truncates a long type list", () => {
    const many = Array.from({ length: 7 }, (_, i) => cca(i + 1, `C${i + 1}`));
    const [line] = bundleGapLines(many, {
      type: [1, 2, 3, 4, 5, 6, 7],
      ihg: [],
    });
    expect(line).toBe(
      "7 CCAs have no type yet: C1, C2, C3, C4, C5 … and 2 more.",
    );
  });
});
