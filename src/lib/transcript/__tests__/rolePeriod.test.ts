import { describe, expect, it } from "vitest";
import { clampRoleDuration, resolveEntry, roleFits } from "../duration";
import {
  draftOf,
  effectiveMembership,
  fitRolePeriod,
  roleDurationOptions,
  roleDurationValue,
  type RowDraft,
} from "../headView";

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
  const head = { isHead: true };

  it("never gives a semester 2 member a full-year head role", () => {
    const r = resolveEntry({ duration: "sem2", roleDuration: "full" }, head);

    expect(r).toMatchObject({
      duration: "sem2",
      roleLabel: "Head",
      roleDuration: "sem2",
    });
  });

  it("clamps the default role period for a member set to semester 2", () => {
    const r = resolveEntry({ duration: "sem2" }, head);

    expect(r.duration).toBe("sem2");
    expect(r.roleDuration).toBe("sem2");
  });

  it("clamps a typed role with no stored period, and gives no period without a role", () => {
    const plain = { isHead: false };

    expect(
      resolveEntry({ duration: "sem1", roleLabel: "Treasurer" }, plain)
        .roleDuration,
    ).toBe("sem1");
    expect(resolveEntry({ duration: "sem1" }, plain).roleDuration).toBeNull();
  });

  it("leaves a role inside a full-year membership alone", () => {
    const r = resolveEntry({ duration: "full", roleDuration: "sem2" }, head);

    expect(r.roleDuration).toBe("sem2");
  });
});

describe("role period options", () => {
  it("offers everything for a full-year member, with no Default entry", () => {
    expect(roleDurationOptions("full").map((o) => o.label)).toEqual([
      "Full year",
      "Semester 1 only",
      "Semester 2 only",
    ]);
  });

  it("offers only that semester for a semester 1 member", () => {
    const options = roleDurationOptions("sem1");

    expect(options.map((o) => o.label)).toEqual(["Semester 1 only"]);
    expect(options.map((o) => o.value)).toEqual(["sem1"]);
  });

  it("offers only that semester for a semester 2 member", () => {
    expect(roleDurationOptions("sem2").map((o) => o.label)).toEqual([
      "Semester 2 only",
    ]);
  });

  it("shows the only choice for a semester member, and the draft for a full-year one", () => {
    expect(roleDurationValue("sem2", "")).toBe("sem2");
    expect(roleDurationValue("full", "")).toBe("");
    expect(roleDurationValue("full", "sem1")).toBe("sem1");
  });
});

describe("narrowing a membership", () => {
  it("takes the effective membership from the choice, else a full year", () => {
    expect(effectiveMembership("")).toBe("full");
    expect(effectiveMembership("sem1")).toBe("sem1");
    expect(effectiveMembership("sem2")).toBe("sem2");
  });

  it("changes a role period that no longer fits, and says so in one line", () => {
    const draft: RowDraft = {
      ...blank,
      duration: "sem2",
      roleLabel: "Treasurer",
      roleDuration: "",
    };
    const wider: RowDraft = { ...draft, roleDuration: "sem1" };

    const result = fitRolePeriod(wider);

    expect(result.draft.roleDuration).toBe("sem2");
    expect(result.note).toBe(
      "Role period changed to Semester 2 only to match membership.",
    );
  });

  it("changes a role period set to the other semester", () => {
    const result = fitRolePeriod({
      ...blank,
      duration: "sem1",
      roleDuration: "sem2",
    });

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
      duration: "",
      roleDuration: "sem1",
    };

    expect(fitRolePeriod(fits)).toEqual({ draft: fits, note: null });
    expect(fitRolePeriod(byDefault)).toEqual({
      draft: byDefault,
      note: null,
    });
    expect(fitRolePeriod(fullYear)).toEqual({
      draft: fullYear,
      note: null,
    });
  });

  it("reads a stored 'full' as the default choice", () => {
    expect(
      draftOf({
        duration: "full",
        roleLabel: null,
        roleDuration: "full",
        extraContribution: null,
      }),
    ).toMatchObject({ duration: "", roleDuration: "" });
  });
});
