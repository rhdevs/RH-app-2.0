import { describe, expect, it } from "vitest";

import {
  manualProblem,
  mergeManualMemberships,
  resolveManual,
  shadowedManualCcas,
  type ManualMembershipRow,
} from "../manualMembership";

const row = (over: Partial<ManualMembershipRow> = {}): ManualMembershipRow => ({
  ccaID: 5,
  duration: null,
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
  ...over,
});

const rosterEntry = (ccaID: number, roleLabel: string | null = null) => ({
  ccaID,
  duration: "full" as const,
  roleLabel,
  roleDuration: null,
  extraContribution: null,
});

describe("resolveManual", () => {
  it("reads a bare entry as a full-year member with no role", () => {
    expect(resolveManual(row())).toEqual({
      ccaID: 5,
      duration: "full",
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
  });

  it("keeps the semester, trims text and drops blank text", () => {
    expect(
      resolveManual(
        row({
          duration: "sem2",
          roleLabel: "  Captain ",
          roleDuration: "sem2",
          extraContribution: "  ",
        }),
      ),
    ).toEqual({
      ccaID: 5,
      duration: "sem2",
      roleLabel: "Captain",
      roleDuration: "sem2",
      extraContribution: null,
    });
  });

  it("fits a role period that sticks out into the membership, and has none without a role", () => {
    expect(
      resolveManual(
        row({ duration: "sem1", roleLabel: "Head", roleDuration: "sem2" }),
      ).roleDuration,
    ).toBe("sem1");
    expect(
      resolveManual(row({ roleDuration: "sem1" })).roleDuration,
    ).toBeNull();
  });

  it("ignores a duration it does not know", () => {
    expect(resolveManual(row({ duration: "forever" })).duration).toBe("full");
  });
});

describe("mergeManualMemberships (roster wins)", () => {
  it("adds a manual entry for a CCA the roster does not cover", () => {
    const merged = mergeManualMemberships(
      [rosterEntry(1)],
      [row({ ccaID: 5 })],
    );
    expect(merged.map((m) => m.ccaID)).toEqual([1, 5]);
  });

  it("ignores a manual entry when the roster already has that CCA", () => {
    const merged = mergeManualMemberships(
      [rosterEntry(5, "Head")],
      [row({ ccaID: 5, roleLabel: "Captain" })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.roleLabel).toBe("Head");
  });

  it("counts a CCA once however many manual rows name it", () => {
    const merged = mergeManualMemberships([], [row(), row({ roleLabel: "X" })]);
    expect(merged).toHaveLength(1);
  });

  it("changes nothing when there are no manual entries", () => {
    expect(mergeManualMemberships([rosterEntry(1)], [])).toEqual([
      rosterEntry(1),
    ]);
  });

  it("names the manual entries a roster entry shadows", () => {
    expect(shadowedManualCcas([1, 5], [{ ccaID: 5 }, { ccaID: 9 }])).toEqual(
      new Set([5]),
    );
  });
});

describe("manualProblem (role period inside membership period)", () => {
  it("accepts any role period in a full-year membership", () => {
    for (const roleDuration of ["full", "sem1", "sem2"] as const) {
      expect(manualProblem({ duration: null, roleDuration })).toBeNull();
      expect(manualProblem({ duration: "full", roleDuration })).toBeNull();
    }
  });

  it("refuses a role period outside a part-year membership", () => {
    expect(manualProblem({ duration: "sem2", roleDuration: "sem1" })).toBe(
      "ROLE_PERIOD_OUTSIDE_MEMBERSHIP",
    );
    expect(manualProblem({ duration: "sem2", roleDuration: "full" })).toBe(
      "ROLE_PERIOD_OUTSIDE_MEMBERSHIP",
    );
    expect(manualProblem({ duration: "sem1", roleDuration: "sem2" })).toBe(
      "ROLE_PERIOD_OUTSIDE_MEMBERSHIP",
    );
  });

  it("accepts the same semester, and no role period at all", () => {
    expect(
      manualProblem({ duration: "sem2", roleDuration: "sem2" }),
    ).toBeNull();
    expect(manualProblem({ duration: "sem2", roleDuration: null })).toBeNull();
  });
});
