import { describe, expect, it } from "vitest";

import {
  assignableBy,
  computeCapabilities,
  FACILITY_ROLES,
  forbiddenRoleCombination,
  GRANTABLE_ROLES,
  holdsStaffRole,
  revocableFromOthersBy,
  ROLES,
} from "~/server/api/services/roles";

const RF = ["resident", "scrc"];
const HALL_OFFICE = ["resident", "hall_office"];

describe("hall_office: the Hall Office half of the old scrc role", () => {
  it("is a real, grantable and facility-requirable role", () => {
    expect(ROLES).toContain("hall_office");
    expect(GRANTABLE_ROLES).toContain("hall_office");
    expect(FACILITY_ROLES).toContain("hall_office");
  });

  it("gets every RF staff power except the event views", () => {
    const rf = computeCapabilities(RF);
    const ho = computeCapabilities(HALL_OFFICE);

    expect(ho.reachScrcDashboard).toBe(rf.reachScrcDashboard);
    expect(ho.manageJcrcRoster).toBe(rf.manageJcrcRoster);
    expect(ho.viewCcaRostersReadOnly).toBe(rf.viewCcaRostersReadOnly);
    expect(rf.viewEventsReadOnly).toBe(true);
    expect(ho.viewEventsReadOnly).toBe(false);
  });

  it("gets none of the manager-tier powers", () => {
    const ho = computeCapabilities(HALL_OFFICE);
    expect(ho.reachDashboard).toBe(false);
    expect(ho.manageCcaHeads).toBe(false);
    expect(ho.reviewEvents).toBe(false);
    expect(ho.bulkAssign).toBe(false);
  });

  it("may appoint and remove jcrc, and nothing else", () => {
    expect([...assignableBy(HALL_OFFICE)]).toEqual(["jcrc"]);
    expect([...revocableFromOthersBy(HALL_OFFICE)]).toEqual(["jcrc"]);
  });

  it("is granted and revoked by admin only", () => {
    expect(assignableBy(["admin"]).has("hall_office")).toBe(true);
    expect(assignableBy(["jcrc"]).has("hall_office")).toBe(false);
    expect(assignableBy(RF).has("hall_office")).toBe(false);
    expect(assignableBy(HALL_OFFICE).has("hall_office")).toBe(false);
  });

  it("cannot be held together with jcrc", () => {
    expect(forbiddenRoleCombination(["jcrc", "hall_office"])).toBe(
      "CANNOT_HOLD_JCRC_AND_HALL_OFFICE",
    );
    expect(forbiddenRoleCombination(["jcrc", "scrc"])).toBe(
      "CANNOT_HOLD_JCRC_AND_SCRC",
    );
    expect(forbiddenRoleCombination(["scrc", "hall_office"])).toBeNull();
  });

  it("holdsStaffRole is true for either staff role only", () => {
    expect(holdsStaffRole(RF)).toBe(true);
    expect(holdsStaffRole(HALL_OFFICE)).toBe(true);
    expect(holdsStaffRole(["resident", "jcrc"])).toBe(false);
    expect(holdsStaffRole(["admin"])).toBe(false);
  });
});
