import { describe, expect, it } from "vitest";

import {
  AUX_AWARD_MAX,
  AUX_AWARD_MIN,
  AUX_REASON_PRESETS,
  auxYearOf,
  isValidAuxAmount,
  parseAmountLines,
  parseIdentifierLines,
  pointsYearStartedAt,
  tallyAux,
} from "~/lib/auxPoints";

describe("auxYearOf", () => {
  const aug = new Date("2026-08-15T00:00:00Z");

  it("uses the stored points year when there is one", () => {
    expect(auxYearOf("AY2025/26", aug)).toBe("AY2025/26");
  });

  it("follows the calendar until a points year is started", () => {
    expect(auxYearOf(null, aug)).toBe("AY2026/27");
    expect(auxYearOf(undefined, aug)).toBe("AY2026/27");
  });

  it("ignores a malformed stored value", () => {
    expect(auxYearOf("2026", aug)).toBe("AY2026/27");
  });
});

describe("pointsYearStartedAt", () => {
  it("starts the academic year a press falls in", () => {
    expect(pointsYearStartedAt(new Date("2026-08-01T00:00:00+08:00"))).toBe(
      "AY2026/27",
    );
    expect(pointsYearStartedAt(new Date("2027-01-10T00:00:00+08:00"))).toBe(
      "AY2026/27",
    );
    expect(pointsYearStartedAt(new Date("2027-04-30T23:00:00+08:00"))).toBe(
      "AY2026/27",
    );
  });

  it("counts a press from May to July towards the coming year", () => {
    expect(pointsYearStartedAt(new Date("2027-05-01T00:00:00+08:00"))).toBe(
      "AY2027/28",
    );
    expect(pointsYearStartedAt(new Date("2027-07-31T23:00:00+08:00"))).toBe(
      "AY2027/28",
    );
  });
});

describe("isValidAuxAmount", () => {
  it("takes whole numbers in range only", () => {
    expect(isValidAuxAmount(AUX_AWARD_MIN)).toBe(true);
    expect(isValidAuxAmount(AUX_AWARD_MAX)).toBe(true);
    expect(isValidAuxAmount(0)).toBe(false);
    expect(isValidAuxAmount(AUX_AWARD_MAX + 1)).toBe(false);
    expect(isValidAuxAmount(1.5)).toBe(false);
    expect(isValidAuxAmount(Number.NaN)).toBe(false);
  });

  it("offers the fire-warden presets", () => {
    expect(AUX_REASON_PRESETS).toContain("Fire warden (Sem 1)");
    expect(AUX_REASON_PRESETS).toContain("Fire warden (Sem 2)");
  });
});

describe("tallyAux", () => {
  it("counts 1 per check-in and per record, and sums awards", () => {
    const totals = tallyAux({
      eventCheckIns: [{ userID: "b" }, { userID: "a" }, { userID: "b" }],
      recordAttendees: [{ userID: "a" }],
      awards: [
        { userID: "c", amount: 2 },
        { userID: "a", amount: 1 },
      ],
    });
    expect(totals).toEqual([
      { userID: "a", fromEvents: 2, fromAwards: 1, total: 3 },
      { userID: "b", fromEvents: 2, fromAwards: 0, total: 2 },
      { userID: "c", fromEvents: 0, fromAwards: 2, total: 2 },
    ]);
  });

  it("returns nothing for no sources", () => {
    expect(
      tallyAux({ eventCheckIns: [], recordAttendees: [], awards: [] }),
    ).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = Object.freeze({
      eventCheckIns: Object.freeze([Object.freeze({ userID: "a" })]),
      recordAttendees: Object.freeze([]),
      awards: Object.freeze([Object.freeze({ userID: "a", amount: 1 })]),
    });
    expect(() => tallyAux(input)).not.toThrow();
  });
});

describe("parseIdentifierLines", () => {
  it("keeps line numbers, skips blanks and takes the first cell", () => {
    expect(
      parseIdentifierLines(
        "A0123456X\n\n  e0123456 \r\nA0999999Y,Tan Ah Kow\n",
      ),
    ).toEqual([
      { line: 1, raw: "A0123456X" },
      { line: 3, raw: "e0123456" },
      { line: 4, raw: "A0999999Y" },
    ]);
  });

  it("splits on tabs too, and skips a header line", () => {
    expect(parseIdentifierLines("Matric\tName\nA0123456X\tLim")).toEqual([
      { line: 2, raw: "A0123456X" },
    ]);
  });

  it("drops repeats, keeping the first line", () => {
    expect(parseIdentifierLines("a0123456x\nA0123456X")).toEqual([
      { line: 1, raw: "a0123456x" },
    ]);
  });

  it("strips surrounding quotes", () => {
    expect(parseIdentifierLines('"A0123456X","Lim"')).toEqual([
      { line: 1, raw: "A0123456X" },
    ]);
  });
});

describe("parseAmountLines", () => {
  it("reads the amount from the second cell", () => {
    expect(parseAmountLines("matric,aux\nA0123456X,2\nA0999999Y, 3 ")).toEqual([
      { line: 2, raw: "A0123456X", amount: 2 },
      { line: 3, raw: "A0999999Y", amount: 3 },
    ]);
  });

  it("gives null for a missing, fractional or out-of-range amount", () => {
    expect(
      parseAmountLines("A1\nA2,1.5\nA3,0\nA4,99\nA5,x").map((l) => l.amount),
    ).toEqual([null, null, null, null, null]);
  });
});
