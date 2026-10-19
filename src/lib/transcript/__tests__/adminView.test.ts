import { describe, expect, it } from "vitest";
import {
  OPEN_CONFIRMATION,
  OPEN_LABEL,
  OPEN_REMINDER,
  PAST_YEAR_NOTE,
  PREVIOUS_YEAR_WARNING,
  openAvailability,
  WRITES_LOCKED_NOTE,
  errorText,
  bulkRestoreStoppedLine,
  stoppedLine,
  fieldError,
  isWritable,
  lockFailureText,
  normaliseStatus,
  openSummary,
  statusLabel,
  unresolvedNote,
  yearOptions,
} from "../adminView";

describe("status", () => {
  it("labels a year Collecting or Open, and reads anything else as collecting", () => {
    expect(statusLabel("published")).toBe("Open");
    expect(statusLabel("collecting")).toBe("Collecting");
    expect(statusLabel("closed")).toBe("Collecting");
    expect(statusLabel(null)).toBe("Collecting");
    expect(statusLabel("bogus")).toBe("Collecting");
    expect(normaliseStatus(undefined)).toBe("collecting");
  });

  it("locks the manager screens only once transcripts are open", () => {
    expect(isWritable("collecting")).toBe(true);
    expect(isWritable(null)).toBe(true);
    expect(isWritable("published")).toBe(false);
  });

  it("has one action: Open transcripts", () => {
    expect(OPEN_LABEL).toBe("Open transcripts");
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

  it("lists a previous year that has no period row yet, so it can be opened (F27)", () => {
    // October 2027: AY2026/27 was never touched (no row) but must be offered.
    expect(yearOptions([], "AY2027/28")).toEqual(["AY2027/28", "AY2026/27"]);
    expect(yearOptions([{ academicYear: "AY2027/28" }], "AY2028/29")).toEqual([
      "AY2028/29",
      "AY2027/28",
      "AY2026/27",
    ]);
  });

  it("starts at the first year and keeps an older existing period", () => {
    expect(yearOptions([{ academicYear: "AY2025/26" }], "AY2026/27")).toEqual([
      "AY2026/27",
      "AY2025/26",
    ]);
  });
});

describe("wording", () => {
  it("uses the required Open transcripts confirmation", () => {
    expect(OPEN_CONFIRMATION("AY2026/27")).toBe(
      "Open transcripts for AY2026/27? Every CCA's member list will be saved as it is now, all residents will be able to see and download their transcripts, and CCA heads will no longer be able to edit. After this, only JCRC and admin can fix individual residents.",
    );
  });

  it("words the 1 April reminder and the 1 August warning", () => {
    expect(OPEN_REMINDER("AY2026/27")).toBe(
      "Transcripts for AY2026/27 are not open yet. Open them at the end of the year, before 1 August. After that, this year can no longer be opened from the app.",
    );
    expect(PREVIOUS_YEAR_WARNING("AY2026/27")).toBe(
      "Transcripts for AY2026/27 were never opened. This year can no longer be opened from the app, because CCA member lists have changed since August. Contact RHDevs.",
    );
    expect(PAST_YEAR_NOTE).toBe(
      "This year can no longer be opened from the app, because CCA member lists have changed since August. Contact RHDevs.",
    );
    expect(errorText("YEAR_ENDED")).toBe(PAST_YEAR_NOTE);
  });

  it("offers Open transcripts for the current collecting year only", () => {
    const now = "AY2027/28";
    expect(openAvailability("AY2027/28", now, "collecting")).toBe("open");
    expect(openAvailability("AY2027/28", now, null)).toBe("open");
    expect(openAvailability("AY2027/28", now, "published")).toBe("none");
    // A past year never opened: no button, the note instead.
    expect(openAvailability("AY2026/27", now, "collecting")).toBe("past");
    expect(openAvailability("AY2026/27", now, null)).toBe("past");
    expect(openAvailability("AY2026/27", now, "published")).toBe("none");
    // A future year: nothing.
    expect(openAvailability("AY2028/29", now, null)).toBe("none");
    expect(openAvailability("", now, null)).toBe("none");
  });

  it("has no exclamation marks and never says 'successfully'", () => {
    for (const text of [
      OPEN_CONFIRMATION("AY2026/27"),
      OPEN_REMINDER("AY2026/27"),
      PREVIOUS_YEAR_WARNING("AY2026/27"),
      WRITES_LOCKED_NOTE,
      openSummary("AY2026/27", {
        opened: true,
        lockedNow: 3,
        failures: [],
        unresolved: 0,
      }),
    ]) {
      expect(text).not.toContain("!");
      expect(text.toLowerCase()).not.toContain("successfully");
    }
  });
});

describe("the Open transcripts result", () => {
  it("says the year is open and how many lists were saved", () => {
    expect(
      openSummary("AY2026/27", {
        opened: true,
        lockedNow: 12,
        failures: [],
        unresolved: 0,
      }),
    ).toBe("Transcripts for AY2026/27 are open. 12 CCA member lists saved.");
  });

  it("names each CCA that could not be saved, with a short reason, and how to finish", () => {
    const text = openSummary("AY2026/27", {
      opened: false,
      lockedNow: 3,
      failures: [
        { name: "Soccer (MALE)", code: "FREEZE_RACE" },
        { name: "Chess Club", code: "UNKNOWN" },
      ],
      unresolved: 0,
    });
    expect(text).toBe(
      "Transcripts for AY2026/27 are not open yet. 2 CCAs could not be saved: Soccer (MALE) (list changed while saving), Chess Club (UNKNOWN). Press Open transcripts again to finish.",
    );
  });

  it("reports members the roster could not match", () => {
    expect(unresolvedNote(1)).toBe("1 member could not be matched");
    expect(
      openSummary("AY2026/27", {
        opened: true,
        lockedNow: 1,
        failures: [],
        unresolved: 3,
      }),
    ).toContain("3 members could not be matched.");
  });

  it("keeps the short reasons readable", () => {
    expect(lockFailureText("P2034")).toBe("busy, try again");
    expect(lockFailureText("PERIOD_PUBLISHED")).toBe("year already open");
  });
});

describe("errorText", () => {
  it("turns known codes into plain sentences", () => {
    expect(errorText("PERIOD_PUBLISHED")).toBe(WRITES_LOCKED_NOTE);
    expect(errorText("RATE_LIMITED:30")).not.toMatch(/RATE_LIMITED/);
  });

  it("explains the refusals of Open transcripts and of the edit guard", () => {
    expect(errorText("YEAR_NOT_STARTED")).toMatch(/has not started yet/);
    expect(errorText("ALREADY_PUBLISHED")).toMatch(/already open/);
    expect(errorText("NOT_THE_TERM_YEAR")).toMatch(/current academic year/);
    for (const gone of [
      "SEM2_START_REQUIRED",
      "NOT_CLOSED",
      "YEAR_CLOSED",
      "CCA_YEAR_FROZEN",
      "TRANSCRIPT_FREEZE_FAILED",
      "NOTHING_TO_LOCK",
    ]) {
      expect(errorText(gone)).toBe("Something went wrong. Try again.");
    }
  });

  it("explains the year-range refusals", () => {
    expect(errorText("YEAR_BEFORE_START")).toMatch(
      /Transcripts start at AY2026\/27/,
    );
    expect(errorText("YEAR_NOT_OPEN")).toBe(
      "Transcripts for this year are not open yet.",
    );
    expect(errorText("YEAR_NOT_IN_REVIEW")).toBe(
      "Something went wrong. Try again.",
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

  it("explains a partial upload", () => {
    expect(errorText("UPLOAD_PARTIAL:200")).toContain(
      "The upload stopped part way: 200 imported.",
    );
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

describe("stoppedLine (U4)", () => {
  it("says how many were done, why it stopped and what to do", () => {
    expect(stoppedLine(3, "RECORDS_BUSY")).toBe(
      "3 were done before it stopped: Someone else is saving right now. Please try again. Submit again to finish; anyone already done will be skipped.",
    );
    expect(stoppedLine(1, "UNKNOWN")).toMatch(
      /^1 was done before it stopped: /,
    );
    expect(stoppedLine(0, "PERIOD_PUBLISHED")).toMatch(/^0 were done/);
  });
});

describe("bulkRestoreStoppedLine (V2)", () => {
  it("says how many were restored, why it stopped and that the rest are still selected", () => {
    expect(bulkRestoreStoppedLine(3, "RECORDS_BUSY")).toBe(
      "3 were restored before it stopped: Someone else is saving right now. Please try again. The rest are still selected; try again to finish.",
    );
    expect(bulkRestoreStoppedLine(1, "UNKNOWN")).toMatch(
      /^1 was restored before it stopped: /,
    );
  });
});
