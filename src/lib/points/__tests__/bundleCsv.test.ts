import { describe, expect, it } from "vitest";

import {
  BUNDLE_EXPORT_HEADER,
  BUNDLE_SECTIONS,
  buildBundleCsv,
  bundleCsvFilename,
  bundleGaps,
  type BundleCca,
} from "~/lib/points/bundleCsv";
import type { Range } from "~/lib/points/constants";
import type { FlatCsvCca } from "~/lib/points/flatCsv";
import type { SettingsWaiver } from "~/lib/points/settingsCsv";

const AT = new Date("2027-04-01T09:30:00.000Z");
const STAMP = "2027-04-01T09:30:00.000Z";

const DEFAULT_RANGE: Range = { meanMin: 10, meanMax: 14, sdMin: 2, sdMax: 5 };

const WAIVERS: SettingsWaiver[] = [
  {
    ccaID: 9101,
    ccaName: "Drama, Film & Theatre",
    meanMin: 12,
    meanMax: 15,
    sdMin: 1.5,
    sdMax: 5,
    note: "Small CCA (<10 members)",
  },
];

const cca = (
  ccaID: number,
  ccaName: string,
  rest: Partial<BundleCca> = {},
): BundleCca => ({
  ccaID,
  ccaName,
  flatPoints: null,
  type: null,
  isSport: false,
  ihgResult: null,
  ihgCap: null,
  ...rest,
});

// Given in the order 9202, 9101, 9001, 9201, 9002: the builder sorts.
const CCAS: BundleCca[] = [
  cca(9202, "Touch Rugby (W)", { type: "1x", isSport: true }),
  cca(9101, "Drama, Film & Theatre", { type: "1x" }),
  cca(9001, "Hall Choir", { flatPoints: 12, type: "1x" }),
  cca(9201, "Soccer (M)", {
    type: "1x",
    isSport: true,
    ihgResult: "1st",
    ihgCap: 12,
  }),
  cca(9002, "=Dance, Crew", { flatPoints: 7.5 }),
];

