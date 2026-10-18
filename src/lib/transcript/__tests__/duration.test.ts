import { describe, expect, it } from "vitest";
import * as duration from "../duration";
import {
  clampRoleDuration,
  durationLabel,
  isDuration,
  resolveEntry,
  hasSavedRoleOrPeriod,
  roleFits,
  savedChoices,
} from "../duration";

describe("no date ever decides a semester", () => {
  it("has no date-based default functions any more", () => {
    expect(duration).not.toHaveProperty("defaultMembershipDuration");
    expect(duration).not.toHaveProperty("defaultRoleDuration");
  });
});

describe("durationLabel / isDuration", () => {
  it("labels only the part-year durations", () => {
    expect(durationLabel("sem1")).toBe("Semester 1");
    expect(durationLabel("sem2")).toBe("Semester 2");
    expect(durationLabel("full")).toBeNull();
    expect(durationLabel(null)).toBeNull();
    expect(durationLabel("bogus")).toBeNull();
  });

  it("recognises exactly the three durations", () => {
    expect(["full", "sem1", "sem2"].every(isDuration)).toBe(true);
    expect(isDuration("sem3")).toBe(false);
    expect(isDuration(null)).toBe(false);
  });
});

describe("role period must fit the membership", () => {
  it("lets a full-year member hold a role for any period", () => {
    expect(roleFits("full", "sem1")).toBe(true);
    expect(roleFits("full", "sem2")).toBe(true);
    expect(roleFits("full", "full")).toBe(true);
  });

  it("lets a semester member hold a role only for that semester", () => {
    expect(roleFits("sem2", "sem2")).toBe(true);
    expect(roleFits("sem2", "full")).toBe(false);
    expect(roleFits("sem2", "sem1")).toBe(false);
  });

  it("narrows a role that sticks out of the membership", () => {
    expect(clampRoleDuration("sem2", "full")).toBe("sem2");
    expect(clampRoleDuration("sem2", null)).toBe("sem2");
    expect(clampRoleDuration("sem1", "sem2")).toBe("sem1");
    expect(clampRoleDuration("full", "sem2")).toBe("sem2");
    expect(clampRoleDuration("full", null)).toBe("full");
  });
});

describe("resolveEntry", () => {
  const member = { isHead: false };

  it("gives a plain member with no choices a full year and no role", () => {
    expect(resolveEntry(null, member)).toEqual({
      duration: "full",
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
  });

  it("is a full year whatever the join or grant dates were", () => {
    // The caller no longer passes any date, so none can change the result.
    expect(resolveEntry(undefined, member).duration).toBe("full");
    expect(resolveEntry({}, { isHead: true }).duration).toBe("full");
    expect(resolveEntry({}, { isHead: true }).roleDuration).toBe("full");
  });

  it("uses the semester a head chose by hand", () => {
    expect(resolveEntry({ duration: "sem2" }, member).duration).toBe("sem2");
    expect(resolveEntry({ duration: "sem1" }, member).duration).toBe("sem1");
  });

  it("makes a head 'Head' for the full year by default", () => {
    expect(resolveEntry(null, { isHead: true })).toMatchObject({
      roleLabel: "Head",
      roleDuration: "full",
      duration: "full",
    });
  });

  it("lets a stored role label and period win", () => {
    expect(
      resolveEntry(
        { roleLabel: "Captain", roleDuration: "sem2" },
        { isHead: true },
      ),
    ).toMatchObject({
      duration: "full",
      roleLabel: "Captain",
      roleDuration: "sem2",
    });
  });

  it("pulls a role period inside a semester membership", () => {
    expect(
      resolveEntry(
        { duration: "sem2", roleLabel: "Head", roleDuration: "full" },
        { isHead: true },
      ),
    ).toMatchObject({ duration: "sem2", roleDuration: "sem2" });
    expect(
      resolveEntry({ duration: "sem2" }, { isHead: true }).roleDuration,
    ).toBe("sem2");
  });

  it("ignores an unrecognised stored duration instead of trusting it", () => {
    expect(resolveEntry({ duration: "sem9" }, member).duration).toBe("full");
  });

  it("trims and drops a blank contribution", () => {
    expect(
      resolveEntry({ extraContribution: "   " }, member).extraContribution,
    ).toBeNull();
    expect(
      resolveEntry({ extraContribution: " did X " }, member).extraContribution,
    ).toBe("did X");
  });

  it("does not mutate its inputs", () => {
    const stored = {
      duration: "sem1",
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    };
    const before = structuredClone(stored);

    resolveEntry(stored, member);

    expect(stored).toEqual(before);
  });
});

describe("savedChoices: the head's own choices, never a lock's filled-in default", () => {
  it("reads an entry no lock has touched from its own fields", () => {
    expect(
      savedChoices({
        duration: "sem1",
        roleLabel: "Captain",
        roleDuration: null,
      }),
    ).toEqual({
      duration: "sem1",
      roleLabel: "Captain",
      roleDuration: null,
      extraContribution: null,
    });
    expect(savedChoices(null)).toBeNull();
    expect(savedChoices(undefined)).toBeNull();
  });

  it("reads the choices a lock kept aside, not the resolved values it wrote", () => {
    const locked = {
      duration: "full",
      roleLabel: "Head",
      roleDuration: "full",
      extraContribution: null,
      preFreeze: {
        duration: null,
        roleLabel: null,
        roleDuration: null,
        extraContribution: null,
      },
    };
    expect(savedChoices(locked)).toEqual({
      duration: null,
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
    // So a member who is no longer the head is no longer "Head".
    expect(
      resolveEntry(savedChoices(locked), { isHead: false }).roleLabel,
    ).toBeNull();
  });
});

describe("hasSavedRoleOrPeriod: what keeps a leaver on the year's list", () => {
  it("counts a saved role, or a saved Semester 1 or 2", () => {
    expect(hasSavedRoleOrPeriod({ roleLabel: "Head" })).toBe(true);
    expect(hasSavedRoleOrPeriod({ duration: "sem2" })).toBe(true);
    expect(hasSavedRoleOrPeriod({ roleDuration: "sem1" })).toBe(true);
  });

  it("never counts the full-year default, a blank role, an extra alone, or nothing", () => {
    expect(hasSavedRoleOrPeriod({ duration: "full" })).toBe(false);
    expect(hasSavedRoleOrPeriod({ roleDuration: "full" })).toBe(false);
    expect(hasSavedRoleOrPeriod({ roleLabel: "   " })).toBe(false);
    expect(
      hasSavedRoleOrPeriod({ extraContribution: "Ran the kit room." }),
    ).toBe(false);
    expect(hasSavedRoleOrPeriod(null)).toBe(false);
  });

  it("reads the choices a lock kept aside, not its filled-in Head", () => {
    expect(
      hasSavedRoleOrPeriod(
        savedChoices({
          roleLabel: "Head",
          duration: "full",
          preFreeze: { roleLabel: null, duration: null },
        }),
      ),
    ).toBe(false);
  });
});
