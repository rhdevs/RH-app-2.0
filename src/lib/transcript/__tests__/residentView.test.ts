import { describe, expect, it } from "vitest";

import {
  PUBLISHED_READONLY_NOTE,
  SECTION_TABS,
  canEditResident,
  canUnlock,
  cellChanges,
  draftOfCell,
  draftTotal,
  eventDetail,
  eventLabel,
  parseOverride,
  readOnlyNote,
  statusLine,
  type CellDraft,
  type PanelFacts,
  type SavedCell,
} from "../residentView";

const facts = (over: Partial<PanelFacts> = {}): PanelFacts => ({
  status: "published",
  state: "published",
  withheld: false,
  unlocked: false,
  ...over,
});

describe("the status line", () => {
  it("names the state in words", () => {
    expect(statusLine(facts())).toBe("Published");
    expect(
      statusLine(facts({ status: "collecting", state: "collecting" })),
    ).toBe("Collecting");
  });

  it("adds the hold, in words", () => {
    expect(statusLine(facts({ withheld: true }))).toBe(
      "Published, withheld from the resident",
    );
    expect(
      statusLine(
        facts({ status: "collecting", state: "collecting", withheld: true }),
      ),
    ).toBe("Collecting, withheld from the resident");
  });
});

describe("what the screen offers", () => {
  it("is read-only for a locked resident of a published year, and says why", () => {
    expect(canEditResident(facts())).toBe(false);
    expect(readOnlyNote(facts())).toBe(PUBLISHED_READONLY_NOTE);
    expect(PUBLISHED_READONLY_NOTE).toBe(
      "Published. Unlock this resident to make corrections.",
    );
  });

  it("is editable once unlocked, and in a year that is not published", () => {
    expect(canEditResident(facts({ unlocked: true }))).toBe(true);
    expect(readOnlyNote(facts({ unlocked: true }))).toBeNull();
    expect(
      canEditResident(facts({ status: "collecting", state: "collecting" })),
    ).toBe(true);
  });

  it("offers Unlock only once the year is open, and only when not already unlocked", () => {
    expect(canUnlock(facts())).toBe(true);
    expect(
      canUnlock(facts({ status: "collecting", state: "collecting" })),
    ).toBe(false);
    expect(canUnlock(facts({ unlocked: true }))).toBe(false);
  });

  it("has the six sections in order", () => {
    expect(SECTION_TABS.map((t) => t.label)).toEqual([
      "CCA memberships",
      "Activities",
      "Volunteer hours",
      "Awards",
      "JCRC page",
      "History",
    ]);
  });
});

describe("history wording", () => {
  it("labels each kind of event", () => {
    expect(eventLabel("unlock")).toBe("Unlocked");
    expect(eventLabel("withhold")).toBe("Withheld");
    expect(eventLabel("correction")).toBe("Correction");
    expect(eventLabel("manual_remove")).toBe("Manual entry removed");
    expect(eventLabel("something_new")).toBe("something_new");
  });

  it("shows the reason, the summary, both, or nothing", () => {
    expect(eventDetail({ reason: "Role was wrong", summary: null })).toBe(
      "Role was wrong",
    );
    expect(
      eventDetail({ reason: null, summary: "Roster: X role cleared" }),
    ).toBe("Roster: X role cleared");
    expect(eventDetail({ reason: "Why", summary: "What" })).toBe("Why What");
    expect(eventDetail({ reason: " ", summary: null })).toBeNull();
  });
});

describe("volunteer overrides", () => {
  it("accepts blank (no override) and quarter hours from 0.25 to 24", () => {
    expect(parseOverride("")).toEqual({ ok: true, value: null });
    expect(parseOverride(" 1.5 ")).toEqual({ ok: true, value: 1.5 });
    expect(parseOverride("24")).toEqual({ ok: true, value: 24 });
    expect(parseOverride("0.25")).toEqual({ ok: true, value: 0.25 });
  });

  it("explains a bad value", () => {
    expect(parseOverride("abc")).toMatchObject({ ok: false });
    expect(parseOverride("0.1")).toMatchObject({
      ok: false,
      reason: "Hours must be at least 0.25.",
    });
    expect(parseOverride("25")).toMatchObject({
      ok: false,
      reason: "Hours must be at most 24.",
    });
    expect(parseOverride("1.1")).toMatchObject({
      ok: false,
      reason: "Hours go up in steps of 0.25.",
    });
  });
});

describe("the changes for one resident's cells", () => {
  const saved: SavedCell[] = [
    { sessionID: "s1", hours: 2, ticked: true, hoursOverride: null },
    { sessionID: "s2", hours: 2, ticked: true, hoursOverride: 1 },
    { sessionID: "s3", hours: 2, ticked: false, hoursOverride: null },
  ];

  it("sends nothing when nothing changed", () => {
    expect(cellChanges(saved, {}, "U")).toEqual({ changes: [], error: null });
    expect(draftOfCell(saved[1]!)).toEqual({ ticked: true, override: "1" });
  });

  it("sends a tick, an untick and a changed override, for this resident only", () => {
    const draft: Record<string, CellDraft> = {
      s1: { ticked: false, override: "" },
      s2: { ticked: true, override: "1.5" },
      s3: { ticked: true, override: "" },
    };
    expect(cellChanges(saved, draft, "U")).toEqual({
      changes: [
        { sessionID: "s1", userID: "U", attended: false },
        { sessionID: "s2", userID: "U", attended: true, hoursOverride: 1.5 },
        { sessionID: "s3", userID: "U", attended: true, hoursOverride: null },
      ],
      error: null,
    });
  });

  it("clears an override with a blank", () => {
    expect(
      cellChanges(saved, { s2: { ticked: true, override: "" } }, "U").changes,
    ).toEqual([
      { sessionID: "s2", userID: "U", attended: true, hoursOverride: null },
    ]);
  });

  it("reports a bad override instead of sending anything", () => {
    expect(
      cellChanges(saved, { s3: { ticked: true, override: "x" } }, "U"),
    ).toEqual({ changes: [], error: "Enter hours as a number." });
  });

  it("totals the drafts live: the override, else the session's hours", () => {
    expect(draftTotal(saved, {})).toBe(3);
    expect(
      draftTotal(saved, {
        s1: { ticked: false, override: "" },
        s3: { ticked: true, override: "0.5" },
      }),
    ).toBe(1.5);
  });
});
