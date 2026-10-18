import { describe, expect, it } from "vitest";

import type { PointsEntry } from "~/lib/points/entries";
import {
  buildDraft,
  canAutosave,
  draftKey,
  mergeDraftWithRoster,
  mergeRosterOverEntries,
  parseDraft,
  prefillEntry,
  readDraftItem,
  removeDraftItem,
  type Draft,
  type RosterMember,
} from "~/lib/points/draft";

const member = (
  n: number,
  patch: Partial<RosterMember> = {},
): RosterMember => ({
  rowKey: `u:${n}`,
  matric: `A99${String(n).padStart(5, "0")}Z`,
  name: `Test Member ${n}`,
  resolved: true,
  role: "Member",
  ...patch,
});

const draft = (rows: Draft["rows"], patch: Partial<Draft> = {}): Draft => ({
  version: 1,
  ccaID: 12,
  savedAt: "2027-04-01T09:30:00.000Z",
  rows,
  ...patch,
});

describe("draftKey", () => {
  it("is namespaced by CCA and user", () => {
    expect(draftKey(12, "E1234567")).toBe(
      "rhapp.ccaPoints.draft.v1:12:E1234567",
    );
  });
});

describe("prefillEntry", () => {
  it("makes a Head an outgoing head, blank score, no incoming role", () => {
    expect(prefillEntry(member(1, { role: "Head" }))).toEqual({
      rowKey: "u:1",
      matric: "A9900001Z",
      name: "Test Member 1",
      resolved: true,
      basePoints: null,
      semesterOnly: false,
      outgoingRole: "head",
      incomingRole: "none",
      ihg: false,
    });
  });

  it("starts with no IHG tick", () => {
    expect(prefillEntry(member(1)).ihg).toBe(false);
  });

  it("gives a Member no roles", () => {
    expect(prefillEntry(member(2)).outgoingRole).toBe("none");
  });
});

describe("parseDraft", () => {
  const row = {
    basePoints: 12,
    semesterOnly: true,
    outgoingRole: "head",
    incomingRole: "vice_head",
    ihg: false,
  } as const;
  const good = draft({
    "u:1": row,
    "u:2": {
      basePoints: null,
      semesterOnly: false,
      outgoingRole: "none",
      incomingRole: "none",
      ihg: false,
    },
  });

  it("returns ok with the draft for a saved draft", () => {
    expect(parseDraft(JSON.stringify(good), 12)).toEqual({
      status: "ok",
      draft: good,
    });
  });

  it("returns none when nothing is stored", () => {
    expect(parseDraft(null, 12)).toEqual({ status: "none" });
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["an array", "[]"],
    ["the wrong version", JSON.stringify({ ...good, version: 2 })],
    ["another CCA's draft", JSON.stringify({ ...good, ccaID: 99 })],
    ["rows that are not an object", JSON.stringify({ ...good, rows: [] })],
    ["a missing savedAt", JSON.stringify({ ...good, savedAt: undefined })],
    ["a non-string savedAt", JSON.stringify({ ...good, savedAt: 5 })],
    [
      "a savedAt that is not a date",
      JSON.stringify({ ...good, savedAt: "yesterday-ish" }),
    ],
    ["an empty savedAt", JSON.stringify({ ...good, savedAt: "" })],
    [
      "a row with a bad role",
      JSON.stringify(
        draft({
          "u:1": {
            basePoints: 1,
            semesterOnly: false,
            outgoingRole: "captain",
            incomingRole: "none",
            ihg: false,
          },
        } as unknown as Draft["rows"]),
      ),
    ],
    [
      "a row with a text score",
      JSON.stringify(
        draft({
          "u:1": {
            basePoints: "12",
            semesterOnly: false,
            outgoingRole: "none",
            incomingRole: "none",
            ihg: false,
          },
        } as unknown as Draft["rows"]),
      ),
    ],
  ])("returns unreadable for %s", (_label, raw) => {
    expect(parseDraft(raw, 12)).toEqual({ status: "unreadable" });
  });

  it("reads a v1-era row with no ihg as unticked", () => {
    const raw = JSON.stringify({
      version: 1,
      ccaID: 12,
      savedAt: "2027-04-01T09:30:00.000Z",
      rows: {
        "u:1": {
          basePoints: 12,
          semesterOnly: false,
          outgoingRole: "none",
          incomingRole: "none",
        },
      },
    });
    const parsed = parseDraft(raw, 12);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.draft.rows["u:1"]?.ihg).toBe(false);
  });

  it("keeps a ticked ihg", () => {
    const parsed = parseDraft(
      JSON.stringify(draft({ "u:1": { ...row, ihg: true } })),
      12,
    );
    if (parsed.status !== "ok") throw new Error("expected an ok draft");
    expect(parsed.draft.rows["u:1"]?.ihg).toBe(true);
  });

  it("returns unreadable for a row whose ihg is not a boolean", () => {
    const raw = JSON.stringify(
      draft({ "u:1": { ...row, ihg: "yes" } } as unknown as Draft["rows"]),
    );
    expect(parseDraft(raw, 12)).toEqual({ status: "unreadable" });
  });

  it("rebuilds each row from only the five editable fields", () => {
    const raw = JSON.stringify(
      draft({
        "u:1": {
          ...row,
          matric: "A0000001Z",
          name: "Intruder",
          resolved: false,
          rowKey: "u:999",
        },
      } as unknown as Draft["rows"]),
    );
    const parsed = parseDraft(raw, 12);
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.draft.rows["u:1"]).toEqual(row);
    expect(Object.keys(parsed.draft.rows["u:1"] ?? {}).sort()).toEqual([
      "basePoints",
      "ihg",
      "incomingRole",
      "outgoingRole",
      "semesterOnly",
    ]);
  });
});

