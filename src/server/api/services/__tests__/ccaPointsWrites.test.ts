import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  CCA_TYPES,
  IHG_CAP_MAX,
  IHG_CAP_MIN,
  IHG_RESULTS,
  isCcaType,
  isIhgResult,
  isSportsCategory,
  isValidIhgCap,
} from "~/lib/points/constants";
import { AUDIT_ACTIONS } from "~/server/api/services/roles";
import {
  brokenWaiversMessage,
  clearFlat,
  effectiveIsSport,
  flatExportReason,
  ihgReason,
  isIhgComplete,
  isIhgRow,
  isTypeRow,
  newYearReason,
  removeOverride,
  resolveRange,
  sportReason,
  sportsMissingIhg,
  startNewPointsYear,
  typeReason,
  waiversBrokenByDefault,
  writeFlat,
  writeIhg,
  writeOverride,
  writeSport,
  writeType,
  type ConfigRowLike,
} from "~/server/api/services/ccaPointsConfig";

/* ------------------------------ F1: waivers ------------------------------ */

type WaiverRow = ConfigRowLike & { ccaID: number | null };
const waiver = (patch: Partial<WaiverRow> = {}): WaiverRow => ({
  ccaID: 1,
  meanMin: null,
  meanMax: null,
  sdMin: null,
  sdMax: null,
  note: "performing group",
  flatPoints: null,
  ccaType: null,
  ihgResult: null,
  ihgCap: null,
  isSport: null,
  ...patch,
});
const DEFAULT = { meanMin: 10, meanMax: 14, sdMin: 2, sdMax: 5 };

describe("waiversBrokenByDefault", () => {
  it("catches a waiver with only meanMin 13 when the new default max is 12", () => {
    const rows = [waiver({ meanMin: 13 })];
    expect(waiversBrokenByDefault(rows, { ...DEFAULT, meanMax: 12 })).toEqual([
      { ccaID: 1, problem: "average 13–12" },
    ]);
  });

  it("leaves a waiver that sets both ends alone", () => {
    const rows = [waiver({ meanMin: 13, meanMax: 16 })];
    expect(waiversBrokenByDefault(rows, { ...DEFAULT, meanMax: 12 })).toEqual(
      [],
    );
  });

  it("names the spread part, and both parts when both break", () => {
    const rows = [
      waiver({ ccaID: 2, sdMin: 6 }),
      waiver({ ccaID: 3, meanMin: 13, sdMin: 4.5 }),
    ];
    expect(
      waiversBrokenByDefault(rows, {
        ...DEFAULT,
        meanMax: 12,
        sdMax: 4,
      }),
    ).toEqual([
      { ccaID: 2, problem: "spread 6–4" },
      { ccaID: 3, problem: "average 13–12 and spread 4.5–4" },
    ]);
  });

  it("lists every broken CCA, in the order given", () => {
    const rows = [
      waiver({ ccaID: 5, meanMin: 13 }),
      waiver({ ccaID: 6, meanMin: 11 }),
      waiver({ ccaID: 7, meanMin: 15 }),
    ];
    expect(
      waiversBrokenByDefault(rows, { ...DEFAULT, meanMax: 12 }).map(
        (b) => b.ccaID,
      ),
    ).toEqual([5, 7]);
  });

  it("checks a waiver that sits on a flat CCA too, but not a flat-only row", () => {
    const rows = [
      waiver({ ccaID: 8, meanMin: 13, flatPoints: 10 }),
      waiver({ ccaID: 9, note: null, flatPoints: 10 }),
    ];
    expect(
      waiversBrokenByDefault(rows, { ...DEFAULT, meanMax: 12 }).map(
        (b) => b.ccaID,
      ),
    ).toEqual([8]);
  });

  it("passes when there are no waivers", () => {
    expect(waiversBrokenByDefault([], DEFAULT)).toEqual([]);
  });

  it("skips a row with no ccaID", () => {
    expect(
      waiversBrokenByDefault([waiver({ ccaID: null, meanMin: 13 })], {
        ...DEFAULT,
        meanMax: 12,
      }),
    ).toEqual([]);
  });
});

