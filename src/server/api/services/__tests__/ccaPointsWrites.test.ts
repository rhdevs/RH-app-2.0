import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { AUDIT_ACTIONS } from "~/server/api/services/roles";
import {
  brokenWaiversMessage,
  clearFlat,
  flatExportReason,
  removeOverride,
  waiversBrokenByDefault,
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
      const c = cond as { isSet?: boolean; not?: null };
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
    expect(calls).toEqual(["deleteMany", "updateMany"]);
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
