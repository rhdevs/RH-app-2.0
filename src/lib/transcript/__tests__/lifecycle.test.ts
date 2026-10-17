import { describe, expect, it } from "vitest";
import { currentAcademicYear } from "../academicYear";
import {
  FIRST_ACADEMIC_YEAR,
  academicYearsUpTo,
  editRefusal,
  formatAcademicYear,
  isLater,
  nextAcademicYear,
  normaliseYearStatus,
  openBlocker,
  previousYearNotOpen,
  showOpenReminder,
  type YearStatus,
} from "../lifecycle";

const at = (iso: string) => new Date(iso);

describe("academic year arithmetic", () => {
  it("formats and steps years", () => {
    expect(formatAcademicYear(2026)).toBe("AY2026/27");
    expect(formatAcademicYear(2099)).toBe("AY2099/00");
    expect(nextAcademicYear("AY2026/27")).toBe("AY2027/28");
    expect(isLater("AY2027/28", "AY2026/27")).toBe(true);
    expect(isLater("AY2026/27", "AY2026/27")).toBe(false);
    expect(academicYearsUpTo("AY2028/29")).toEqual([
      "AY2026/27",
      "AY2027/28",
      "AY2028/29",
    ]);
    expect(academicYearsUpTo("AY2025/26")).toEqual([]);
  });

  it("rejects what is not an academic year", () => {
    expect(() => nextAcademicYear("2026")).toThrow(RangeError);
    expect(() => isLater("AY2026/27", "nope")).toThrow(RangeError);
  });
});

describe("the year status: collecting, then open", () => {
  it("reads published as open and anything else (a retired closed too) as collecting", () => {
    expect(normaliseYearStatus("published")).toBe("published");
    for (const s of ["collecting", "closed", null, undefined, "weird"]) {
      expect(normaliseYearStatus(s)).toBe("collecting");
    }
  });

  it("opens the current year or a past one still collecting, never a future one", () => {
    const now = at("2027-04-15T00:00:00Z"); // AY2026/27
    expect(openBlocker("AY2026/27", "collecting", now)).toBeNull();
    expect(openBlocker("AY2025/26", "collecting", now)).toBeNull();
    expect(openBlocker("AY2027/28", "collecting", now)).toBe(
      "YEAR_NOT_STARTED",
    );
    expect(openBlocker("AY2026/27", "published", now)).toBe(
      "ALREADY_PUBLISHED",
    );
  });

  it("needs no semester 2 date to open", () => {
    expect(
      openBlocker("AY2026/27", "collecting", at("2026-10-01T00:00:00Z")),
    ).toBeNull();
  });
});

describe("who may edit a CCA's records for a year", () => {
  const base = {
    isManager: false,
    isHead: true,
    status: "collecting" as YearStatus,
    isCurrentYear: true,
  };

  it("lets a current head edit the current year while it is collecting", () => {
    expect(editRefusal(base)).toBeNull();
  });

  it("keeps other years read-only for heads", () => {
    expect(editRefusal({ ...base, isCurrentYear: false })).toBe(
      "NOT_THE_TERM_YEAR",
    );
  });

  it("lets a manager edit any CCA for any year still collecting", () => {
    expect(
      editRefusal({
        ...base,
        isManager: true,
        isHead: false,
        isCurrentYear: false,
      }),
    ).toBeNull();
  });

  it("refuses everyone once transcripts are open (corrections are a separate path)", () => {
    for (const who of [
      { isManager: true, isHead: false },
      { isManager: false, isHead: true },
    ]) {
      expect(editRefusal({ ...base, ...who, status: "published" })).toBe(
        "PERIOD_PUBLISHED",
      );
    }
  });

  it("refuses anyone who is neither a manager nor a head of this CCA", () => {
    expect(editRefusal({ ...base, isHead: false })).toBe(
      "NOT_A_HEAD_OF_THIS_CCA",
    );
  });
});

describe("the reminders on the admin page", () => {
  it("reminds from 1 April (Singapore) to open the year's transcripts, while collecting", () => {
    // 31 March 23:59 Singapore is 15:59 UTC.
    expect(
      showOpenReminder("AY2026/27", "collecting", at("2027-03-31T15:59:00Z")),
    ).toBe(false);
    expect(
      showOpenReminder("AY2026/27", "collecting", at("2027-03-31T16:00:00Z")),
    ).toBe(true);
    expect(
      showOpenReminder("AY2026/27", "published", at("2027-05-01T00:00:00Z")),
    ).toBe(false);
  });

  it("warns from 1 August when the previous year was never opened", () => {
    const statusOf =
      (open: string[]) =>
      (y: string): YearStatus =>
        open.includes(y) ? "published" : "collecting";
    // 31 July 2027 23:59 Singapore: still AY2026/27, no previous year yet.
    expect(
      previousYearNotOpen(at("2027-07-31T15:59:00Z"), statusOf([])),
    ).toBeNull();
    // 1 August 2027 Singapore: AY2027/28, and AY2026/27 is still collecting.
    expect(previousYearNotOpen(at("2027-07-31T16:00:00Z"), statusOf([]))).toBe(
      "AY2026/27",
    );
    expect(
      previousYearNotOpen(at("2027-08-10T00:00:00Z"), statusOf(["AY2026/27"])),
    ).toBeNull();
    // Before the first transcript year there is nothing to warn about.
    expect(
      previousYearNotOpen(at("2026-10-01T00:00:00Z"), statusOf([])),
    ).toBeNull();
  });
});