describe("brokenWaiversMessage", () => {
  it("uses the exact sentence for one CCA", () => {
    expect(
      brokenWaiversMessage([
        { ccaName: "Hall Choir", problem: "average 13–12" },
      ]),
    ).toBe(
      "This would make Hall Choir's waiver impossible (average 13–12). Edit that waiver first.",
    );
  });

  it("lists several CCAs comma-separated with their broken parts", () => {
    expect(
      brokenWaiversMessage([
        { ccaName: "Hall Choir", problem: "average 13–12" },
        { ccaName: "Dance", problem: "spread 6–4" },
      ]),
    ).toBe(
      "This would make these waivers impossible: Hall Choir (average 13–12), Dance (spread 6–4). Edit those waivers first.",
    );
  });
});

/* ----------------------- F7: audit action and reason ---------------------- */

describe("flat export audit", () => {
  it("registers ccaPoints.flat.export within the 32-character filter cap", () => {
    expect(AUDIT_ACTIONS).toContain("ccaPoints.flat.export");
    for (const a of AUDIT_ACTIONS.filter((x) => x.startsWith("ccaPoints."))) {
      expect(a.length).toBeLessThanOrEqual(32);
    }
  });

  it("builds a reason from counts only", () => {
    expect(flatExportReason(3, 41)).toBe("3 CCA(s), 41 member(s)");
    expect(flatExportReason(0, 0)).toBe("0 CCA(s), 0 member(s)");
  });

  it("cannot carry a matric or a name: it only takes numbers", () => {
    const reason = flatExportReason(2, 7);
    expect(reason).not.toMatch(/[A-Za-z]\d{7}[A-Za-z]/);
    expect(reason).toMatch(/^\d+ CCA\(s\), \d+ member\(s\)$/);
  });
});

/* ------------------------ F19: atomic removal ----------------------------- */

type Row = Record<string, unknown>;

