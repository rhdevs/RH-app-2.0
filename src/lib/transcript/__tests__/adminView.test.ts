import { describe, expect, it } from "vitest";
import {
  PUBLISH_CONFIRMATION,
  REOPEN_CONFIRMATION,
  WRITES_LOCKED_NOTE,
  errorText,
  isWritable,
  normaliseStatus,
  publishSummary,
  reopenSummary,
  statusLabel,
  yearOptions,
} from "../adminView";

describe("status", () => {
  it("labels the two states and reads anything else as collecting", () => {
    expect(statusLabel("published")).toBe("Published");
    expect(statusLabel("collecting")).toBe("Collecting");
    expect(statusLabel(null)).toBe("Collecting");
    expect(statusLabel("bogus")).toBe("Collecting");
    expect(normaliseStatus(undefined)).toBe("collecting");
  });

  it("allows writes only while collecting", () => {
    expect(isWritable("collecting")).toBe(true);
    expect(isWritable(null)).toBe(true);
    expect(isWritable("published")).toBe(false);
  });
});

describe("yearOptions", () => {
  it("offers the current year plus every period, newest first, each once", () => {
    expect(
      yearOptions(
        [{ academicYear: "AY2026/27" }, { academicYear: "AY2027/28" }],
        "AY2026/27",
      ),
    ).toEqual(["AY2027/28", "AY2026/27"]);
  });

  it("offers the current year when there are no periods", () => {
    expect(yearOptions([], "AY2026/27")).toEqual(["AY2026/27"]);
  });
});

describe("summaries", () => {
  it("states both counts, pluralised", () => {
    expect(publishSummary({ frozen: 64, skippedUnresolved: 0 })).toBe(
      "64 members frozen, 0 rows could not be matched",
    );
    expect(publishSummary({ frozen: 1, skippedUnresolved: 1 })).toBe(
      "1 member frozen, 1 row could not be matched",
    );
    expect(publishSummary({ frozen: 62, skippedUnresolved: 2 })).toBe(
      "62 members frozen, 2 rows could not be matched",
    );
  });

  it("states how many transcripts were superseded", () => {
    expect(reopenSummary({ superseded: 1 })).toBe(
      "1 transcript marked as superseded",
    );
    expect(reopenSummary({ superseded: 0 })).toBe(
      "0 transcripts marked as superseded",
    );
  });
});

describe("wording", () => {
  it("uses the required confirmation text", () => {
    expect(PUBLISH_CONFIRMATION("AY2026/27")).toBe(
      "This freezes the member list for AY2026/27 and lets residents download their transcripts. Edits stop until you reopen.",
    );
    expect(REOPEN_CONFIRMATION).toBe(
      "This reopens editing. Transcripts already downloaded will be marked as superseded and residents will need to download again.",
    );
  });

  it("has no exclamation marks and never says 'successfully'", () => {
    for (const text of [
      PUBLISH_CONFIRMATION("AY2026/27"),
      REOPEN_CONFIRMATION,
      WRITES_LOCKED_NOTE,
      publishSummary({ frozen: 3, skippedUnresolved: 1 }),
      reopenSummary({ superseded: 2 }),
      errorText("SEM2_START_REQUIRED"),
    ]) {
      expect(text).not.toContain("!");
      expect(text.toLowerCase()).not.toContain("successfully");
    }
  });
});

describe("errorText", () => {
  it("turns known codes into plain sentences", () => {
    expect(errorText("SEM2_START_REQUIRED")).toBe(
      "Set the semester 2 start date before publishing.",
    );
    expect(errorText("PERIOD_PUBLISHED")).toBe(WRITES_LOCKED_NOTE);
    expect(errorText("RATE_LIMITED:30")).not.toMatch(/RATE_LIMITED/);
  });

  it("never shows a bare code or a long dump", () => {
    expect(errorText("SOMETHING_NEW")).toBe("Something went wrong. Try again.");
    expect(errorText(undefined)).toBe("Something went wrong. Try again.");
    expect(errorText("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });

  it("keeps a short readable message", () => {
    expect(errorText("Title is required")).toBe("Title is required");
  });
});