const FLAT: FlatCsvCca[] = [
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

const build = (over: Partial<Parameters<typeof buildBundleCsv>[0]> = {}) =>
  buildBundleCsv({
    defaultRange: DEFAULT_RANGE,
    waivers: WAIVERS,
    ccas: CCAS,
    flat: FLAT,
    exportedAt: AT,
    ...over,
  });

/** A tiny RFC 4180 splitter: records, then cells, honouring quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
      i++;
    } else cur += ch;
  }
  return rows;
}

const FIXTURE =
  [
    "formatVersion,section,scope,ccaID,ccaName,matric,name,flatPoints,type,sport,ihgResult,ihgCap,meanMin,meanMax,sdMin,sdMax,note,exportedAt",
    `1,settings,default,,,,,,,,,,10,14,2,5,,${STAMP}`,
    `1,settings,waiver,9101,"Drama, Film & Theatre",,,,,,,,12,15,1.5,5,Small CCA (<10 members),${STAMP}`,
    `1,cca,,9001,Hall Choir,,,12,1x,N,,,,,,,,${STAMP}`,
    `1,cca,,9002,"'=Dance, Crew",,,7.5,,N,,,,,,,,${STAMP}`,
    `1,cca,,9101,"Drama, Film & Theatre",,,,1x,N,,,,,,,,${STAMP}`,
    `1,cca,,9201,Soccer (M),,,,1x,Y,1st,12,,,,,,${STAMP}`,
    `1,cca,,9202,Touch Rugby (W),,,,1x,Y,,,,,,,,${STAMP}`,
    `1,flat,,9001,Hall Choir,A9910101X,"Tan, Test 01",12,,,,,,,,,,${STAMP}`,
    `1,flat,,9001,Hall Choir,A9910102X,Test Member 02,12,,,,,,,,,,${STAMP}`,
    `1,flat,,9002,"'=Dance, Crew",A9910103X,'@Test 03,7.5,,,,,,,,,,${STAMP}`,
  ].join("\r\n") + "\r\n";

describe("buildBundleCsv", () => {
  it("writes the pinned 11-line fixture byte for byte", () => {
    expect(build()).toBe(FIXTURE);
  });

  it("has an 18-name header and the three sections", () => {
    expect(BUNDLE_EXPORT_HEADER).toHaveLength(18);
    expect(BUNDLE_SECTIONS).toEqual(["settings", "cca", "flat"]);
  });

  it("fills a waiver's blank fields from the default", () => {
    const csv = build({
      waivers: [
        {
          ccaID: 9101,
          ccaName: "Drama",
          meanMin: null,
          meanMax: 15,
          sdMin: null,
          sdMax: null,
          note: null,
        },
      ],
    });
    expect(csv).toContain(
      `1,settings,waiver,9101,Drama,,,,,,,,10,15,2,5,,${STAMP}`,
    );
  });

  it("sorts ccas and flat groups by ccaID and keeps member order", () => {
    const csv = build({ flat: [...FLAT].reverse() });
    const rows = parseCsv(csv);
    const ccaIds = rows.filter((r) => r[1] === "cca").map((r) => r[3]);
    expect(ccaIds).toEqual(["9001", "9002", "9101", "9201", "9202"]);
    const flatMatrics = rows.filter((r) => r[1] === "flat").map((r) => r[5]);
    expect(flatMatrics).toEqual(["A9910101X", "A9910102X", "A9910103X"]);
  });

  it("throws on a bad matric", () => {
    const bad: FlatCsvCca[] = [
      {
        ccaID: 9001,
        ccaName: "Hall Choir",
        flatPoints: 12,
        members: [{ matric: "nope", name: "X" }],
      },
    ];
    expect(() => build({ flat: bad })).toThrow(/matric/);
  });

  it("guards only ccaName, name and note", () => {
    const csv = build({
      waivers: [
        {
          ccaID: 9101,
          ccaName: "=w",
          meanMin: null,
          meanMax: null,
          sdMin: null,
          sdMax: null,
          note: "+n",
        },
      ],
      ccas: [cca(9001, "-c", { flatPoints: 1, type: "1x" })],
      flat: [
        {
          ccaID: 9001,
          ccaName: "-c",
          flatPoints: 1,
          members: [{ matric: "A9910101X", name: "@m" }],
        },
      ],
    });
    expect(csv).toContain(",9101,'=w,");
    expect(csv).toContain(",'+n,");
    expect(csv).toContain(",9001,'-c,");
    expect(csv).toContain(",A9910101X,'@m,1,");
  });

  it("writes sport Y/N only on cca rows", () => {
    const rows = parseCsv(build());
    for (const r of rows.slice(1)) {
      if (r[1] === "cca") expect(["Y", "N"]).toContain(r[9]);
      else expect(r[9]).toBe("");
    }
  });

  it("writes blank IHG cells when isSport is false, even if values are given", () => {
    const csv = build({
      ccas: [
        cca(9301, "Chess", {
          type: "1x",
          isSport: false,
          ihgResult: "2nd",
          ihgCap: 5,
        }),
      ],
      flat: [],
      waivers: [],
    });
    expect(csv).toContain(`1,cca,,9301,Chess,,,,1x,N,,,,,,,,${STAMP}`);
  });

  it("does not mutate frozen inputs", () => {
    const frozenCcas = Object.freeze(CCAS.map((c) => Object.freeze({ ...c })));
    const frozenFlat = Object.freeze(
      FLAT.map((f) =>
        Object.freeze({
          ...f,
          members: Object.freeze(f.members.map((m) => Object.freeze({ ...m }))),
        }),
      ),
    );
    const frozenWaivers = Object.freeze(
      WAIVERS.map((w) => Object.freeze({ ...w })),
    );
    expect(() =>
      build({
        ccas: frozenCcas,
        flat: frozenFlat,
        waivers: frozenWaivers,
        defaultRange: Object.freeze({ ...DEFAULT_RANGE }),
      }),
    ).not.toThrow();
    expect(frozenCcas.map((c) => c.ccaID)).toEqual([
      9202, 9101, 9001, 9201, 9002,
    ]);
  });

  it("has 18 cells on every line", () => {
    for (const r of parseCsv(build())) expect(r).toHaveLength(18);
  });
});

describe("bundleCsvFilename", () => {
  it("uses the local date", () => {
    expect(bundleCsvFilename(new Date(2027, 3, 1, 23, 59))).toBe(
      "points_bundle_20270401.csv",
    );
  });
});

describe("bundleGaps", () => {
  it("lists the sport with no result or cap", () => {
    expect(bundleGaps(CCAS)).toEqual({ type: [], ihg: [9202] });
  });

  it("lists a non-flat CCA with no type", () => {
    const ccas = CCAS.map((c) => (c.ccaID === 9101 ? { ...c, type: null } : c));
    expect(bundleGaps(ccas)).toEqual({ type: [9101], ihg: [9202] });
  });

  it("never lists a flat CCA", () => {
    const g = bundleGaps(CCAS);
    expect(g.type).not.toContain(9002);
    expect(g.ihg).not.toContain(9002);
  });

  it("lists a sport with a result but no cap, in ccaID order", () => {
    const ccas = [
      cca(9300, "B", {
        type: "1x",
        isSport: true,
        ihgResult: "1st",
        ihgCap: null,
      }),
      cca(9200, "A", { type: "1x", isSport: true }),
    ];
    expect(bundleGaps(ccas)).toEqual({ type: [], ihg: [9200, 9300] });
  });
});
