import { describe, expect, it } from "vitest";
import {
  ACTION_LABEL,
  BACK_TO_COLLECTING_CONFIRMATION,
  CLOSE_CONFIRMATION,
  PUBLISH_CONFIRMATION,
  REOPEN_CONFIRMATION,
  UNFREEZE_WARNING,
  UNFROZEN_BANNER,
  WRITES_LOCKED_NOTE,
  closeSummary,
  notFrozenText,
  errorText,
  fieldError,
  isWritable,
  normaliseStatus,
  statusLabel,
  yearOptions,
} from "../adminView";

describe("status", () => {
  it("labels the three states and reads anything else as collecting", () => {
    expect(statusLabel("published")).toBe("Published");
    expect(statusLabel("closed")).toBe("Closed");
    expect(statusLabel("collecting")).toBe("Collecting");
    expect(statusLabel(null)).toBe("Collecting");
    expect(statusLabel("bogus")).toBe("Collecting");
    expect(normaliseStatus(undefined)).toBe("collecting");
    expect(normaliseStatus("closed")).toBe("closed");
  });

  it("locks the manager screens only once the year is published", () => {
    expect(isWritable("collecting")).toBe(true);
    expect(isWritable(null)).toBe(true);
    expect(isWritable("closed")).toBe(true);
    expect(isWritable("published")).toBe(false);
  });

  it("names each year action", () => {
    expect(ACTION_LABEL).toEqual({
      close: "Close year",
      publish: "Publish",
      reopen: "Reopen for review",
      backToCollecting: "Back to collecting",
    });
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
  it("states how many CCAs a close froze, pluralised", () => {
    expect(
      closeSummary("AY2026/27", { frozenNow: 12, alreadyFrozen: 77 }),
    ).toBe("AY2026/27 closed. 12 CCAs frozen now, 77 already frozen.");
    expect(closeSummary("AY2026/27", { frozenNow: 1, alreadyFrozen: 0 })).toBe(
      "AY2026/27 closed. 1 CCA frozen now, 0 already frozen.",
    );
  });
});

describe("wording", () => {
  it("uses the required confirmation text", () => {
    expect(CLOSE_CONFIRMATION("AY2026/27", 12)).toBe(
      "This freezes the member list of 12 CCAs that are not frozen yet, and opens AY2026/27 for review. Residents will see a draft.",
    );
    expect(CLOSE_CONFIRMATION("AY2026/27", 1)).toContain(
      "1 CCA that is not frozen yet",
    );
    expect(PUBLISH_CONFIRMATION("AY2026/27")).toBe(
      "This lets residents download their AY2026/27 transcripts. Edits stop until you reopen the year for review.",
    );
    expect(REOPEN_CONFIRMATION).toBe(
      "This takes the published transcripts back to review. Residents see a draft again and you can fix data. Frozen member lists stay frozen.",
    );
    expect(BACK_TO_COLLECTING_CONFIRMATION).toBe(
      "This puts the year back to collecting. Frozen member lists stay frozen.",
    );
    expect(UNFREEZE_WARNING("AY2026/27")).toBe(
      "The CCA's current member list will be used for AY2026/27 until it is frozen again.",
    );
  });

  it("words the 1 June banner for one CCA and for several", () => {
    expect(UNFROZEN_BANNER(3, "AY2026/27")).toBe(
      "3 CCAs are not frozen for AY2026/27 yet. Close the year before memberships change.",
    );
    expect(UNFROZEN_BANNER(1, "AY2026/27")).toBe(
      "1 CCA is not frozen for AY2026/27 yet. Close the year before memberships change.",
    );
  });

  it("has no exclamation marks and never says 'successfully'", () => {
    for (const text of [
      CLOSE_CONFIRMATION("AY2026/27", 3),
      PUBLISH_CONFIRMATION("AY2026/27"),
      REOPEN_CONFIRMATION,
      BACK_TO_COLLECTING_CONFIRMATION,
      UNFREEZE_WARNING("AY2026/27"),
      UNFROZEN_BANNER(2, "AY2026/27"),
      WRITES_LOCKED_NOTE,
      closeSummary("AY2026/27", { frozenNow: 3, alreadyFrozen: 1 }),
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
      "Set the semester 2 start date before closing the year.",
    );
    expect(errorText("PERIOD_PUBLISHED")).toBe(WRITES_LOCKED_NOTE);
    expect(errorText("RATE_LIMITED:30")).not.toMatch(/RATE_LIMITED/);
  });

  it("explains the lifecycle refusals in plain words", () => {
    expect(errorText("NOT_COLLECTING")).toBe(
      "This academic year is not collecting.",
    );
    expect(errorText("NOT_CLOSED")).toBe("This academic year is not closed.");
    expect(errorText("YEAR_NOT_STARTED")).toMatch(/has not started yet/);
    expect(errorText("NOT_FROZEN")).toBe("That member list is not frozen.");
    expect(errorText("CCA_YEAR_FROZEN")).toBe(
      "This member list is frozen. Ask the JCRC for changes.",
    );
    expect(errorText("YEAR_CLOSED")).toBe(
      "This year is closed. Ask the JCRC for changes.",
    );
    expect(errorText("TRANSCRIPT_FREEZE_FAILED")).toMatch(
      /head change was not made/,
    );
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

describe("validation messages", () => {
  it("turns the server's validation codes into sentences", () => {
    expect(errorText("AT_MOST_120_CHARACTERS")).toBe(
      "Use at most 120 characters.",
    );
    expect(errorText("AT_LEAST_3_CHARACTERS")).toBe(
      "Use at least 3 characters.",
    );
    expect(errorText("REQUIRED")).toBe("This field is required.");
    expect(errorText("CONTROL_CHARACTERS_NOT_ALLOWED")).toBe(
      "Remove any control characters.",
    );
  });

  it("reads one field's first message from an API validation error", () => {
    const zodError = {
      fieldErrors: { title: ["AT_MOST_120_CHARACTERS"], citation: undefined },
    };

    expect(fieldError(zodError, "title")).toBe("Use at most 120 characters.");
    expect(fieldError(zodError, "citation")).toBeNull();
    expect(fieldError(null, "title")).toBeNull();
    expect(fieldError(undefined, "title")).toBeNull();
  });
});

describe("closing and publishing messages", () => {
  it("says what a close that stopped part way did, and how to finish", () => {
    expect(
      closeSummary("AY2026/27", {
        closed: false,
        frozenNow: 11,
        alreadyFrozen: 2,
        failed: 1,
        failedNames: ["Soccer (MALE)"],
      }),
    ).toBe(
      "AY2026/27 is not closed yet. 11 CCAs frozen now, 2 already frozen, 1 CCA could not be frozen: Soccer (MALE). Press Close year again to finish them.",
    );
  });

  it("mentions CCAs left alone only when there were some", () => {
    expect(
      closeSummary("AY2026/27", {
        frozenNow: 1,
        alreadyFrozen: 1,
        skipped: 2,
      }),
    ).toBe(
      "AY2026/27 closed. 1 CCA frozen now, 1 already frozen, 2 left as they were.",
    );
  });

  it("names the CCAs that block Publish, from the server's refusal too", () => {
    const text =
      "Some CCAs are not frozen for AY2026/27: Chess Club, Soccer (MALE). Close the year again to freeze them.";
    expect(notFrozenText("AY2026/27", ["Chess Club", "Soccer (MALE)"])).toBe(
      text,
    );
    expect(
      errorText("CCAS_NOT_FROZEN:AY2026/27:Chess Club, Soccer (MALE)"),
    ).toBe(text);
  });

  it("explains a partial upload", () => {
    expect(errorText("UPLOAD_PARTIAL:200")).toContain(
      "The upload stopped part way: 200 imported.",
    );
  });
});
