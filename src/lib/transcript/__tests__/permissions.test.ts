import { describe, expect, it } from "vitest";
import { canManageTranscriptPeriods } from "../permissions";

describe("canManageTranscriptPeriods", () => {
  it("allows jcrc and admin", () => {
    expect(canManageTranscriptPeriods(["resident", "jcrc"])).toBe(true);
    expect(canManageTranscriptPeriods(["admin"])).toBe(true);
  });

  it.each([
    [["resident"]],
    [["cca_head"]],
    [["scrc"]],
    [["resident", "cca_head"]],
    [[]],
  ])("denies %j", (roles) => {
    expect(canManageTranscriptPeriods(roles)).toBe(false);
  });

  it("does not modify the roles array", () => {
    const roles = Object.freeze(["jcrc"]);

    expect(canManageTranscriptPeriods(roles)).toBe(true);
    expect(roles).toEqual(["jcrc"]);
  });
});
