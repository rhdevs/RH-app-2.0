import { describe, expect, it, vi } from "vitest";

// writeAudit lives in the admin router, which reads the environment.
vi.mock("~/server/api/routers/admin", () => ({ writeAudit: vi.fn() }));

import {
  assertMayEditFlaggedPosition,
  describeSnapshot,
  isFlaggedPosition,
  mayEditFlaggedPosition,
  sameMembers,
} from "../jcrcPositionLock";

describe("isFlaggedPosition: a missing field means false", () => {
  it("is false for no flags, null flags and false flags", () => {
    expect(isFlaggedPosition({})).toBe(false);
    expect(isFlaggedPosition({ vetsProposals: null })).toBe(false);
    expect(
      isFlaggedPosition({ vetsProposals: false, handlesDisposables: false }),
    ).toBe(false);
  });

  it("is true when either flag is true", () => {
    expect(isFlaggedPosition({ vetsProposals: true })).toBe(true);
    expect(isFlaggedPosition({ handlesDisposables: true })).toBe(true);
  });
});

describe("who may edit a flagged position (the check the staff panel reuses)", () => {
  it.each([["admin"], ["scrc"], ["hall_office"]])("%s may", (role) => {
    expect(mayEditFlaggedPosition(["resident", role])).toBe(true);
    expect(() =>
      assertMayEditFlaggedPosition(["resident", role]),
    ).not.toThrow();
  });

  it.each([["jcrc"], ["cca_head"], ["resident"]])(
    "%s alone may not",
    (role) => {
      expect(mayEditFlaggedPosition([role])).toBe(false);
      expect(() => assertMayEditFlaggedPosition([role])).toThrowError(
        expect.objectContaining({
          code: "FORBIDDEN",
          message: "POSITION_LOCKED",
        }),
      );
    },
  );

  it("refuses no roles at all", () => {
    expect(mayEditFlaggedPosition([])).toBe(false);
  });

  it("lets a person who is a plain jcrc member and also admin through", () => {
    expect(mayEditFlaggedPosition(["jcrc", "admin"])).toBe(true);
  });
});

describe("snapshot helpers", () => {
  it("describes holders and CCAs, or none", () => {
    expect(
      describeSnapshot({
        holders: [
          { userID: "E1", assignedBy: "E9" },
          { userID: "E2", assignedBy: "E9" },
        ],
        ccaIDs: [9001, 9002],
      }),
    ).toBe("holders: E1, E2; ccas: 9001, 9002");
    expect(describeSnapshot({ holders: [], ccaIDs: [] })).toBe(
      "holders: none; ccas: none",
    );
  });

  it("compares lists as sets", () => {
    expect(sameMembers(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameMembers(["a", "a"], ["a"])).toBe(true);
    expect(sameMembers([1, 2], [1, 3])).toBe(false);
    expect(sameMembers([1], [1, 2])).toBe(false);
  });
});
