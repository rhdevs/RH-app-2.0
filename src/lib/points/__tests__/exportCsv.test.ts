import { describe, expect, it } from "vitest";

import { EXPORT_FORMAT_VERSION } from "~/lib/points/constants";
import { withoutStaleIhg, type PointsEntry } from "~/lib/points/entries";
import { buildPointsCsv, pointsCsvFilename } from "~/lib/points/exportCsv";

const HEADER =
  "formatVersion,ccaID,ccaName,matric,name,basePoints,semesterOnly,outgoingRole,incomingRole,ihg,exportedAt";

function entry(patch: Partial<PointsEntry>): PointsEntry {
  return {
    rowKey: "u:1",
    matric: "A9900001Z",
    name: "Test Member 001",
    resolved: true,
    basePoints: 12,
    semesterOnly: false,
    outgoingRole: "none",
    incomingRole: "none",
    ihg: false,
    ...patch,
  };
}

const exportedAt = new Date("2027-04-01T09:30:00.000Z");

describe("buildPointsCsv", () => {
  it("writes the exact expected file, including a quoted name with a comma", () => {
    const csv = buildPointsCsv({
      ccaID: 12,
      ccaName: "Test CCA, The Best",
      exportedAt,
      entries: [
        entry({}),
        entry({
          rowKey: "u:2",
          matric: "A9900002Z",
          name: 'Lim, "Ah" Kow',
          basePoints: 20,
          semesterOnly: true,
          outgoingRole: "head",
          incomingRole: "vice_head",
          ihg: true,
        }),
      ],
    });
    expect(csv).toBe(
      [
        HEADER,
        '2,12,"Test CCA, The Best",A9900001Z,Test Member 001,12,N,none,none,N,2027-04-01T09:30:00.000Z',
        '2,12,"Test CCA, The Best",A9900002Z,"Lim, ""Ah"" Kow",20,Y,head,vice_head,Y,2027-04-01T09:30:00.000Z',
      ].join("\r\n") + "\r\n",
    );
  });

  it("uses CRLF line endings only", () => {
    const csv = buildPointsCsv({
      ccaID: 1,
      ccaName: "A",
      entries: [entry({})],
      exportedAt,
    });
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("states the format version from constants", () => {
    expect(EXPORT_FORMAT_VERSION).toBe(2);
    const csv = buildPointsCsv({
      ccaID: 1,
      ccaName: "A",
      entries: [entry({})],
      exportedAt,
    });
    expect(csv.split("\r\n")[1]?.startsWith("2,1,")).toBe(true);
  });

  it("neutralises formulas in the name and CCA name only", () => {
    const csv = buildPointsCsv({
      ccaID: 3,
      ccaName: '=HYPERLINK("x")',
      entries: [entry({ name: "+SUM(A1)" })],
      exportedAt,
    });
    const line = csv.split("\r\n")[1] ?? "";
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain("'+SUM(A1)");
    expect(line).toContain(",A9900001Z,");
  });

  it("upper-cases the matric", () => {
    const csv = buildPointsCsv({
      ccaID: 1,
      ccaName: "A",
      entries: [entry({ matric: "a9900001z" })],
      exportedAt,
    });
    expect(csv.split("\r\n")[1]).toContain(",A9900001Z,");
  });

  it("refuses a malformed matric", () => {
    expect(() =>
      buildPointsCsv({
        ccaID: 1,
        ccaName: "A",
        entries: [entry({ matric: "X123" })],
        exportedAt,
      }),
    ).toThrow(/matric/);
  });

  it("writes an empty name as an empty cell", () => {
    const csv = buildPointsCsv({
      ccaID: 1,
      ccaName: "A",
      entries: [entry({ name: null })],
      exportedAt,
    });
    expect(csv.split("\r\n")[1]).toContain("A9900001Z,,12,");
  });

  it("refuses an entry that is not exportable", () => {
    const build = (e: PointsEntry): string =>
      buildPointsCsv({ ccaID: 1, ccaName: "A", entries: [e], exportedAt });
    expect(() => build(entry({ matric: null }))).toThrow(/matric/);
    expect(() => build(entry({ basePoints: null }))).toThrow(/score/);
    expect(() => build(entry({ resolved: false }))).toThrow(/roster/);
  });

  it("does not mutate its input", () => {
    const frozen = Object.freeze([Object.freeze(entry({}))]);
    expect(() =>
      buildPointsCsv({ ccaID: 1, ccaName: "A", entries: frozen, exportedAt }),
    ).not.toThrow();
  });
});

describe("shared leader-CSV contract (formatVersion 2)", () => {
  // The sandbox pins this same string. Change both repos together.
  it("writes the pinned fixture byte for byte", () => {
    const csv = buildPointsCsv({
      ccaID: 9201,
      ccaName: "Soccer (M)",
      exportedAt,
      entries: [
        entry({
          rowKey: "u:1",
          matric: "A9920101X",
          name: "Test Player 01",
          basePoints: 15,
          outgoingRole: "head",
          ihg: true,
        }),
        entry({
          rowKey: "u:2",
          matric: "a9920102x",
          name: 'Lim, "Ah" Kow',
          basePoints: 12,
          semesterOnly: true,
          incomingRole: "vice_head",
          ihg: true,
        }),
        entry({
          rowKey: "u:3",
          matric: "A9920103X",
          name: "Test Player 03",
          basePoints: 9,
          ihg: false,
        }),
      ],
    });
    expect(csv).toBe(
      "formatVersion,ccaID,ccaName,matric,name,basePoints,semesterOnly,outgoingRole,incomingRole,ihg,exportedAt\r\n" +
        "2,9201,Soccer (M),A9920101X,Test Player 01,15,N,head,none,Y,2027-04-01T09:30:00.000Z\r\n" +
        '2,9201,Soccer (M),A9920102X,"Lim, ""Ah"" Kow",12,Y,none,vice_head,Y,2027-04-01T09:30:00.000Z\r\n' +
        "2,9201,Soccer (M),A9920103X,Test Player 03,9,N,none,none,N,2027-04-01T09:30:00.000Z\r\n",
    );
  });
});

describe("pointsCsvFilename", () => {
  it("is points_<ccaID>_<YYYYMMDD>.csv in local time", () => {
    expect(pointsCsvFilename(12, new Date(2027, 3, 1, 23, 59))).toBe(
      "points_12_20270401.csv",
    );
    expect(pointsCsvFilename(7, new Date(2027, 11, 9, 0, 0))).toBe(
      "points_7_20271209.csv",
    );
  });
});

describe("buildPointsCsv with a stale IHG tick", () => {
  it("writes N when the live IHG context is null", () => {
    const { entries } = withoutStaleIhg([entry({ ihg: true })], null);
    const csv = buildPointsCsv({ ccaID: 1, ccaName: "X", entries, exportedAt });
    const row = csv.split("\n")[1] ?? "";
    expect(row.split(",")[9]).toBe("N");
  });
});