/** Mimics Prisma+MongoDB strictness: `null` matches an explicit null only, `isSet` tells unset. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
    if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
    const v = row[key];
    if (cond === null) return v === null;
    if (typeof cond === "object") {
      const c = cond as { isSet?: boolean; not?: null; startsWith?: string };
      if (c.startsWith !== undefined)
        return typeof v === "string" && v.startsWith(c.startsWith);
      if (c.isSet !== undefined) return (v !== undefined) === c.isSet;
      if ("not" in c) return v !== null && v !== undefined;
    }
    return v === cond;
  });
}

function fakeDb(
  rows: Row[],
  hooks: { beforeDelete?: (rows: Row[]) => void } = {},
) {
  const calls: string[] = [];
  const db = {
    ccaPointsConfig: {
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { scope: string };
        create: Row;
        update: Row;
      }) => {
        calls.push("upsert");
        const row = rows.find((r) => r.scope === where.scope);
        if (row) Object.assign(row, update);
        else rows.push({ ...create });
        return Promise.resolve(row ?? create);
      },
      deleteMany: ({ where }: { where: Row }) => {
        calls.push("deleteMany");
        hooks.beforeDelete?.(rows);
        const keep = rows.filter((r) => !matches(r, where));
        const count = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return Promise.resolve({ count });
      },
      updateMany: ({ where, data }: { where: Row; data: Row }) => {
        calls.push("updateMany");
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return Promise.resolve({ count: hit.length });
      },
    },
  };
  return { db: db as unknown as PrismaClient, rows, calls };
}

const SCOPE = "cca:7";

describe("removeOverride (waiver removal)", () => {
  it("deletes a waiver-only row", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, meanMin: 8, note: "x" }]);
    expect(await removeOverride(db, 7)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("keeps the flat marking when a flat + waiver row's waiver is cleared", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, meanMin: 8, note: "x", flatPoints: 10 },
    ]);
    expect(await removeOverride(db, 7)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flatPoints: 10,
      meanMin: null,
      meanMax: null,
      sdMin: null,
      sdMax: null,
      note: null,
    });
  });

  it("reports false and changes nothing for a flat-only row", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, flatPoints: 10 }]);
    expect(await removeOverride(db, 7)).toBe(false);
    expect(rows).toEqual([{ scope: SCOPE, flatPoints: 10 }]);
  });

  it("reports false when there is no row", async () => {
    const { db } = fakeDb([]);
    expect(await removeOverride(db, 7)).toBe(false);
  });

  it("does not wipe a flat marking set after the request began", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, meanMin: 8, note: "x" }], {
      beforeDelete: (r) => {
        r[0]!.flatPoints = 12; // a concurrent setFlat lands first
      },
    });
    expect(await removeOverride(db, 7)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flatPoints: 12,
      meanMin: null,
      note: null,
    });
  });
});

describe("clearFlat", () => {
  it("deletes a flat-only row", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, flatPoints: 10 }]);
    expect(await clearFlat(db, 7)).toBe(true);
    expect(rows).toEqual([]);
  });

  it("keeps the waiver when a flat + waiver row's flat marking is cleared", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, meanMin: 8, note: "x", flatPoints: 10 },
    ]);
    expect(await clearFlat(db, 7)).toBe(true);
    expect(rows).toEqual([
      { scope: SCOPE, meanMin: 8, note: "x", flatPoints: null },
    ]);
  });

  it("reports false and changes nothing for a waiver-only row", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, meanMin: 8, note: "x" }]);
    expect(await clearFlat(db, 7)).toBe(false);
    expect(rows).toEqual([{ scope: SCOPE, meanMin: 8, note: "x" }]);
  });

  it("reports false when there is nothing at all", async () => {
    const { db, calls } = fakeDb([]);
    expect(await clearFlat(db, 7)).toBe(false);
    expect(calls).toEqual(["deleteMany", "updateMany", "deleteMany"]);
  });

  it("does not wipe a waiver written after the request began", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, flatPoints: 10 }], {
      beforeDelete: (r) => {
        r[0]!.note = "late waiver"; // a concurrent setOverride lands first
        r[0]!.meanMin = 9;
      },
    });
    expect(await clearFlat(db, 7)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flatPoints: null,
      note: "late waiver",
      meanMin: 9,
    });
  });
});

describe("removing both halves concurrently (F30)", () => {
  const both = () => [
    {
      scope: SCOPE,
      meanMin: 8,
      note: "x",
      flatPoints: 10,
    },
  ];

  it("leaves no empty row when the waiver and the flat marking are cleared at once", async () => {
    const { db, rows } = fakeDb(both());
    const [waiverCleared, flatCleared] = await Promise.all([
      removeOverride(db, 7),
      clearFlat(db, 7),
    ]);
    expect(waiverCleared).toBe(true);
    expect(flatCleared).toBe(true);
    expect(rows).toEqual([]);
  });

  it("leaves no empty row in the other order either", async () => {
    const { db, rows } = fakeDb(both());
    const [flatCleared, waiverCleared] = await Promise.all([
      clearFlat(db, 7),
      removeOverride(db, 7),
    ]);
    expect([flatCleared, waiverCleared]).toEqual([true, true]);
    expect(rows).toEqual([]);
  });

  it("still keeps a half that nobody removed", async () => {
    const { db, rows } = fakeDb(both());
    await removeOverride(db, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ flatPoints: 10, note: null });
  });
});

describe("the two halves of a per-CCA row do not overwrite each other (F13)", () => {
  const NOW = new Date("2027-04-01T00:00:00.000Z");

  it("setFlat on an existing waiver row keeps the waiver fields", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, meanMin: 8, meanMax: 15, note: "choir waiver" },
    ]);
    await writeFlat(db, 7, 12, "E1", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flatPoints: 12,
      meanMin: 8,
      meanMax: 15,
      note: "choir waiver",
    });
  });

  it("setOverride on a flat row keeps flatPoints", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, flatPoints: 12 }]);
    await writeOverride(
      db,
      7,
      { meanMin: 9, meanMax: null, sdMin: null, sdMax: null, note: "why" },
      "E1",
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ flatPoints: 12, meanMin: 9, note: "why" });
  });

  it("resolves the range of a row that is both flat and waived from the waiver", () => {
    const row = {
      meanMin: 12,
      meanMax: null,
      sdMin: null,
      sdMax: 4,
      note: "w",
      flatPoints: 10,
    };
    const resolved = resolveRange(
      { meanMin: 10, meanMax: 14, sdMin: 2, sdMax: 5 },
      row,
    );
    expect(resolved.range).toEqual({
      meanMin: 12,
      meanMax: 14,
      sdMin: 2,
      sdMax: 4,
    });
    expect(resolved.isWaived).toBe(true);
    expect(resolved.waivedFields).toEqual(["meanMin", "sdMax"]);
  });
});

/* --------------- type, IHG and sport: constants and audit text ------------- */

