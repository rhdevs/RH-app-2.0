import { describe, expect, it } from "vitest";
import { canEditAwards, canManageExtraContribution } from "../permissions";

describe("canEditAwards", () => {
  it("allows jcrc", () => {
    expect(canEditAwards(["resident", "jcrc"])).toBe(true);
  });

  it("allows admin", () => {
    expect(canEditAwards(["admin"])).toBe(true);
  });

  it.each([[["resident"]], [["cca_head"]], [["scrc"]], [[]]])(
    "denies %j",
    (roles) => {
      expect(canEditAwards(roles)).toBe(false);
    },
  );
});

describe("canManageExtraContribution", () => {
  it("allows admin even when not head of that CCA", () => {
    expect(canManageExtraContribution(["admin"], false)).toBe(true);
  });

  it("allows a cca_head who heads that CCA", () => {
    expect(canManageExtraContribution(["resident", "cca_head"], true)).toBe(
      true,
    );
  });

  it("denies a cca_head who does not head that CCA", () => {
    expect(canManageExtraContribution(["resident", "cca_head"], false)).toBe(
      false,
    );
  });

  it("denies a non-head role even when flagged as head of that CCA", () => {
    expect(canManageExtraContribution(["resident"], true)).toBe(false);
  });

  it("denies jcrc, who cannot manage contributions by role alone", () => {
    expect(canManageExtraContribution(["jcrc"], false)).toBe(false);
  });

  it("denies an empty role list", () => {
    expect(canManageExtraContribution([], true)).toBe(false);
  });
});

describe("input immutability", () => {
  it("does not modify the roles array", () => {
    const roles = Object.freeze(["jcrc", "cca_head"]);

    expect(() => canEditAwards(roles)).not.toThrow();
    expect(() => canManageExtraContribution(roles, true)).not.toThrow();
    expect(roles).toEqual(["jcrc", "cca_head"]);
  });
});
