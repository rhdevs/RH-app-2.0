import { describe, expect, it } from "vitest";

import { DEFAULT_RANGE } from "~/lib/points/constants";
import { exportBlockers, type PointsEntry } from "~/lib/points/entries";

function entry(n: number, patch: Partial<PointsEntry> = {}): PointsEntry {
  return {
    rowKey: `u:${n}`,
    matric: `A99${String(n).padStart(5, "0")}Z`,
    name: `Test Member ${n}`,
    resolved: true,
    basePoints: 12,
    semesterOnly: false,
    outgoingRole: "none",
    incomingRole: "none",
    ihg: false,
    ...patch,
  };
}

/** Six scores with mean 13 and SD 3.42: inside the default ranges. */
function goodRoster(): PointsEntry[] {
  return [8, 10, 12, 14, 16, 18].map((score, i) =>
    entry(i + 1, { basePoints: score }),
  );
}

const codes = (list: { code: string }[]): string[] => list.map((b) => b.code);

describe("exportBlockers", () => {
  it("is empty for a complete, in-range roster on an open window", () => {
    expect(exportBlockers(goodRoster(), DEFAULT_RANGE, true, null)).toEqual([]);
  });

  it("NOT_OPEN comes first when entry is closed", () => {
    const list = exportBlockers(goodRoster(), DEFAULT_RANGE, false, null);
    expect(codes(list)).toEqual(["NOT_OPEN"]);
    expect(list[0]?.message).toMatch(/closed/i);
  });

  it("EMPTY_ROSTER for no members", () => {
    expect(codes(exportBlockers([], DEFAULT_RANGE, true, null))).toEqual([
      "EMPTY_ROSTER",
    ]);
  });

  it("MISSING_SCORE counts members with no score", () => {
    const roster = goodRoster().map((e, i) =>
      i < 3 ? { ...e, basePoints: null } : e,
    );
    const [blocker] = exportBlockers(roster, DEFAULT_RANGE, true, null);
    expect(blocker).toEqual({
      code: "MISSING_SCORE",
      message: "3 members still need a score",
      rowKeys: ["u:1", "u:2", "u:3"],
    });
  });

  it("MISSING_SCORE uses the singular for one member", () => {
    const roster = goodRoster().map((e, i) =>
      i === 0 ? { ...e, basePoints: null } : e,
    );
    expect(exportBlockers(roster, DEFAULT_RANGE, true, null)[0]?.message).toBe(
      "1 member still needs a score",
    );
  });

  it.each([21, -1, 7.5, Number.NaN])("BAD_SCORE for %s", (bad) => {
    const roster = goodRoster().map((e, i) =>
      i === 0 ? { ...e, basePoints: bad } : e,
    );
    const list = exportBlockers(roster, DEFAULT_RANGE, true, null);
    expect(codes(list)).toEqual(["BAD_SCORE"]);
    expect(list[0]?.rowKeys).toEqual(["u:1"]);
    expect(list[0]?.message).toMatch(/whole number from 0 to 20/);
  });

  it("accepts the end scores 0 and 20", () => {
    const wide = { meanMin: 0, meanMax: 20, sdMin: 0, sdMax: 10 };
    const roster = [entry(1, { basePoints: 0 }), entry(2, { basePoints: 20 })];
    expect(exportBlockers(roster, wide, true, null)).toEqual([]);
  });

  it("MISSING_MATRIC for a resolved member with no matric", () => {
    const roster = goodRoster().map((e, i) =>
      i < 2 ? { ...e, matric: null } : e,
    );
    const list = exportBlockers(roster, DEFAULT_RANGE, true, null);
    expect(list[0]).toEqual({
      code: "MISSING_MATRIC",
      message:
        "2 members have no matric on record — ask them to add it in their RHApp profile, or ask JCRC to fix the roster",
      rowKeys: ["u:1", "u:2"],
    });
  });

  it("UNRESOLVED_MEMBER for a roster entry with no account", () => {
    const roster = [
      ...goodRoster(),
      entry(9, { resolved: false, matric: null, name: null, basePoints: null }),
    ];
    const list = exportBlockers(roster, DEFAULT_RANGE, true, null);
    expect(codes(list)).toContain("UNRESOLVED_MEMBER");
    expect(list.find((b) => b.code === "UNRESOLVED_MEMBER")?.rowKeys).toEqual([
      "u:9",
    ]);
  });

  it("reports blockers in a fixed order", () => {
    const roster = [
      entry(1, { basePoints: null }),
      entry(2, { basePoints: 30 }),
      entry(3, { matric: null }),
      entry(5, { matric: "X123" }),
      entry(4, { resolved: false, matric: null, basePoints: 10 }),
    ];
    expect(codes(exportBlockers(roster, DEFAULT_RANGE, false, null))).toEqual([
      "NOT_OPEN",
      "MISSING_SCORE",
      "BAD_SCORE",
      "MISSING_MATRIC",
      "BAD_MATRIC",
      "UNRESOLVED_MEMBER",
    ]);
  });

  it.each([
    "A123456Z",
    "B1234567Z",
    "A12345678",
    "a1234567",
    "A1234567ZZ",
    " ",
  ])("BAD_MATRIC for %j", (bad) => {
    const roster = goodRoster().map((e, i) =>
      i === 0 ? { ...e, matric: bad } : e,
    );
    const list = exportBlockers(roster, DEFAULT_RANGE, true, null);
    expect(codes(list)).toEqual(["BAD_MATRIC"]);
    expect(list[0]?.rowKeys).toEqual(["u:1"]);
    expect(list[0]?.message).toMatch(/matric/i);
  });

  it("accepts a lower-case matric (it is upper-cased on export)", () => {
    const roster = goodRoster().map((e, i) =>
      i === 0 ? { ...e, matric: "a9900001z" } : e,
    );
    expect(exportBlockers(roster, DEFAULT_RANGE, true, null)).toEqual([]);
  });

  it("MEAN_OUT_OF_RANGE carries the hint text", () => {
    const roster = [18, 19, 20, 17].map((s, i) =>
      entry(i + 1, { basePoints: s }),
    );
    const list = exportBlockers(roster, DEFAULT_RANGE, true, null);
    const mean = list.find((b) => b.code === "MEAN_OUT_OF_RANGE");
    expect(mean?.message).toMatch(/^Average is 18\.50 — lower some scores/);
  });

  it("SD_OUT_OF_RANGE carries the hint text (E8 scores)", () => {
    const roster = [20, 20, 15, 12, 10, 8, 5].map((s, i) =>
      entry(i + 1, { basePoints: s }),
    );
    const list = exportBlockers(roster, DEFAULT_RANGE, true, null);
    expect(codes(list)).toEqual(["SD_OUT_OF_RANGE"]);
    expect(list[0]?.message).toMatch(
      /^Spread is 5\.36 — scores are too far apart/,
    );
  });

  it("uses FULL scores: semester-only and roles change nothing", () => {
    const flagged = goodRoster().map((e) => ({
      ...e,
      semesterOnly: true,
      outgoingRole: "head" as const,
      incomingRole: "vice_head" as const,
    }));
    expect(exportBlockers(flagged, DEFAULT_RANGE, true, null)).toEqual([]);
  });

  it("does not report mean/SD while scores are still missing", () => {
    const roster = [
      entry(1, { basePoints: 20 }),
      entry(2, { basePoints: null }),
    ];
    expect(codes(exportBlockers(roster, DEFAULT_RANGE, true, null))).toEqual([
      "MISSING_SCORE",
    ]);
  });

  it("uses the range it is given", () => {
    const waived = { meanMin: 14, meanMax: 17, sdMin: 1, sdMax: 3 };
    const roster = [15, 16, 17, 14].map((s, i) =>
      entry(i + 1, { basePoints: s }),
    );
    expect(exportBlockers(roster, waived, true, null)).toEqual([]);
  });

  it("does not mutate its input", () => {
    const roster = Object.freeze(
      goodRoster().map((e) => Object.freeze({ ...e })),
    );
    expect(() => exportBlockers(roster, DEFAULT_RANGE, true, null)).not.toThrow();
  });
});

