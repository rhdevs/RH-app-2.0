import { describe, expect, it } from "vitest";

import {
  addSummary,
  auxErrorCopy,
  pasteFileError,
  PASTE_FILE_MAX_BYTES,
  sgtToday,
} from "../auxCopy";

describe("auxErrorCopy", () => {
  it("explains a read-only year", () => {
    expect(auxErrorCopy({ message: "AUX_YEAR_READ_ONLY" })).toMatch(
      /earlier points year/,
    );
  });

  it("explains a lost capability", () => {
    expect(
      auxErrorCopy({ message: "CAPABILITY_REQUIRED:manageCcaPointsRanges" }),
    ).toMatch(/permission/);
    expect(auxErrorCopy({ message: "INSUFFICIENT_ROLE" })).toMatch(
      /permission/,
    );
  });

  it("explains a signed-out session", () => {
    expect(
      auxErrorCopy({ message: "x", data: { code: "UNAUTHORIZED" } }),
    ).toMatch(/signed out/);
  });

  it("never shows a raw validation message", () => {
    const copy = auxErrorCopy({
      message: '[{"code":"too_small"}]',
      data: { code: "BAD_REQUEST" },
    });
    expect(copy).not.toContain("too_small");
    expect(copy).toMatch(/Check the details/);
  });

  it("falls back to a retry line", () => {
    expect(auxErrorCopy(new Error("boom"))).toBe(
      "That didn’t save. Try again.",
    );
    expect(auxErrorCopy(undefined)).toBe("That didn’t save. Try again.");
  });
});

describe("addSummary", () => {
  it("counts the added and the already present", () => {
    expect(addSummary(3, 0)).toBe("Added 3.");
    expect(addSummary(0, 1)).toBe("Added 0. 1 was already there.");
    expect(addSummary(2, 2)).toBe("Added 2. 2 were already there.");
  });
});

describe("pasteFileError", () => {
  it("refuses a file over the limit", () => {
    expect(pasteFileError({ size: PASTE_FILE_MAX_BYTES })).toBeNull();
    expect(pasteFileError({ size: PASTE_FILE_MAX_BYTES + 1 })).toMatch(
      /too big/,
    );
  });
});

describe("sgtToday", () => {
  it("uses the Singapore date", () => {
    expect(sgtToday(new Date("2026-10-24T16:30:00Z"))).toBe("2026-10-25");
    expect(sgtToday(new Date("2026-10-24T15:30:00Z"))).toBe("2026-10-24");
  });
});
