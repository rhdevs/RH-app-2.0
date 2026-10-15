import { describe, expect, it } from "vitest";
import {
  defaultMembershipDuration,
  defaultRoleDuration,
  durationLabel,
  isDuration,
  resolveEntry,
} from "../duration";

const SEM2 = new Date("2027-01-11T00:00:00Z");

describe("defaultMembershipDuration", () => {
  it("is full when accepted before semester 2 starts", () => {
    expect(
      defaultMembershipDuration(new Date("2026-08-20T00:00:00Z"), SEM2),
    ).toBe("full");
  });

  it("is sem2 when accepted after semester 2 starts", () => {
    expect(
      defaultMembershipDuration(new Date("2027-01-20T00:00:00Z"), SEM2),
    ).toBe("sem2");
  });

  it("counts exactly the sem2 start instant as sem2", () => {
    expect(defaultMembershipDuration(new Date(SEM2), SEM2)).toBe("sem2");
  });

  it("counts one millisecond before the sem2 start as full", () => {
    expect(defaultMembershipDuration(new Date(SEM2.getTime() - 1), SEM2)).toBe(
      "full",
    );
  });

  it.each([
    [null, SEM2],
    [undefined, SEM2],
    [new Date("2027-02-01T00:00:00Z"), null],
    [new Date("2027-02-01T00:00:00Z"), undefined],
    [null, null],
  ])("is full when a date is missing (%j, %j)", (decidedAt, sem2Start) => {
    expect(defaultMembershipDuration(decidedAt, sem2Start)).toBe("full");
  });
});

describe("defaultRoleDuration", () => {
  it("is sem2 for a head granted on or after the sem2 start", () => {
    expect(defaultRoleDuration(new Date(SEM2), SEM2)).toBe("sem2");
    expect(defaultRoleDuration(new Date("2027-03-01T00:00:00Z"), SEM2)).toBe(
      "sem2",
    );
  });

  it("is full for a head granted earlier or with no dates", () => {
    expect(defaultRoleDuration(new Date("2026-08-01T00:00:00Z"), SEM2)).toBe(
      "full",
    );
    expect(defaultRoleDuration(null, SEM2)).toBe("full");
    expect(defaultRoleDuration(new Date("2027-03-01T00:00:00Z"), null)).toBe(
      "full",
    );
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

describe("resolveEntry", () => {
  const member = { decidedAt: null, isHead: false, grantedAt: null };

  it("gives a plain member with no annotations a full year and no role", () => {
    expect(resolveEntry(null, member, SEM2)).toEqual({
      duration: "full",
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
  });

  it("defaults a late-accepted member to sem2", () => {
    const late = { ...member, decidedAt: new Date("2027-01-20T00:00:00Z") };

    expect(resolveEntry(null, late, SEM2).duration).toBe("sem2");
  });

  it("lets a stored override beat the default", () => {
    const late = { ...member, decidedAt: new Date("2027-01-20T00:00:00Z") };

    expect(resolveEntry({ duration: "full" }, late, SEM2).duration).toBe(
      "full",
    );
  });

  it("makes a head 'Head' with a derived role duration", () => {
    const head = {
      decidedAt: null,
      isHead: true,
      grantedAt: new Date("2027-02-01T00:00:00Z"),
    };

    expect(resolveEntry(null, head, SEM2)).toMatchObject({
      roleLabel: "Head",
      roleDuration: "sem2",
      duration: "full",
    });
  });

  it("lets a stored role label and duration beat the derived ones", () => {
    const head = {
      decidedAt: null,
      isHead: true,
      grantedAt: new Date("2027-02-01T00:00:00Z"),
    };

    expect(
      resolveEntry({ roleLabel: "Captain", roleDuration: "full" }, head, SEM2),
    ).toMatchObject({ roleLabel: "Captain", roleDuration: "full" });
  });

  it("ignores an unrecognised stored duration instead of trusting it", () => {
    expect(resolveEntry({ duration: "sem9" }, member, SEM2).duration).toBe(
      "full",
    );
  });

  it("trims and drops a blank contribution", () => {
    expect(
      resolveEntry({ extraContribution: "   " }, member, SEM2)
        .extraContribution,
    ).toBeNull();
    expect(
      resolveEntry({ extraContribution: " did X " }, member, SEM2)
        .extraContribution,
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

    resolveEntry(stored, member, SEM2);

    expect(stored).toEqual(before);
  });
});