describe("exportBlockers: duplicate matric", () => {
  const range = DEFAULT_RANGE;
  const scores = [10, 12, 14, 16, 12, 14];
  const roster = (patches: Record<number, Partial<PointsEntry>> = {}) =>
    scores.map((s, i) => entry(i + 1, { basePoints: s, ...patches[i + 1] }));

  it("detects members sharing a matric regardless of case and whitespace", () => {
    const entries = roster({
      2: { matric: "A9900001Z" },
      1: { matric: " a9900001z " },
    });
    const dup = exportBlockers(entries, range, true, null).find(
      (b) => b.code === "DUPLICATE_MATRIC",
    );
    expect(dup?.rowKeys).toEqual(["u:1", "u:2"]);
    expect(dup?.message).toBe(
      "These members share one matric number: Test Member 1, Test Member 2. Ask JCRC to fix the roster.",
    );
  });

  it("does not flag distinct matrics", () => {
    expect(
      exportBlockers(roster(), range, true, null).some(
        (b) => b.code === "DUPLICATE_MATRIC",
      ),
    ).toBe(false);
  });

  it("ignores members who have no matric (that is a different blocker)", () => {
    const entries = roster({ 1: { matric: null }, 2: { matric: null } });
    const codes = exportBlockers(entries, range, true, null).map((b) => b.code);
    expect(codes).toContain("MISSING_MATRIC");
    expect(codes).not.toContain("DUPLICATE_MATRIC");
  });
});