describe("points constants for type, IHG and sport", () => {
  it("accepts only the two CCA types", () => {
    expect(CCA_TYPES).toEqual(["1x", "0.5x"]);
    expect(isCcaType("1x")).toBe(true);
    expect(isCcaType("0.5x")).toBe(true);
    expect(isCcaType("2x")).toBe(false);
    expect(isCcaType(null)).toBe(false);
  });

  it("accepts only the four IHG results", () => {
    expect(IHG_RESULTS).toEqual(["1st", "2nd", "3rd", "3rd4th_no_match"]);
    expect(isIhgResult("3rd4th_no_match")).toBe(true);
    expect(isIhgResult("4th")).toBe(false);
    expect(isIhgResult(undefined)).toBe(false);
  });

  it("accepts a whole-number cap from 1 to 99", () => {
    expect([IHG_CAP_MIN, IHG_CAP_MAX]).toEqual([1, 99]);
    expect(isValidIhgCap(1)).toBe(true);
    expect(isValidIhgCap(99)).toBe(true);
    for (const bad of [0, 100, 12.5, "12", null, undefined, NaN]) {
      expect(isValidIhgCap(bad)).toBe(false);
    }
  });

  it("matches the sports category exactly, ignoring surrounding spaces", () => {
    expect(isSportsCategory("Sports Activities")).toBe(true);
    expect(isSportsCategory("  Sports Activities ")).toBe(true);
    expect(isSportsCategory("Sports activities")).toBe(false);
    expect(isSportsCategory("Sports Teams")).toBe(false);
    expect(isSportsCategory(null)).toBe(false);
  });
});

describe("audit actions and reasons for type, IHG, sport and the new year", () => {
  it("registers the four actions within the 32-character filter cap", () => {
    for (const a of [
      "ccaPoints.type.set",
      "ccaPoints.ihg.set",
      "ccaPoints.sport.set",
      "ccaPoints.year.start",
    ]) {
      expect(AUDIT_ACTIONS).toContain(a);
    }
    for (const a of AUDIT_ACTIONS.filter((x) => x.startsWith("ccaPoints."))) {
      expect(a.length).toBeLessThanOrEqual(32);
    }
  });

  it("builds the type, IHG, new-year and sport reasons", () => {
    expect(typeReason("0.5x")).toBe("type 0.5x");
    expect(typeReason(null)).toBe("type blank");
    expect(ihgReason("1st", 12)).toBe("IHG 1st; cap 12");
    expect(ihgReason(null, 12)).toBe("IHG blank; cap 12");
    expect(ihgReason("2nd", null)).toBe("IHG 2nd; cap blank");
    expect(newYearReason(3)).toBe("3 IHG result(s) cleared; entry closed");
    expect(sportReason(true)).toBe("sport yes");
    expect(sportReason(false)).toBe("sport no");
    expect(sportReason(null)).toBe("sport default");
  });

  it("never carries a matric or a name", () => {
    const reasons = [
      typeReason("1x"),
      ihgReason("3rd4th_no_match", 99),
      newYearReason(0),
      sportReason(true),
    ];
    for (const r of reasons) expect(r).not.toMatch(/[A-Za-z]\d{7}[A-Za-z]/);
  });
});

/* ------------------------ effective sport and the gate --------------------- */

describe("effectiveIsSport (the only sports rule)", () => {
  it("uses JCRC's tick when there is one, either way", () => {
    expect(effectiveIsSport({ isSport: true }, "Performing Arts")).toBe(true);
    expect(effectiveIsSport({ isSport: true }, null)).toBe(true);
  });

  it("lets an explicit false beat a Sports Activities category", () => {
    expect(effectiveIsSport({ isSport: false }, "Sports Activities")).toBe(
      false,
    );
  });

  it("falls back to the category when the tick is null or there is no row", () => {
    expect(effectiveIsSport({ isSport: null }, "Sports Activities")).toBe(true);
    expect(effectiveIsSport(null, "Sports Activities")).toBe(true);
    expect(effectiveIsSport({ isSport: null }, "Committees")).toBe(false);
    expect(effectiveIsSport(null, null)).toBe(false);
  });
});

