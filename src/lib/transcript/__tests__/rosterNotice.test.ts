import { describe, expect, it } from "vitest";
import * as headView from "../headView";
import { NO_MEMBER_LIST_NOTE, rosterNotice } from "../headView";

const base = {
  academicYear: "AY2026/27",
  mode: "live" as const,
  refusal: null,
};

describe("the line above the head's roster", () => {
  it("tells a head when the year is not the current one", () => {
    expect(rosterNotice({ ...base, refusal: "NOT_THE_TERM_YEAR" })).toBe(
      "Heads can only change the current academic year. Ask the JCRC for changes to other years.",
    );
    expect(
      rosterNotice({ ...base, mode: "none", refusal: "NOT_THE_TERM_YEAR" }),
    ).toBe(NO_MEMBER_LIST_NOTE);
  });

  it("says nothing for a live, editable list", () => {
    expect(rosterNotice(base)).toBeNull();
  });

  it("says the year is open and editing is closed", () => {
    expect(rosterNotice({ ...base, refusal: "PERIOD_PUBLISHED" })).toBe(
      "Transcripts for AY2026/27 are open. Editing is closed. Ask the JCRC to fix individual residents.",
    );
  });

  it("says no member list was recorded for a year the CCA did not exist in", () => {
    expect(rosterNotice({ ...base, mode: "none" })).toBe(
      "No member list was recorded for this year.",
    );
    expect(NO_MEMBER_LIST_NOTE).toBe(
      "No member list was recorded for this year.",
    );
  });

  it("has no lock, freeze or closed-year wording left", () => {
    expect(headView).not.toHaveProperty("lockButtonLabel");
    expect(headView).not.toHaveProperty("LOCK_CONFIRMATION");
    expect(headView).not.toHaveProperty("DEFAULTS_NOTE");
  });

  it("has no exclamation marks and never says 'successfully'", () => {
    const all = [
      rosterNotice({ ...base, refusal: "PERIOD_PUBLISHED" }),
      rosterNotice({ ...base, refusal: "NOT_THE_TERM_YEAR" }),
      rosterNotice({ ...base, mode: "none" }),
    ].join(" ");
    expect(all).not.toContain("!");
    expect(all).not.toMatch(/successfully/i);
    expect(all).not.toMatch(/frozen|reopen|lock/i);
  });
});
