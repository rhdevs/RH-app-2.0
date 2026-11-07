import { describe, expect, it } from "vitest";

import { unreadLabel } from "../unreadText";

describe("unreadLabel", () => {
  it("is null for none, negative and not-a-number counts", () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(-2)).toBeNull();
    expect(unreadLabel(Number.NaN)).toBeNull();
  });

  it("says how many are new", () => {
    expect(unreadLabel(1)).toBe("1 new");
    expect(unreadLabel(99)).toBe("99 new");
  });

  it("caps a long thread", () => {
    expect(unreadLabel(100)).toBe("99+ new");
  });
});
