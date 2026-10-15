import { describe, expect, it } from "vitest";
import { maskMatricForSearch } from "../matric";

describe("maskMatricForSearch", () => {
  it("keeps the first character and the last three, preserving length", () => {
    expect(maskMatricForSearch("A0225829W")).toBe("A*****29W");
    expect(maskMatricForSearch("A0225829W")).toHaveLength(9);
    expect(maskMatricForSearch("A9912000X")).toBe("A*****00X");
  });

  it("hides short values entirely", () => {
    expect(maskMatricForSearch("A123")).toBe("****");
    expect(maskMatricForSearch("AB")).toBe("**");
    expect(maskMatricForSearch("")).toBe("");
  });

  it("never returns the original for anything longer than four characters", () => {
    for (const m of ["A12345", "A0225829W", "U1234567B"]) {
      expect(maskMatricForSearch(m)).not.toBe(m);
      expect(maskMatricForSearch(m)).toHaveLength(m.length);
    }
  });
});