describe("row-part helpers", () => {
  it("isTypeRow is true only for a row with a type", () => {
    expect(isTypeRow(waiver({ ccaType: "1x" }))).toBe(true);
    expect(isTypeRow(waiver())).toBe(false);
    expect(isTypeRow(null)).toBe(false);
  });

  it("isIhgRow is true when either the result or the cap is set", () => {
    expect(isIhgRow(waiver({ ihgResult: "1st" }))).toBe(true);
    expect(isIhgRow(waiver({ ihgCap: 12 }))).toBe(true);
    expect(isIhgRow(waiver())).toBe(false);
    expect(isIhgRow(null)).toBe(false);
  });

  it("isIhgComplete needs a valid result AND a valid cap", () => {
    expect(isIhgComplete(waiver({ ihgResult: "1st", ihgCap: 12 }))).toBe(true);
    expect(isIhgComplete(waiver({ ihgResult: "1st" }))).toBe(false);
    expect(isIhgComplete(waiver({ ihgCap: 12 }))).toBe(false);
    expect(isIhgComplete(waiver({ ihgResult: "4th", ihgCap: 12 }))).toBe(false);
    expect(isIhgComplete(waiver({ ihgResult: "1st", ihgCap: 0 }))).toBe(false);
    expect(isIhgComplete(null)).toBe(false);
  });
});

describe("sportsMissingIhg (the entry-open gate)", () => {
  const cca = (ccaID: number, ccaName: string, category: string | null) => ({
    ccaID,
    ccaName,
    category,
  });
  const SPORT = "Sports Activities";

  it("names every non-flat sport that lacks a result or a cap, in the order given", () => {
    const ccas = [
      cca(1, "Soccer", SPORT),
      cca(2, "Choir", "Performing Arts"),
      cca(3, "Netball", SPORT),
      cca(4, "Chess", "Interest Groups"),
    ];
    const rows = [
      waiver({ ccaID: 1, note: null, ihgResult: "1st" }),
      waiver({ ccaID: 3, note: null, ihgResult: "2nd", ihgCap: 8 }),
      waiver({ ccaID: 4, note: null, isSport: true }),
    ];
    expect(sportsMissingIhg(ccas, rows)).toEqual(["Soccer", "Chess"]);
  });

  it("is empty when every sport has both", () => {
    const rows = [
      waiver({ ccaID: 1, note: null, ihgResult: "3rd", ihgCap: 5 }),
    ];
    expect(sportsMissingIhg([cca(1, "Soccer", SPORT)], rows)).toEqual([]);
  });

  it("ignores flat sports, JCRC-unticked sports and non-sports", () => {
    const ccas = [
      cca(1, "Tennis", SPORT),
      cca(2, "Golf", SPORT),
      cca(3, "Choir", "Performing Arts"),
    ];
    const rows = [
      waiver({ ccaID: 1, note: null, flatPoints: 10 }),
      waiver({ ccaID: 2, note: null, isSport: false }),
    ];
    expect(sportsMissingIhg(ccas, rows)).toEqual([]);
  });

  it("treats an invalid stored result or cap as missing", () => {
    const ccas = [cca(1, "Soccer", SPORT), cca(2, "Rugby", SPORT)];
    const rows = [
      waiver({ ccaID: 1, note: null, ihgResult: "4th", ihgCap: 5 }),
      waiver({ ccaID: 2, note: null, ihgResult: "1st", ihgCap: 0 }),
    ];
    expect(sportsMissingIhg(ccas, rows)).toEqual(["Soccer", "Rugby"]);
  });

  it("counts a sport with no per-CCA row at all as missing", () => {
    expect(sportsMissingIhg([cca(1, "Soccer", SPORT)], [])).toEqual(["Soccer"]);
  });
});

/* ---- R24: five independent parts; clearing one never deletes another ----- */

const OTHER_PARTS: [string, Row][] = [
  ["type", { ccaType: "1x" }],
  ["IHG result", { ihgResult: "1st" }],
  ["IHG cap", { ihgCap: 12 }],
  ["sport tick (yes)", { isSport: true }],
  ["sport tick (no)", { isSport: false }],
];