describe("exportBlockers: IHG", () => {
  const ticked = (n: number): PointsEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry(i + 1, { basePoints: 8 + (i % 6) * 2, ihg: true }),
    );
  const sport = { result: "1st", cap: 12 } as const;

  it("leaves a non-sport (null context) unchanged", () => {
    expect(exportBlockers(goodRoster(), DEFAULT_RANGE, true, null)).toEqual([]);
  });

  it("IHG_OVER_CAP names the excess and the ticked rows", () => {
    const roster = ticked(14);
    const list = exportBlockers(roster, DEFAULT_RANGE, true, sport);
    const over = list.filter((b) => b.code === "IHG_OVER_CAP");
    expect(over).toHaveLength(1);
    expect(over[0]?.message).toBe("IHG: 14 ticked, the cap is 12 — untick 2.");
    expect(over[0]?.rowKeys).toEqual(roster.map((e) => e.rowKey));
  });

  it("allows ticks exactly at the cap", () => {
    expect(
      codes(exportBlockers(ticked(12), DEFAULT_RANGE, true, sport)),
    ).not.toContain("IHG_OVER_CAP");
  });

  it.each([
    ["no result", { result: null, cap: 12 }],
    ["no cap", { result: "1st", cap: null }],
  ] as const)("IHG_NOT_CONFIGURED when JCRC set %s", (_label, ctx) => {
    const list = exportBlockers(goodRoster(), DEFAULT_RANGE, true, ctx);
    const blocker = list.find((b) => b.code === "IHG_NOT_CONFIGURED");
    expect(blocker?.message).toBe(
      "JCRC hasn't set this CCA's IHG result and cap yet. Ask them; you can keep entering scores.",
    );
    expect(blocker?.rowKeys).toBeUndefined();
  });

  it("is judged even while scores are missing", () => {
    const roster = ticked(14).map((e) => ({ ...e, basePoints: null }));
    const list = exportBlockers(roster, DEFAULT_RANGE, true, sport);
    expect(codes(list)).toContain("IHG_OVER_CAP");
    expect(codes(list)).toContain("MISSING_SCORE");
  });

  it("comes after the identity blockers and before the range blockers", () => {
    const roster = [
      ...ticked(14).map((e) => ({ ...e, basePoints: 20 })),
      entry(20, { matric: null, basePoints: 20 }),
    ];
    expect(codes(exportBlockers(roster, DEFAULT_RANGE, true, sport))).toEqual([
      "MISSING_MATRIC",
      "IHG_OVER_CAP",
      "MEAN_OUT_OF_RANGE",
      "SD_OUT_OF_RANGE",
    ]);
  });
});
