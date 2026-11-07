import { describe, expect, it } from "vitest";

import { canBookWithRoles } from "../access";

/**
 * Hall Office replaced `scrc` for hall-office accounts, but every stored
 * FacilityAccess requirement names `scrc` (the SCRC Room and the rest). Until
 * those rows are rewritten, `hall_office` must open what `scrc` opens, or a
 * re-roled account silently loses rooms it books today.
 */
describe("canBookWithRoles: hall_office books what scrc books", () => {
  it("lets hall_office book an scrc-gated room", () => {
    expect(
      canBookWithRoles(["resident", "hall_office"], ["jcrc", "scrc"]),
    ).toBe(true);
    expect(canBookWithRoles(["hall_office"], ["scrc"])).toBe(true);
  });

  it("does not widen anything else", () => {
    expect(canBookWithRoles(["hall_office"], ["jcrc"])).toBe(false);
    expect(canBookWithRoles(["hall_office"], ["cca_head"])).toBe(false);
    expect(canBookWithRoles(["scrc"], ["hall_office"])).toBe(false);
    expect(canBookWithRoles(["resident"], ["scrc"])).toBe(false);
  });

  it("still honours a room that names hall_office itself", () => {
    expect(canBookWithRoles(["hall_office"], ["hall_office"])).toBe(true);
  });
});
