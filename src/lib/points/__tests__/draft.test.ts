import { describe, expect, it } from "vitest";

import {
  buildDraft,
  draftKey,
  mergeDraftWithRoster,
  parseDraft,
  prefillEntry,
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
    });
  });

  it("gives a Member no roles", () => {
    expect(prefillEntry(member(2)).outgoingRole).toBe("none");
  });
});

describe("parseDraft", () => {
  const good = draft({
    "u:1": {
      basePoints: 12,
      semesterOnly: true,
      outgoingRole: "head",
      incomingRole: "vice_head",
    },
    "u:2": {
      basePoints: null,
      semesterOnly: false,
      outgoingRole: "none",
      incomingRole: "none",
    },
  });

  it("round-trips a saved draft", () => {
    expect(parseDraft(JSON.stringify(good), 12)).toEqual(good);
  });

  it.each([
    ["null input", null],
    ["corrupt JSON", "{not json"],
    ["an array", "[]"],
    ["the wrong version", JSON.stringify({ ...good, version: 2 })],
    ["another CCA's draft", JSON.stringify({ ...good, ccaID: 99 })],
    ["rows that are not an object", JSON.stringify({ ...good, rows: [] })],
    [
      "a row with a bad role",
      JSON.stringify(
        draft({
          "u:1": {
            basePoints: 1,
            semesterOnly: false,
            outgoingRole: "captain",
            incomingRole: "none",
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
          },
        } as unknown as Draft["rows"]),
      ),
    ],
  ])("returns null for %s", (_label, raw) => {
    expect(parseDraft(raw, 12)).toBeNull();
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
        },
      }),
    );
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
      },
    });
    const { entries } = mergeDraftWithRoster(roster, saved);
    expect(entries[0]).toMatchObject({
      basePoints: 18,
      semesterOnly: true,
      outgoingRole: "none",
      incomingRole: "head",
      matric: "A9900001Z",
    });
  });

  it("starts new members blank with the prefill", () => {
    const saved = draft({
      "u:1": {
        basePoints: 18,
        semesterOnly: false,
        outgoingRole: "head",
        incomingRole: "none",
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
    };
    const saved = draft({ "u:1": row, "u:8": row, "u:9": row });
    const { entries, droppedCount } = mergeDraftWithRoster(roster, saved);
    expect(entries).toHaveLength(3);
    expect(droppedCount).toBe(2);
  });

  it("takes name, matric and resolved status from the roster, never the draft", () => {
    const { entries } = mergeDraftWithRoster(
      [member(1, { matric: null, resolved: false })],
      null,
    );
    expect(entries[0]).toMatchObject({ matric: null, resolved: false });
  });
});
