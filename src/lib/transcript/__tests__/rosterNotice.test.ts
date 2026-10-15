import { describe, expect, it } from "vitest";
import {
  LOCK_CONFIRMATION,
  NO_MEMBER_LIST_NOTE,
  lockButtonLabel,
  rosterNotice,
} from "../headView";

const base = {
  academicYear: "AY2026/27",
  mode: "live" as const,
  refusal: null,
  freezeReason: null,
  frozenOn: null,
};

describe("the line above the head's roster", () => {
  it("says nothing for a live, editable list", () => {
    expect(rosterNotice(base)).toBeNull();
  });

  it("says the year is published and editing is closed", () => {
    expect(rosterNotice({ ...base, refusal: "PERIOD_PUBLISHED" })).toBe(
      "Transcripts for AY2026/27 are published. Editing is closed. Ask the JCRC to reopen it.",
    );
  });

  it("says the list was frozen on a date, after a handover or at the close", () => {
    for (const freezeReason of [
      "handover",
      "head_removed",
      "close_year",
    ] as const) {
      expect(
        rosterNotice({
          ...base,
          mode: "frozen",
          refusal: "CCA_YEAR_FROZEN",
          freezeReason,
          frozenOn: "11 Mar 2027",
        }),
      ).toBe("Frozen on 11 Mar 2027. Ask the JCRC for changes.");
    }
  });

  it("says the same for a closed year whose list is frozen", () => {
    expect(
      rosterNotice({
        ...base,
        mode: "frozen",
        refusal: "YEAR_CLOSED",
        freezeReason: "close_year",
        frozenOn: "1 Jun 2027",
      }),
    ).toBe("Frozen on 1 Jun 2027. Ask the JCRC for changes.");
  });

  it("says the year is closed when there is no freeze to point to", () => {
    expect(rosterNotice({ ...base, refusal: "YEAR_CLOSED" })).toBe(
      "This year is closed for review. Ask the JCRC for changes.",
    );
  });

  it("says no member list was recorded for a year the CCA has moved past", () => {
    expect(rosterNotice({ ...base, mode: "none" })).toBe(
      "No member list was recorded for this year.",
    );
    expect(NO_MEMBER_LIST_NOTE).toBe(
      "No member list was recorded for this year.",
    );
  });

  it("tells a head their own lock leaves editing open", () => {
    expect(
      rosterNotice({
        ...base,
        mode: "frozen",
        freezeReason: "lock",
        frozenOn: "5 Oct 2026",
      }),
    ).toBe(
      "Member list locked on 5 Oct 2026. You can still edit roles, contributions and hours until the JCRC closes the year.",
    );
  });

  it("words the lock button and its confirmation", () => {
    expect(lockButtonLabel("AY2026/27")).toBe("Lock member list for AY2026/27");
    expect(LOCK_CONFIRMATION("AY2026/27")).toBe(
      "This fixes who appears on AY2026/27 transcripts for this CCA. You can still edit roles, contributions and hours until the JCRC closes the year. To undo, ask the JCRC.",
    );
  });

  it("has no exclamation marks and never says 'successfully'", () => {
    const all = [
      LOCK_CONFIRMATION("AY2026/27"),
      rosterNotice({ ...base, refusal: "PERIOD_PUBLISHED" }),
      rosterNotice({ ...base, refusal: "YEAR_CLOSED" }),
      rosterNotice({ ...base, mode: "none" }),
    ].join(" ");
    expect(all).not.toContain("!");
    expect(all).not.toMatch(/successfully/i);
  });
});