describe("buildDraft", () => {
  it("keeps only the editable fields, keyed by rowKey", () => {
    const entry = { ...prefillEntry(member(1)), basePoints: 15 };
    expect(
      buildDraft(12, [entry], new Date("2027-04-01T09:30:00.000Z")),
    ).toEqual(
      draft({
        "u:1": {
          basePoints: 15,
          semesterOnly: false,
          outgoingRole: "none",
          incomingRole: "none",
          ihg: false,
        },
      }),
    );
  });

  it("writes the ihg tick", () => {
    const entry = { ...prefillEntry(member(1)), ihg: true };
    expect(buildDraft(12, [entry], new Date()).rows["u:1"]?.ihg).toBe(true);
  });

  it("stores a non-number score as blank", () => {
    const entry = { ...prefillEntry(member(1)), basePoints: Number.NaN };
    expect(
      buildDraft(12, [entry], new Date()).rows["u:1"]?.basePoints,
    ).toBeNull();
  });

  it("never stores matric or name", () => {
    const json = JSON.stringify(
      buildDraft(12, [prefillEntry(member(1))], new Date()),
    );
    expect(json).not.toContain("A9900001Z");
    expect(json).not.toContain("Test Member");
  });
});

describe("mergeDraftWithRoster", () => {
  const roster = [member(1, { role: "Head" }), member(2), member(3)];

  it("prefills everyone when there is no draft", () => {
    const { entries, droppedCount } = mergeDraftWithRoster(roster, null);
    expect(entries.map((e) => e.outgoingRole)).toEqual([
      "head",
      "none",
      "none",
    ]);
    expect(entries.every((e) => e.basePoints === null)).toBe(true);
    expect(droppedCount).toBe(0);
  });

  it("restores draft values for members still on the roster", () => {
    const saved = draft({
      "u:1": {
        basePoints: 18,
        semesterOnly: true,
        outgoingRole: "none",
        incomingRole: "head",
        ihg: false,
      },
    });
    const { entries } = mergeDraftWithRoster(roster, saved);
    expect(entries[0]).toMatchObject({
      basePoints: 18,
      semesterOnly: true,
      outgoingRole: "none",
      incomingRole: "head",
      ihg: false,
      matric: "A9900001Z",
    });
  });

  it("restores a saved ihg tick", () => {
    const saved = draft({
      "u:1": {
        basePoints: 18,
        semesterOnly: false,
        outgoingRole: "none",
        incomingRole: "none",
        ihg: true,
      },
    });
    expect(mergeDraftWithRoster(roster, saved).entries[0]?.ihg).toBe(true);
  });

  it("starts new members blank with the prefill", () => {
    const saved = draft({
      "u:1": {
        basePoints: 18,
        semesterOnly: false,
        outgoingRole: "head",
        incomingRole: "none",
        ihg: false,
      },
    });
    const { entries } = mergeDraftWithRoster(roster, saved);
    expect(entries[1]).toEqual(prefillEntry(member(2)));
  });

  it("drops rows no longer on the roster and counts them", () => {
    const row = {
      basePoints: 10,
      semesterOnly: false,
      outgoingRole: "none" as const,
      incomingRole: "none" as const,
      ihg: false,
    };
    const saved = draft({ "u:1": row, "u:8": row, "u:9": row });
    const { entries, droppedCount } = mergeDraftWithRoster(roster, saved);
    expect(entries).toHaveLength(3);
    expect(droppedCount).toBe(2);
  });

  it("takes name, matric and resolved status from the roster, never the draft", () => {
    const parsed = parseDraft(
      JSON.stringify(
        draft({
          "u:1": {
            basePoints: 9,
            semesterOnly: true,
            outgoingRole: "none",
            incomingRole: "none",
            ihg: false,
            matric: "A0000001Z",
            name: "Intruder",
            resolved: true,
            rowKey: "u:777",
          },
        } as unknown as Draft["rows"]),
      ),
      12,
    );
    if (parsed.status !== "ok") throw new Error("expected an ok draft");
    const { entries } = mergeDraftWithRoster(
      [member(1, { matric: null, name: "Real Name", resolved: false })],
      parsed.draft,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      rowKey: "u:1",
      matric: null,
      name: "Real Name",
      resolved: false,
      basePoints: 9,
      semesterOnly: true,
    });
  });

  it("takes identity from the roster when there is no draft", () => {
    const { entries } = mergeDraftWithRoster(
      [member(1, { matric: null, resolved: false })],
      null,
    );
    expect(entries[0]).toMatchObject({ matric: null, resolved: false });
  });
});

