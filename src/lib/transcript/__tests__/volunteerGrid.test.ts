import { describe, expect, it } from "vitest";
import {
  cellKey,
  cellsOf,
  clearColumn,
  clearRow,
  copyPrevious,
  defaultPhoneIndex,
  gridChanges,
  gridWindow,
  isTicked,
  liveTotals,
  overrideOf,
  pageStart,
  previousSession,
  restrictCells,
  setOverride,
  stepSession,
  tickColumn,
  tickRow,
  toggleCell,
  unsavedCells,
  windowLine,
  type Cells,
  type GridSession,
} from "../volunteerGrid";

const S = (n: number, hours = 1): GridSession => ({
  id: `s${n}`,
  date: `2026-10-${String(n).padStart(2, "0")}`,
  hours,
});
const PEOPLE = ["a", "b", "c"];

describe("grid cells", () => {
  it("starts from the server's ticks, with their overrides", () => {
    const cells = cellsOf([
      { sessionID: "s1", userID: "a", hoursOverride: null },
      { sessionID: "s1", userID: "b", hoursOverride: 0.5 },
    ]);
    expect(isTicked(cells, "s1", "a")).toBe(true);
    expect(overrideOf(cells, "s1", "b")).toBe(0.5);
    expect(isTicked(cells, "s1", "c")).toBe(false);
  });

  it("toggles a cell on and off, and un-ticking loses the override", () => {
    let cells: Cells = {};
    cells = toggleCell(cells, "s1", "a");
    expect(isTicked(cells, "s1", "a")).toBe(true);
    cells = setOverride(cells, "s1", "a", 2);
    expect(overrideOf(cells, "s1", "a")).toBe(2);
    cells = toggleCell(cells, "s1", "a");
    expect(isTicked(cells, "s1", "a")).toBe(false);
    expect(Object.keys(cells)).toEqual([]);
  });

  it("never mutates the cells it is given", () => {
    const before: Cells = { [cellKey("s1", "a")]: null };
    const snapshot = JSON.stringify(before);
    toggleCell(before, "s1", "b");
    tickColumn(before, "s2", PEOPLE);
    clearColumn(before, "s1", PEOPLE);
    copyPrevious(before, "s1", "s2", PEOPLE);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("Tick all ticks a whole column, keeping overrides already set", () => {
    let cells: Cells = { [cellKey("s1", "a")]: 3 };
    cells = tickColumn(cells, "s1", PEOPLE);
    expect(PEOPLE.every((p) => isTicked(cells, "s1", p))).toBe(true);
    expect(overrideOf(cells, "s1", "a")).toBe(3);
  });

  it("Clear all clears a column and leaves the others alone", () => {
    let cells = tickColumn(tickColumn({}, "s1", PEOPLE), "s2", PEOPLE);
    cells = clearColumn(cells, "s1", PEOPLE);
    expect(PEOPLE.some((p) => isTicked(cells, "s1", p))).toBe(false);
    expect(PEOPLE.every((p) => isTicked(cells, "s2", p))).toBe(true);
  });

  it("Tick all sessions and Clear all work on one person's row", () => {
    let cells = tickRow({}, "a", ["s1", "s2", "s3"]);
    expect(["s1", "s2", "s3"].every((s) => isTicked(cells, s, "a"))).toBe(true);
    expect(isTicked(cells, "s1", "b")).toBe(false);
    cells = clearRow(cells, "a", ["s1", "s2"]);
    expect(isTicked(cells, "s1", "a")).toBe(false);
    expect(isTicked(cells, "s3", "a")).toBe(true);
  });

  it("Copy previous makes the next column match, without copying overrides", () => {
    let cells: Cells = {
      [cellKey("s1", "a")]: 0.5,
      [cellKey("s1", "b")]: null,
      [cellKey("s2", "c")]: null, // ticked in s2 only: must be cleared
    };
    cells = copyPrevious(cells, "s1", "s2", PEOPLE);
    expect(isTicked(cells, "s2", "a")).toBe(true);
    expect(overrideOf(cells, "s2", "a")).toBeNull();
    expect(isTicked(cells, "s2", "b")).toBe(true);
    expect(isTicked(cells, "s2", "c")).toBe(false);
    expect(overrideOf(cells, "s1", "a")).toBe(0.5);
  });

  it("only sets an override on a ticked cell, and only a valid one", () => {
    const empty: Cells = {};
    expect(setOverride(empty, "s1", "a", 2)).toBe(empty);
    const ticked = toggleCell(empty, "s1", "a");
    expect(setOverride(ticked, "s1", "a", 0.3)).toBe(ticked);
    expect(setOverride(ticked, "s1", "a", 30)).toBe(ticked);
    expect(overrideOf(setOverride(ticked, "s1", "a", 1.25), "s1", "a")).toBe(
      1.25,
    );
    expect(
      overrideOf(
        setOverride(setOverride(ticked, "s1", "a", 1.25), "s1", "a", null),
        "s1",
        "a",
      ),
    ).toBeNull();
  });

  it("finds the previous session in date order", () => {
    const sessions = [S(1), S(8), S(15)];
    expect(previousSession(sessions, "s8")?.id).toBe("s1");
    expect(previousSession(sessions, "s1")).toBeNull();
    expect(previousSession(sessions, "nope")).toBeNull();
  });
});

describe("saving: what changed", () => {
  const saved = cellsOf([
    { sessionID: "s1", userID: "a", hoursOverride: null },
    { sessionID: "s1", userID: "b", hoursOverride: 0.5 },
  ]);

  it("has no changes when nothing was touched", () => {
    expect(gridChanges(saved, saved)).toEqual([]);
    expect(unsavedCells(saved, saved)).toBe(0);
  });

  it("reports a new tick, an un-tick and an override change, one each", () => {
    let draft = toggleCell(saved, "s1", "c"); // tick
    draft = toggleCell(draft, "s1", "a"); // un-tick
    draft = setOverride(draft, "s1", "b", 2); // change override
    const changes = gridChanges(saved, draft);
    expect(changes).toHaveLength(3);
    expect(changes).toContainEqual({
      sessionID: "s1",
      userID: "c",
      attended: true,
      hoursOverride: null,
    });
    expect(changes).toContainEqual({
      sessionID: "s1",
      userID: "a",
      attended: false,
    });
    expect(changes).toContainEqual({
      sessionID: "s1",
      userID: "b",
      attended: true,
      hoursOverride: 2,
    });
    expect(unsavedCells(saved, draft)).toBe(3);
  });

  it("reports clearing an override as null", () => {
    const draft = setOverride(saved, "s1", "b", null);
    expect(gridChanges(saved, draft)).toEqual([
      { sessionID: "s1", userID: "b", attended: true, hoursOverride: null },
    ]);
  });

  it("is clean again when a change is undone", () => {
    const draft = toggleCell(toggleCell(saved, "s1", "c"), "s1", "c");
    expect(unsavedCells(saved, draft)).toBe(0);
  });

  it("keeps ids that contain the separator intact", () => {
    const draft = toggleCell({}, "s1", "a|b");
    expect(gridChanges({}, draft)).toEqual([
      { sessionID: "s1", userID: "a|b", attended: true, hoursOverride: null },
    ]);
  });

  it("drops ticks on sessions or people that are no longer active before saving", () => {
    const cells = restrictCells(
      { ...saved, [cellKey("gone", "a")]: null, [cellKey("s1", "gone")]: null },
      ["s1"],
      ["a", "b"],
    );
    expect(Object.keys(cells).sort()).toEqual(
      [cellKey("s1", "a"), cellKey("s1", "b")].sort(),
    );
  });
});

describe("live totals", () => {
  it("follows unsaved edits, with overrides", () => {
    const sessions = [S(1, 2), S(8, 1)];
    let cells = tickColumn({}, "s1", ["a", "b"]);
    cells = toggleCell(cells, "s8", "a");
    cells = setOverride(cells, "s1", "b", 0.5);
    const totals = liveTotals(cells, sessions, ["a", "b", "c"]);
    expect(totals.get("a")).toBe(3);
    expect(totals.get("b")).toBe(0.5);
    expect(totals.get("c")).toBe(0);
  });
});

describe("paging the desktop grid", () => {
  it("draws at most 8 sessions, the most recent ones first", () => {
    const w = gridWindow(20, null);
    expect(w).toEqual({
      start: 12,
      end: 20,
      hasEarlier: true,
      hasLater: false,
    });
  });

  it("draws everything when there are 8 or fewer", () => {
    expect(gridWindow(5, null)).toEqual({
      start: 0,
      end: 5,
      hasEarlier: false,
      hasLater: false,
    });
    expect(gridWindow(0, null).end).toBe(0);
  });

  it("pages earlier and later by 8 and never runs off either end", () => {
    const first = gridWindow(20, null);
    const earlier = gridWindow(20, pageStart(20, first, "earlier"));
    expect(earlier).toMatchObject({ start: 4, end: 12 });
    const earliest = gridWindow(20, pageStart(20, earlier, "earlier"));
    expect(earliest).toMatchObject({ start: 0, end: 8, hasEarlier: false });
    expect(pageStart(20, earliest, "earlier")).toBe(0);
    const back = gridWindow(20, pageStart(20, earliest, "later"));
    expect(back).toMatchObject({ start: 8, end: 16 });
    expect(pageStart(20, gridWindow(20, null), "later")).toBe(12);
  });

  it("never draws hundreds of columns", () => {
    const w = gridWindow(120, null);
    expect(w.end - w.start).toBe(8);
  });

  it("says which sessions are shown", () => {
    expect(windowLine(gridWindow(20, null), 20)).toBe(
      "Sessions 13 to 20 of 20",
    );
    expect(windowLine(gridWindow(0, null), 0)).toBe("No sessions yet.");
  });
});

describe("the phone view", () => {
  it("starts on the most recent session", () => {
    expect(defaultPhoneIndex(5)).toBe(4);
    expect(defaultPhoneIndex(0)).toBe(0);
  });

  it("steps with the arrows and stops at both ends", () => {
    expect(stepSession(5, 2, -1)).toBe(1);
    expect(stepSession(5, 2, 1)).toBe(3);
    expect(stepSession(5, 0, -1)).toBe(0);
    expect(stepSession(5, 4, 1)).toBe(4);
    expect(stepSession(0, 0, 1)).toBe(0);
  });

  it("shares its ticks with the desktop grid: one state", () => {
    // Ticking a person for one session on the phone is the same cell the grid shows.
    const cells = toggleCell({}, "s8", "a");
    expect(isTicked(cells, "s8", "a")).toBe(true);
    expect(unsavedCells({}, cells)).toBe(1);
  });
});
