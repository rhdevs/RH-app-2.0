import { describe, expect, it } from "vitest";
import { clampRoleDuration, resolveEntry, roleFits } from "../duration";
import {
  draftOf,
  effectiveMembership,
  fitRolePeriod,
  roleDurationOptions,
  type RowDraft,
} from "../headView";

const SEM2_START = new Date("2027-01-10T16:00:00Z");
const blank: RowDraft = draftOf({
  duration: null,
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
});

describe("a role period fits inside the membership period", () => {
  it("lets a full-year member hold a role for any period", () => {
    for (const role of ["full", "sem1", "sem2"] as const) {
      expect(roleFits("full", role)).toBe(true);
    }
  });

  it("lets a semester member hold a role only for that semester", () => {
    expect(roleFits("sem1", "sem1")).toBe(true);
    expect(roleFits("sem1", "sem2")).toBe(false);
    expect(roleFits("sem1", "full")).toBe(false);
    expect(roleFits("sem2", "sem2")).toBe(true);
    expect(roleFits("sem2", "sem1")).toBe(false);
    expect(roleFits("sem2", "full")).toBe(false);
  });

  it("narrows a role period that sticks out, and treats a missing one as the full year", () => {
    expect(clampRoleDuration("sem2", "full")).toBe("sem2");
    expect(clampRoleDuration("sem2", null)).toBe("sem2");
    expect(clampRoleDuration("sem1", "sem2")).toBe("sem1");
    expect(clampRoleDuration("full", "sem1")).toBe("sem1");
    expect(clampRoleDuration("full", null)).toBe("full");
  });
});

describe("resolveEntry keeps the role inside the membership", () => {
  const live = (over: object = {}) => ({
    decidedAt: null,
    isHead: true,
    grantedAt: null,
    ...over,
  });

  it("never gives a semester 2 member a full-year head role", () => {
    const r = resolveEntry(
      { duration: "sem2", roleDuration: "full" },
      live(),
      SEM2_START,
    );

    expect(r).toMatchObject({
      duration: "sem2",
      roleLabel: "Head",
      roleDuration: "sem2",
    });
  });

  it("clamps the default role period for a member who joined in semester 2", () => {
    const r = resolveEntry(
      null,
      live({ decidedAt: new Date("2027-02-01T00:00:00Z") }),
      SEM2_START,
    );

    expect(r.duration).toBe("sem2");
    expect(r.roleDuration).toBe("sem2");
  });

  it("clamps a typed role with no stored period, and gives no period without a role", () => {
    const plain = live({ isHead: false });

    expect(
      resolveEntry(
        { duration: "sem1", roleLabel: "Treasurer" },
        plain,
        SEM2_START,
      ).roleDuration,
    ).toBe("sem1");
    expect(
      resolveEntry({ duration: "sem1" }, plain, SEM2_START).roleDuration,
    ).toBeNull();
  });

  it("leaves a role inside a full-year membership alone", () => {
    const r = resolveEntry(
      { duration: "full", roleDuration: "sem2" },
      live(),
      SEM2_START,
    );

    expect(r.roleDuration).toBe("sem2");
  });
});

describe("role period options", () => {
  it("offers everything for a full-year member, with the default in the first label", () => {
    expect(roleDurationOptions("full", "sem2").map((o) => o.label)).toEqual([
      "Default (Semester 2 only)",
      "Full year",
      "Semester 1 only",
      "Semester 2 only",
    ]);
  });

  it("offers only the default and the one semester for a semester 1 member", () => {
    const options = roleDurationOptions("sem1", "full");

    expect(options.map((o) => o.label)).toEqual([
      "Default (Semester 1 only)",
      "Semester 1 only",
    ]);
    expect(options.map((o) => o.value)).toEqual(["", "sem1"]);
  });

  it("offers only the semester 2 equivalents for a semester 2 member", () => {
    expect(roleDurationOptions("sem2", null).map((o) => o.label)).toEqual([
      "Default (Semester 2 only)",
      "Semester 2 only",
    ]);
  });
});

describe("narrowing a membership", () => {
  it("takes the effective membership from the choice, else the default", () => {
    expect(effectiveMembership("", "sem2")).toBe("sem2");
    expect(effectiveMembership("sem1", "sem2")).toBe("sem1");
    expect(effectiveMembership("", null)).toBe("full");
  });

  it("changes a role period that no longer fits, and says so in one line", () => {
    const draft: RowDraft = {
      ...blank,
      duration: "sem2",
      roleLabel: "Treasurer",
      roleDuration: "full",
    };

    const result = fitRolePeriod(draft, "full");

    expect(result.draft.roleDuration).toBe("sem2");
    expect(result.note).toBe(
      "Role period changed to Semester 2 only to match membership.",
    );
  });

  it("changes a role period set to the other semester", () => {
    const result = fitRolePeriod(
      { ...blank, duration: "sem1", roleDuration: "sem2" },
      "full",
    );

    expect(result.draft.roleDuration).toBe("sem1");
    expect(result.note).toBe(
      "Role period changed to Semester 1 only to match membership.",
    );
  });

  it("leaves a role period that still fits, and the default, alone", () => {
    const fits: RowDraft = { ...blank, duration: "sem2", roleDuration: "sem2" };
    const byDefault: RowDraft = { ...blank, duration: "sem1" };
    const fullYear: RowDraft = {
      ...blank,
      duration: "full",
      roleDuration: "sem1",
    };

    expect(fitRolePeriod(fits, "full")).toEqual({ draft: fits, note: null });
    expect(fitRolePeriod(byDefault, "full")).toEqual({
      draft: byDefault,
      note: null,
    });
    expect(fitRolePeriod(fullYear, "full")).toEqual({
      draft: fullYear,
      note: null,
    });
  });
});
