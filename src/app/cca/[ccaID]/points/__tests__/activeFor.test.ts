import { describe, expect, it } from "vitest";

import {
  ACTIVE_FOR_OPTIONS,
  activeForOf,
  activeForAfterKey,
  semesterOnlyOf,
} from "~/app/cca/[ccaID]/points/_components/activeFor";

describe("Active for ↔ semesterOnly", () => {
  it("offers Full year first, then 1 sem", () => {
    expect(ACTIVE_FOR_OPTIONS.map((o) => o.label)).toEqual([
      "Full year",
      "1 sem",
    ]);
  });

  it("maps semesterOnly false to Full year and true to 1 sem", () => {
    expect(activeForOf(false)).toBe("full_year");
    expect(activeForOf(true)).toBe("one_sem");
  });

  it("maps the toggle back to semesterOnly", () => {
    expect(semesterOnlyOf("full_year")).toBe(false);
    expect(semesterOnlyOf("one_sem")).toBe(true);
  });

  it("treats anything unexpected as Full year (the default)", () => {
    expect(semesterOnlyOf("")).toBe(false);
    expect(semesterOnlyOf("bogus")).toBe(false);
  });
});

describe("activeForAfterKey (radiogroup keyboard)", () => {
  it.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])(
    "%s switches to the other option",
    (key) => {
      expect(activeForAfterKey("full_year", key)).toBe("one_sem");
      expect(activeForAfterKey("one_sem", key)).toBe("full_year");
    },
  );

  it("leaves Tab, Enter and letters alone", () => {
    for (const key of ["Tab", "Enter", "a", " "]) {
      expect(activeForAfterKey("full_year", key)).toBeNull();
    }
  });
});
