import { describe, expect, it } from "vitest";

import {
  buildFlatPointsCsv,
  flatExportBlockers,
  flatPointsCsvFilename,
  type FlatExportCca,
} from "~/lib/points/flatCsv";

const EXPORTED_AT = new Date("2027-04-01T09:30:15.123Z");

const ccas = [
  {
    ccaID: 9001,
    ccaName: "Hall Choir",
    flatPoints: 12,
    members: [
      { matric: "a9910101x", name: "Tan, Test 01" },
      { matric: "A9910102X", name: "Test Member 02" },
    ],
  },
  {
    ccaID: 9002,
    ccaName: "=Dance, Crew",
    flatPoints: 7.5,
    members: [{ matric: "A9910103X", name: "@Test 03" }],
  },
];

describe("buildFlatPointsCsv", () => {
  it("writes the exact format the sandbox reads (CRLF, quoting, guard, uppercase matric)", () => {
    const expected = [
      "formatVersion,ccaID,ccaName,matric,name,flatPoints,exportedAt",
      '1,9001,Hall Choir,A9910101X,"Tan, Test 01",12,2027-04-01T09:30:15.123Z',
      "1,9001,Hall Choir,A9910102X,Test Member 02,12,2027-04-01T09:30:15.123Z",
      "1,9002,\"'=Dance, Crew\",A9910103X,'@Test 03,7.5,2027-04-01T09:30:15.123Z",
      "",
    ].join("\r\n");
    expect(buildFlatPointsCsv({ ccas, exportedAt: EXPORTED_AT })).toBe(
      expected,
    );
  });

  it("uses the same exportedAt on every row", () => {
    const lines = buildFlatPointsCsv({ ccas, exportedAt: EXPORTED_AT })
      .trim()
      .split("\r\n")
      .slice(1);
    expect(
      new Set(lines.map((l) => l.slice(l.lastIndexOf(",") + 1))).size,
    ).toBe(1);
  });

  it("prints plain numbers with no trailing zeros", () => {
    const csv = buildFlatPointsCsv({
      ccas: [
        { ...ccas[0]!, flatPoints: 10.0, members: [ccas[0]!.members[0]!] },
        { ...ccas[1]!, flatPoints: 7.5, members: [ccas[1]!.members[0]!] },
        { ...ccas[1]!, ccaID: 9003, flatPoints: 0.25 },
      ],
      exportedAt: EXPORTED_AT,
    });
    const values = csv
      .trim()
      .split("\r\n")
      .slice(1)
      .map((l) => l.split(",").at(-2));
    expect(values).toEqual(["10", "7.5", "0.25"]);
  });

  it("writes only the header for no CCAs", () => {
    expect(buildFlatPointsCsv({ ccas: [], exportedAt: EXPORTED_AT })).toBe(
      "formatVersion,ccaID,ccaName,matric,name,flatPoints,exportedAt\r\n",
    );
  });

  it("refuses a member with a bad matric instead of writing a bad file", () => {
    expect(() =>
      buildFlatPointsCsv({
        ccas: [{ ...ccas[0]!, members: [{ matric: "XYZ", name: "n" }] }],
        exportedAt: EXPORTED_AT,
      }),
    ).toThrow();
  });
});

describe("flatPointsCsvFilename", () => {
  it("is flat_points_<YYYYMMDD>.csv in local time", () => {
    expect(flatPointsCsvFilename(new Date(2027, 3, 1, 23, 59))).toBe(
      "flat_points_20270401.csv",
    );
    expect(flatPointsCsvFilename(new Date(2027, 11, 9, 0, 1))).toBe(
      "flat_points_20271209.csv",
    );
  });
});

type Member = FlatExportCca["members"][number];
const member = (patch: Partial<Member> = {}): Member => ({
  rowKey: "u:1",
  matric: "A9910101X",
  name: "Test",
  resolved: true,
  ...patch,
});
const cca = (
  ccaName: string,
  members: Member[],
  ccaID = 9001,
): FlatExportCca => ({
  ccaID,
  ccaName,
  flatPoints: 12,
  members,
});

describe("flatExportBlockers", () => {
  it("has no blockers when every member has a valid matric", () => {
    const result = flatExportBlockers([
      cca("Hall Choir", [
        member(),
        member({ rowKey: "u:2", matric: "a9910102x" }),
      ]),
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.totalRows).toBe(2);
    expect(result.ccaCount).toBe(1);
  });

  it("groups members with no matric per CCA, with a count and plain English", () => {
    const result = flatExportBlockers([
      cca("Hall Choir", [
        member(),
        member({ rowKey: "u:2", matric: null }),
        member({ rowKey: "u:3", matric: null }),
      ]),
    ]);
    expect(result.blockers).toEqual([
      {
        ccaID: 9001,
        ccaName: "Hall Choir",
        code: "NO_MATRIC",
        count: 2,
        message:
          "Hall Choir: 2 members have no matric on record — ask them to add it in their RHApp profile, or fix the roster",
      },
    ]);
  });

  it("uses the singular for one member", () => {
    const [blocker] = flatExportBlockers([
      cca("Hall Choir", [member({ matric: null })]),
    ]).blockers;
    expect(blocker?.message).toBe(
      "Hall Choir: 1 member has no matric on record — ask them to add it in their RHApp profile, or fix the roster",
    );
  });

  it("flags an invalid matric and an unresolved entry separately", () => {
    const result = flatExportBlockers([
      cca("Hall Choir", [
        member({ matric: "12345" }),
        member({ rowKey: "k:x", matric: null, name: null, resolved: false }),
      ]),
    ]);
    expect(result.blockers.map((b) => [b.code, b.count])).toEqual([
      ["UNRESOLVED", 1],
      ["BAD_MATRIC", 1],
    ]);
    expect(result.blockers[0]?.message).toMatch(/not matched to an account/);
  });

  it("flags the same matric twice in one CCA", () => {
    const result = flatExportBlockers([
      cca("Hall Choir", [member(), member({ rowKey: "u:2" })]),
    ]);
    expect(result.blockers.map((b) => [b.code, b.count])).toEqual([
      ["DUPLICATE_MATRIC", 1],
    ]);
  });

  it("allows the same person in two different flat CCAs", () => {
    const result = flatExportBlockers([
      cca("Hall Choir", [member()], 9001),
      cca("Dance Crew", [member()], 9002),
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.totalRows).toBe(2);
  });

  it("warns, without blocking, about a flat CCA with no members", () => {
    const result = flatExportBlockers([cca("Hall Choir", [])]);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([
      {
        ccaID: 9001,
        ccaName: "Hall Choir",
        message: "Hall Choir has no members, so it adds no rows to the file",
      },
    ]);
  });

  it("does not count blocked rows in totalRows semantics: it counts every member", () => {
    expect(
      flatExportBlockers([cca("Hall Choir", [member({ matric: null })])])
        .totalRows,
    ).toBe(1);
  });
});