describe("clearing a waiver or a flat value keeps the other parts (R24)", () => {
  it.each(OTHER_PARTS)(
    "removeOverride on a waiver row that also holds a %s keeps the row and the part",
    async (_name, part) => {
      const { db, rows } = fakeDb([
        { scope: SCOPE, meanMin: 8, note: "x", ...part },
      ]);
      expect(await removeOverride(db, 7)).toBe(true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ meanMin: null, note: null, ...part });
    },
  );

  it.each(OTHER_PARTS)(
    "clearFlat on a flat row that also holds a %s keeps the row and the part",
    async (_name, part) => {
      const { db, rows } = fakeDb([{ scope: SCOPE, flatPoints: 10, ...part }]);
      expect(await clearFlat(db, 7)).toBe(true);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ flatPoints: null, ...part });
    },
  );

  it("removeOverride reports false and changes nothing for a type-only row", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, ccaType: "1x" }]);
    expect(await removeOverride(db, 7)).toBe(false);
    expect(rows).toEqual([{ scope: SCOPE, ccaType: "1x" }]);
  });

  it("clearing the waiver and the flat value at once keeps a row that has an IHG cap", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, meanMin: 8, note: "x", flatPoints: 10, ihgCap: 12 },
    ]);
    await Promise.all([removeOverride(db, 7), clearFlat(db, 7)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      flatPoints: null,
      meanMin: null,
      note: null,
      ihgCap: 12,
    });
  });
});

describe("writeType, writeIhg and writeSport (R24)", () => {
  const NOW = new Date("2027-04-01T00:00:00.000Z");

  it("writeType creates a per-CCA row with its scope and ccaID", async () => {
    const { db, rows } = fakeDb([]);
    await writeType(db, 7, "0.5x", "E1", NOW);
    expect(rows).toEqual([
      {
        scope: SCOPE,
        ccaID: 7,
        ccaType: "0.5x",
        updatedAt: NOW,
        updatedBy: "E1",
      },
    ]);
  });

  it("writeType on a flat + waiver row keeps both other parts", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, flatPoints: 10, meanMin: 8, note: "x" },
    ]);
    await writeType(db, 7, "1x", "E1", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ccaType: "1x",
      flatPoints: 10,
      meanMin: 8,
      note: "x",
    });
  });

  it("writeType(null) deletes a type-only row", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, ccaType: "1x" }]);
    await writeType(db, 7, null, "E1", NOW);
    expect(rows).toEqual([]);
  });

  it.each(OTHER_PARTS.filter(([name]) => name !== "type"))(
    "writeType(null) keeps a row that also holds a %s",
    async (_name, part) => {
      const { db, rows } = fakeDb([{ scope: SCOPE, ccaType: "1x", ...part }]);
      await writeType(db, 7, null, "E1", NOW);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ccaType: null, ...part });
    },
  );

  it("writeIhg stores the result and the cap together", async () => {
    const { db, rows } = fakeDb([{ scope: SCOPE, ccaType: "1x" }]);
    await writeIhg(db, 7, { ihgResult: "2nd", ihgCap: 12 }, "E1", NOW);
    expect(rows[0]).toMatchObject({
      ccaType: "1x",
      ihgResult: "2nd",
      ihgCap: 12,
      updatedBy: "E1",
    });
  });

  it("writeIhg(null, null) deletes an IHG-only row", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, ihgResult: "1st", ihgCap: 12 },
    ]);
    await writeIhg(db, 7, { ihgResult: null, ihgCap: null }, "E1", NOW);
    expect(rows).toEqual([]);
  });

  it("writeIhg(null, null) keeps the type on a type + IHG row", async () => {
    const { db, rows } = fakeDb([
      { scope: SCOPE, ccaType: "1x", ihgResult: "1st", ihgCap: 12 },
    ]);
    await writeIhg(db, 7, { ihgResult: null, ihgCap: null }, "E1", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ccaType: "1x",
      ihgResult: null,
      ihgCap: null,
    });
  });

  it("writeIhg(null, null) keeps the sport tick, the flat value and the waiver", async () => {
    const { db, rows } = fakeDb([
      {
        scope: SCOPE,
        ihgResult: "1st",
        ihgCap: 12,
        isSport: true,
        flatPoints: 10,
        meanMin: 8,
        note: "x",
      },
    ]);
    await writeIhg(db, 7, { ihgResult: null, ihgCap: null }, "E1", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      isSport: true,
      flatPoints: 10,
      meanMin: 8,
      note: "x",
    });
  });

  it("writeIhg with only a cap keeps the row", async () => {
    const { db, rows } = fakeDb([]);
    await writeIhg(db, 7, { ihgResult: null, ihgCap: 12 }, "E1", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ihgCap: 12 });
  });

  it("writeSport(true) and writeSport(false) both keep a row", async () => {
    const yes = fakeDb([]);
    await writeSport(yes.db, 7, true, "E1", NOW);
    expect(yes.rows[0]).toMatchObject({
      scope: SCOPE,
      ccaID: 7,
      isSport: true,
    });
    const no = fakeDb([]);
    await writeSport(no.db, 7, false, "E1", NOW);
    expect(no.rows[0]).toMatchObject({
      scope: SCOPE,
      ccaID: 7,
      isSport: false,
    });
  });

  it("writeSport(null) deletes a sport-only row but keeps any other part", async () => {
    const only = fakeDb([{ scope: SCOPE, isSport: true }]);
    await writeSport(only.db, 7, null, "E1", NOW);
    expect(only.rows).toEqual([]);

    const withType = fakeDb([{ scope: SCOPE, isSport: true, ccaType: "1x" }]);
    await writeSport(withType.db, 7, null, "E1", NOW);
    expect(withType.rows).toHaveLength(1);
    expect(withType.rows[0]).toMatchObject({ isSport: null, ccaType: "1x" });
  });

  it("writeSport keeps the waiver, the flat value, the type and the IHG config", async () => {
    const { db, rows } = fakeDb([
      {
        scope: SCOPE,
        meanMin: 8,
        note: "x",
        flatPoints: 10,
        ccaType: "0.5x",
        ihgResult: "1st",
        ihgCap: 9,
      },
    ]);
    await writeSport(db, 7, true, "E1", NOW);
    expect(rows[0]).toMatchObject({
      isSport: true,
      meanMin: 8,
      note: "x",
      flatPoints: 10,
      ccaType: "0.5x",
      ihgResult: "1st",
      ihgCap: 9,
    });
  });
});

