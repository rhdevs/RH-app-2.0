import { describe, expect, it } from "vitest";
import { currentAcademicYear } from "../academicYear";
import {
  FIRST_ACADEMIC_YEAR,
  academicYearsUpTo,
  editRefusal,
  formatAcademicYear,
  freezeTarget,
  isLater,
  nextAcademicYear,
  normaliseYearStatus,
  showUnfrozenWarning,
  termAcademicYear,
  transitionBlocker,
  validActions,
  type FreezeReason,
  type YearAction,
  type YearStatus,
} from "../lifecycle";

const frozen = (...years: string[]) => new Set(years);
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

describe("a CCA's term year", () => {
  it("is the first year when nothing is frozen, however early the date", () => {
    expect(termAcademicYear(frozen(), at("2026-10-15T00:00:00Z"))).toBe(
      "AY2026/27",
    );
    expect(termAcademicYear(frozen(), at("2026-03-01T00:00:00Z"))).toBe(
      "AY2026/27",
    );
  });

  it("moves on to the next year once a year is frozen", () => {
    expect(
      termAcademicYear(frozen("AY2026/27"), at("2027-03-11T00:00:00Z")),
    ).toBe("AY2027/28");
  });

  it("skips only years that are frozen, in order", () => {
    // 2026/27 frozen, 2027/28 not: a CCA that was frozen late stays on 2027/28.
    expect(
      termAcademicYear(frozen("AY2026/27"), at("2028-09-01T00:00:00Z")),
    ).toBe("AY2027/28");
    // a gap: 2027/28 frozen but 2026/27 not -> the earliest unfrozen year.
    expect(
      termAcademicYear(frozen("AY2027/28"), at("2028-09-01T00:00:00Z")),
    ).toBe("AY2026/27");
  });

  it("never looks past the year after the current one", () => {
    // Today is in AY2026/27, and 2026/27 and 2027/28 are both frozen: the ceiling.
    expect(
      termAcademicYear(
        frozen("AY2026/27", "AY2027/28"),
        at("2027-03-11T00:00:00Z"),
      ),
    ).toBe("AY2027/28");
  });

  it("reads the date in Singapore: 31 July evening UTC is already August there", () => {
    // 2027-07-31T16:30Z is 1 Aug 00:30 in Singapore: the current year is 2027/28.
    expect(
      termAcademicYear(
        frozen("AY2026/27", "AY2027/28"),
        at("2027-07-31T16:30:00Z"),
      ),
    ).toBe("AY2028/29");
    expect(
      termAcademicYear(
        frozen("AY2026/27", "AY2027/28"),
        at("2027-07-31T15:30:00Z"),
      ),
    ).toBe("AY2027/28");
  });
});

describe("which year a freeze targets", () => {
  it("freezes the term year when it is the current year (a March handover)", () => {
    expect(freezeTarget(frozen(), at("2027-03-11T00:00:00Z"))).toEqual({
      kind: "freeze",
      academicYear: "AY2026/27",
    });
  });

  it("freezes the OLDEST unfrozen year, not the current one (a September handover)", () => {
    // 2026/27 was never frozen; the handover is in Sep 2027 (AY2027/28).
    expect(freezeTarget(frozen(), at("2027-09-10T00:00:00Z"))).toEqual({
      kind: "freeze",
      academicYear: "AY2026/27",
    });
  });

  it("skips when the term year is already ahead of the current year", () => {
    // Frozen at the March handover; a second change in May has nothing to freeze.
    expect(
      freezeTarget(frozen("AY2026/27"), at("2027-05-20T00:00:00Z")),
    ).toEqual({
      kind: "skipped",
      reason: "already_frozen_for_current_year",
    });
  });

  it("never targets a year later than the current one", () => {
    const dates = [
      "2026-10-15T00:00:00Z",
      "2027-03-11T00:00:00Z",
      "2027-09-10T00:00:00Z",
      "2028-06-01T00:00:00Z",
    ];
    const sets = [
      frozen(),
      frozen("AY2026/27"),
      frozen("AY2026/27", "AY2027/28"),
      frozen("AY2027/28"),
    ];
    for (const d of dates) {
      for (const f of sets) {
        const t = freezeTarget(f, at(d));
        if (t.kind === "freeze") {
          const current = currentAcademicYear(at(d));
          expect(isLater(t.academicYear, current), `${d} ${[...f]}`).toBe(
            false,
          );
        }
      }
    }
  });

  it("does nothing before the first transcript year begins", () => {
    expect(freezeTarget(frozen(), at("2026-05-01T00:00:00Z"))).toEqual({
      kind: "skipped",
      reason: "already_frozen_for_current_year",
    });
    expect(FIRST_ACADEMIC_YEAR).toBe("AY2026/27");
  });
});