describe("mergeRosterOverEntries", () => {
  const edited = (n: number, patch: Partial<PointsEntry>): PointsEntry => ({
    ...prefillEntry(member(n)),
    ...patch,
  });

  it("keeps the in-memory values of members still on the roster", () => {
    const current = [
      edited(1, { basePoints: 14, semesterOnly: true }),
      edited(2, { basePoints: 3, incomingRole: "head" }),
    ];
    const { entries, droppedCount } = mergeRosterOverEntries(
      [member(1), member(2)],
      current,
    );
    expect(droppedCount).toBe(0);
    expect(entries[0]).toMatchObject({ basePoints: 14, semesterOnly: true });
    expect(entries[1]).toMatchObject({ basePoints: 3, incomingRole: "head" });
  });

  it("keeps the in-memory ihg tick", () => {
    const { entries } = mergeRosterOverEntries(
      [member(1)],
      [edited(1, { ihg: true })],
    );
    expect(entries[0]?.ihg).toBe(true);
  });

  it("adds new members blank with the prefill", () => {
    const { entries } = mergeRosterOverEntries(
      [member(1), member(2, { role: "Head" })],
      [edited(1, { basePoints: 7 })],
    );
    expect(entries.map((e) => e.rowKey)).toEqual(["u:1", "u:2"]);
    expect(entries[1]).toMatchObject({
      basePoints: null,
      outgoingRole: "head",
      incomingRole: "none",
      ihg: false,
    });
  });

  it("drops members no longer on the roster and counts them", () => {
    const { entries, droppedCount } = mergeRosterOverEntries(
      [member(2)],
      [edited(1, { basePoints: 7 }), edited(2, { basePoints: 8 })],
    );
    expect(entries.map((e) => e.rowKey)).toEqual(["u:2"]);
    expect(droppedCount).toBe(1);
  });

  it("takes identity from the fresh roster, not the old entry", () => {
    const { entries } = mergeRosterOverEntries(
      [member(1, { name: "Renamed", matric: "A9900001Z", resolved: true })],
      [
        edited(1, {
          basePoints: 5,
          name: "Old",
          matric: null,
          resolved: false,
        }),
      ],
    );
    expect(entries[0]).toMatchObject({
      name: "Renamed",
      matric: "A9900001Z",
      resolved: true,
      basePoints: 5,
    });
  });

  it("does not mutate its inputs", () => {
    const current = Object.freeze([
      Object.freeze(edited(1, { basePoints: 7 })),
    ]) as readonly PointsEntry[];
    const roster = Object.freeze([Object.freeze(member(1))]);
    expect(() => mergeRosterOverEntries(roster, current)).not.toThrow();
    expect(current[0]?.basePoints).toBe(7);
  });
});

describe("canAutosave", () => {
  it("saves once something was edited and a key exists", () => {
    expect(
      canAutosave({ storageKey: "k", touched: true, unreadable: false }),
    ).toBe(true);
  });

  it("is paused while the stored draft is unreadable", () => {
    expect(
      canAutosave({ storageKey: "k", touched: true, unreadable: true }),
    ).toBe(false);
  });

  it("does nothing before an edit or without a storage key", () => {
    expect(
      canAutosave({ storageKey: "k", touched: false, unreadable: false }),
    ).toBe(false);
    expect(
      canAutosave({ storageKey: null, touched: true, unreadable: false }),
    ).toBe(false);
  });
});

describe("removeDraftItem", () => {
  it("removes the item and reports success", () => {
    const removed: string[] = [];
    expect(
      removeDraftItem({ removeItem: (k) => void removed.push(k) }, "k"),
    ).toBe(true);
    expect(removed).toEqual(["k"]);
  });

  it("reports failure when storage throws", () => {
    expect(
      removeDraftItem(
        {
          removeItem: () => {
            throw new Error("blocked");
          },
        },
        "k",
      ),
    ).toBe(false);
  });
});

describe("readDraftItem", () => {
  const stored = JSON.stringify(
    draft({
      "u:1": {
        basePoints: 5,
        semesterOnly: false,
        outgoingRole: "none",
        incomingRole: "none",
        ihg: false,
      },
    }),
  );

  it("reads a stored draft", () => {
    expect(readDraftItem({ getItem: () => stored }, "k", 12).status).toBe("ok");
  });

  it("reports none when nothing is stored", () => {
    expect(readDraftItem({ getItem: () => null }, "k", 12)).toEqual({
      status: "none",
    });
  });

  it("reports unreadable, not none, when getItem throws", () => {
    expect(
      readDraftItem(
        {
          getItem: () => {
            throw new Error("denied");
          },
        },
        "k",
        12,
      ),
    ).toEqual({ status: "unreadable" });
  });
});