describe("startNewPointsYear (R48, R53)", () => {
  const NOW = new Date("2027-04-01T00:00:00.000Z");
  const DEFAULT_ROW = {
    scope: "default",
    meanMin: 10,
    meanMax: 14,
    sdMin: 2,
    sdMax: 5,
    entryOpen: true,
  };

  it("nulls every IHG result, keeps caps, closes entry and returns the count", async () => {
    const { db, rows } = fakeDb([
      { ...DEFAULT_ROW },
      { scope: "cca:1", ihgResult: "1st", ihgCap: 12, ccaType: "1x" },
      { scope: "cca:2", ihgResult: "2nd", ihgCap: 8, isSport: true },
      { scope: "cca:3", ihgCap: 5 },
      { scope: "cca:4", ccaType: "0.5x" },
    ]);
    expect(await startNewPointsYear(db, "E1", NOW)).toBe(2);
    const byScope = new Map(rows.map((r) => [r.scope, r]));
    expect(byScope.get("cca:1")).toMatchObject({ ihgResult: null, ihgCap: 12 });
    expect(byScope.get("cca:2")).toMatchObject({ ihgResult: null, ihgCap: 8 });
    expect(byScope.get("cca:3")).toEqual({ scope: "cca:3", ihgCap: 5 });
    expect(byScope.get("cca:4")).toEqual({ scope: "cca:4", ccaType: "0.5x" });
    expect(byScope.get("default")).toMatchObject({
      meanMin: 10,
      sdMax: 5,
      entryOpen: false,
      updatedBy: "E1",
    });
  });

  it("deletes a per-CCA row that held only the IHG result, and never the default row", async () => {
    const { db, rows } = fakeDb([
      { scope: "default", entryOpen: true },
      { scope: "cca:1", ihgResult: "3rd" },
    ]);
    expect(await startNewPointsYear(db, "E1", NOW)).toBe(1);
    expect(rows.map((r) => r.scope)).toEqual(["default"]);
    expect(rows[0]).toMatchObject({ entryOpen: false });
  });

  it("keeps flat, waiver, cap and sport rows, and removes already-blank rows", async () => {
    const { db, rows } = fakeDb([
      { scope: "default", entryOpen: true },
      { scope: "cca:1", flatPoints: 10 },
      { scope: "cca:2", meanMin: 8, note: "x" },
      { scope: "cca:3", isSport: false },
      { scope: "cca:4", ccaType: null, ihgResult: null },
    ]);
    expect(await startNewPointsYear(db, "E1", NOW)).toBe(0);
    expect(rows.map((r) => r.scope)).toEqual([
      "default",
      "cca:1",
      "cca:2",
      "cca:3",
    ]);
  });

  it("closes entry and returns 0 when nothing is stored yet", async () => {
    const { db, rows } = fakeDb([]);
    expect(await startNewPointsYear(db, "E1", NOW)).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "default", entryOpen: false });
  });
});