describe("the year status machine", () => {
  const SEM2 = new Date("2027-01-10T16:00:00Z");
  const NOW = at("2027-03-01T00:00:00Z");
  const period = (status: string | null, sem2: Date | null = SEM2) => ({
    status,
    sem2Start: sem2,
  });
  const run = (
    action: YearAction,
    p: ReturnType<typeof period> | null,
    year = "AY2026/27",
  ) => transitionBlocker(action, p, year, NOW);

  it("lets the right action through from each status", () => {
    expect(run("close", period("collecting"))).toBeNull();
    expect(run("close", period(null))).toBeNull();
    expect(run("publish", period("closed"))).toBeNull();
    expect(run("reopen", period("published"))).toBeNull();
    expect(run("backToCollecting", period("closed"))).toBeNull();
  });

  it("refuses every other combination of action and status", () => {
    const table: Array<[YearAction, YearStatus | "none", string]> = [
      ["close", "closed", "NOT_COLLECTING"],
      ["close", "published", "NOT_COLLECTING"],
      ["publish", "collecting", "NOT_CLOSED"],
      ["publish", "published", "NOT_CLOSED"],
      ["publish", "none", "NOT_CLOSED"],
      ["reopen", "collecting", "NOT_PUBLISHED"],
      ["reopen", "closed", "NOT_PUBLISHED"],
      ["reopen", "none", "NOT_PUBLISHED"],
      ["backToCollecting", "collecting", "NOT_CLOSED"],
      ["backToCollecting", "published", "NOT_CLOSED"],
    ];
    for (const [action, status, expected] of table) {
      const p = status === "none" ? null : period(status);
      expect(run(action, p), `${action} from ${status}`).toBe(expected);
    }
  });

  it("needs the semester 2 start date to close, and a year that has begun", () => {
    expect(run("close", period("collecting", null))).toBe(
      "SEM2_START_REQUIRED",
    );
    expect(run("close", null)).toBe("SEM2_START_REQUIRED");
    expect(run("close", period("collecting"), "AY2027/28")).toBe(
      "YEAR_NOT_STARTED",
    );
    // the year's own span counts as begun, and past years can be closed
    expect(run("close", period("collecting"), "AY2026/27")).toBeNull();
  });

  it("offers only the valid actions for each status", () => {
    expect(validActions("collecting")).toEqual(["close"]);
    expect(validActions("closed")).toEqual(["publish", "backToCollecting"]);
    expect(validActions("published")).toEqual(["reopen"]);
  });

  it("reads a missing or unknown status as collecting", () => {
    expect(normaliseYearStatus(null)).toBe("collecting");
    expect(normaliseYearStatus("odd")).toBe("collecting");
    expect(normaliseYearStatus("closed")).toBe("closed");
  });
});

describe("who may edit a CCA's records for a year", () => {
  const REASONS: Array<FreezeReason | null> = [
    null,
    "lock",
    "handover",
    "head_removed",
    "close_year",
  ];
  const edit = (
    who: "manager" | "head" | "other",
    status: YearStatus,
    freezeReason: FreezeReason | null,
  ) =>
    editRefusal({
      isManager: who === "manager",
      isHead: who === "head",
      status,
      freezeReason,
    });

  it("refuses everyone once the year is published", () => {
    for (const who of ["manager", "head", "other"] as const) {
      for (const r of REASONS) {
        expect(edit(who, "published", r), `${who} ${r}`).toBe(
          "PERIOD_PUBLISHED",
        );
      }
    }
  });

  it("lets a manager edit any CCA while the year is collecting or closed, frozen or not", () => {
    for (const status of ["collecting", "closed"] as const) {
      for (const r of REASONS) {
        expect(edit("manager", status, r), `${status} ${r}`).toBeNull();
      }
    }
  });

  it("lets the head edit while collecting, unless the list was frozen by something other than their own lock", () => {
    expect(edit("head", "collecting", null)).toBeNull();
    expect(edit("head", "collecting", "lock")).toBeNull();
    for (const r of ["handover", "head_removed", "close_year"] as const) {
      expect(edit("head", "collecting", r), r).toBe("CCA_YEAR_FROZEN");
    }
  });

  it("refuses the head once the year is closed, even with their own lock", () => {
    for (const r of REASONS) {
      expect(edit("head", "closed", r), String(r)).toBe("YEAR_CLOSED");
    }
  });

  it("refuses anyone who is neither a manager nor the head of this CCA", () => {
    for (const status of ["collecting", "closed"] as const) {
      for (const r of REASONS) {
        expect(edit("other", status, r)).toBe("NOT_A_HEAD_OF_THIS_CCA");
      }
    }
  });
});

describe("the 1 June warning", () => {
  it("shows from 1 June (Singapore) of the year's end until it is closed, if CCAs are unfrozen", () => {
    expect(
      showUnfrozenWarning(
        "AY2026/27",
        "collecting",
        at("2027-05-31T15:59:00Z"),
        5,
      ),
    ).toBe(false);
    expect(
      showUnfrozenWarning(
        "AY2026/27",
        "collecting",
        at("2027-05-31T16:00:00Z"),
        5,
      ),
    ).toBe(true);
    expect(
      showUnfrozenWarning(
        "AY2026/27",
        "collecting",
        at("2028-02-01T00:00:00Z"),
        5,
      ),
    ).toBe(true);
  });

  it("is not shown once closed, published, or when every CCA is frozen", () => {
    const june = at("2027-06-10T00:00:00Z");
    expect(showUnfrozenWarning("AY2026/27", "closed", june, 5)).toBe(false);
    expect(showUnfrozenWarning("AY2026/27", "published", june, 5)).toBe(false);
    expect(showUnfrozenWarning("AY2026/27", "collecting", june, 0)).toBe(false);
  });

  it("is not shown for a year that has not reached June", () => {
    expect(
      showUnfrozenWarning(
        "AY2027/28",
        "collecting",
        at("2027-06-10T00:00:00Z"),
        5,
      ),
    ).toBe(false);
  });
});
