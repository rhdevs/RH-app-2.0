import { describe, expect, it } from "vitest";

import {
  ccaIDFilter,
  inScope,
  scopeFromPositions,
} from "~/server/api/services/jcrcPositions";

describe("scopeFromPositions: positions set the default view only", () => {
  it("shows every CCA to a member who holds no position", () => {
    expect(scopeFromPositions([])).toBe("all");
  });

  it("shows every CCA when any held position oversees all", () => {
    expect(
      scopeFromPositions([
        { overseesAll: false, ccaIDs: [3] },
        { overseesAll: true, ccaIDs: [] },
      ]),
    ).toBe("all");
  });

  it("unions, de-duplicates and sorts the CCAs of every held position", () => {
    expect(
      scopeFromPositions([
        { overseesAll: false, ccaIDs: [9, 2] },
        { overseesAll: false, ccaIDs: [2, 5] },
      ]),
    ).toEqual([2, 5, 9]);
  });

  it("gives an empty scope for a position with no CCAs yet", () => {
    expect(scopeFromPositions([{ overseesAll: false, ccaIDs: [] }])).toEqual(
      [],
    );
  });
});

describe("inScope and ccaIDFilter", () => {
  it("treats 'all' as containing every CCA and adds no filter", () => {
    expect(inScope("all", 42)).toBe(true);
    expect(ccaIDFilter("all")).toBeUndefined();
  });

  it("limits to the listed CCAs otherwise", () => {
    expect(inScope([1, 2], 2)).toBe(true);
    expect(inScope([1, 2], 3)).toBe(false);
    expect(ccaIDFilter([1, 2])).toEqual({ ccaID: { in: [1, 2] } });
  });
});
