import { describe, expect, it } from "vitest";

import type { PointsEntry } from "~/lib/points/entries";
import { buildPointsCsv } from "~/lib/points/exportCsv";
import { buildFlatPointsCsv } from "~/lib/points/flatCsv";

const AT = new Date("2027-04-01T09:30:15.123Z");

const entry = (name: string): PointsEntry => ({
  rowKey: "u:1",
  matric: "A9900001Z",
  name,
  resolved: true,
  basePoints: 12,
  semesterOnly: false,
  outgoingRole: "none",
  incomingRole: "none",
  ihg: false,
});

// What each leading character becomes: neutralised with an apostrophe, then
// quoted only when the cell now needs it (a CR does, a tab does not).
const CASES: [string, string][] = [
  ["=", "'=x"],
  ["+", "'+x"],
  ["-", "'-x"],
  ["@", "'@x"],
  ["\t", "'\tx"],
  ["\r", '"\'\rx"'],
];

describe("formula guard on the leader export", () => {
  it.each(CASES)("guards a name starting with %j", (lead, cellText) => {
    const csv = buildPointsCsv({
      ccaID: 1,
      ccaName: "Test CCA",
      entries: [entry(`${lead}x`)],
      exportedAt: AT,
    });
    expect(csv).toContain(`,A9900001Z,${cellText},`);
  });

  it.each(CASES)("guards a CCA name starting with %j", (lead, cellText) => {
    const csv = buildPointsCsv({
      ccaID: 1,
      ccaName: `${lead}x`,
      entries: [entry("Test Member")],
      exportedAt: AT,
    });
    expect(csv).toContain(`1,${cellText},A9900001Z,`);
  });
});

describe("formula guard on the flat-points export", () => {
  const flat = (ccaName: string, name: string) =>
    buildFlatPointsCsv({
      ccas: [
        {
          ccaID: 9001,
          ccaName,
          flatPoints: 12,
          members: [{ matric: "A9900001Z", name }],
        },
      ],
      exportedAt: AT,
    });

  it.each(CASES)("guards a name starting with %j", (lead, cellText) => {
    expect(flat("Test CCA", `${lead}x`)).toContain(
      `,A9900001Z,${cellText},12,`,
    );
  });

  it.each(CASES)("guards a CCA name starting with %j", (lead, cellText) => {
    expect(flat(`${lead}x`, "Test Member")).toContain(
      `1,9001,${cellText},A9900001Z,`,
    );
  });
});
