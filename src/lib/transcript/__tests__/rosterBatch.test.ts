import { describe, expect, it } from "vitest";
import {
  EMPTY_BATCH,
  applyEdit,
  beginSave,
  dirtyRows,
  discardAll,
  draftFor,
  filterRows,
  isRowDirty,
  rowBlocker,
  saveAllFailureLine,
  saveFailed,
  saveSucceeded,
  unsavedCount,
  unsavedLine,
  type SavedRow,
} from "../rosterBatch";

const row = (userID: string, over: Partial<SavedRow> = {}): SavedRow => ({
  userID,
  displayName: `Member ${userID}`,
  duration: null,
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
  defaultDuration: "full",
  ...over,
});

const ROWS = [row("a"), row("b"), row("c")];

describe("roster batch state", () => {
  it("starts with nothing unsaved and shows what is saved", () => {
    expect(unsavedCount(EMPTY_BATCH, ROWS)).toBe(0);
    expect(
      draftFor(EMPTY_BATCH, row("a", { roleLabel: "Head" })).roleLabel,
    ).toBe("Head");
  });

  it("counts every edited row, however many fields changed", () => {
    let s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    s = applyEdit(s, ROWS[0]!, { extra: "Did things" });
    s = applyEdit(s, ROWS[2]!, { duration: "sem2" });

    expect(unsavedCount(s, ROWS)).toBe(2);
    expect(dirtyRows(s, ROWS).map((r) => r.userID)).toEqual(["a", "c"]);
    expect(isRowDirty(s, ROWS[1]!)).toBe(false);
  });

  it("is clean again when an edit is typed back to what is saved", () => {
    let s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    s = applyEdit(s, ROWS[0]!, { roleLabel: "  " });
    expect(unsavedCount(s, ROWS)).toBe(0);
  });

  it("does not mutate the state it is given", () => {
    const before = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    const snapshot = JSON.stringify(before);
    applyEdit(before, ROWS[0]!, { roleLabel: "Other" });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("pulls a role period back inside a narrower membership and says so", () => {
    const r = row("a", { roleLabel: "Head", roleDuration: "full" });
    const s = applyEdit(EMPTY_BATCH, r, { duration: "sem2" });

    expect(draftFor(s, r).roleDuration).toBe("sem2");
    expect(s.a!.note).toMatch(/Role period changed/);
  });

  it("Discard throws every unsaved edit away", () => {
    const s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    expect(unsavedCount(discardAll(), ROWS)).toBe(0);
    expect(unsavedCount(s, ROWS)).toBe(1);
  });
});

describe("saving rows (Save all runs these one after another)", () => {
  it("marks a row saving, then saved with what the server stored", () => {
    let s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: " Head " });
    s = beginSave(s, ROWS[0]!);
    expect(s.a!.saving).toBe(true);

    s = saveSucceeded(s, ROWS[0]!, {
      duration: null,
      roleLabel: "Head",
      roleDuration: null,
      extraContribution: null,
    });
    expect(s.a).toMatchObject({ saving: false, saved: true, error: null });
    expect(draftFor(s, ROWS[0]!).roleLabel).toBe("Head");
  });

  it("keeps what was typed while the save was in flight", () => {
    let s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    s = beginSave(s, ROWS[0]!);
    s = applyEdit(s, ROWS[0]!, { roleLabel: "Head of Welfare" });
    s = saveSucceeded(s, ROWS[0]!, {
      duration: null,
      roleLabel: "Head",
      roleDuration: null,
      extraContribution: null,
    });

    expect(draftFor(s, ROWS[0]!).roleLabel).toBe("Head of Welfare");
  });

  it("records a failure on that row only and leaves its edit unsaved", () => {
    let s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    s = applyEdit(s, ROWS[1]!, { roleLabel: "Deputy" });
    s = beginSave(s, ROWS[0]!);
    s = saveFailed(s, ROWS[0]!, "That person is no longer a member.");
    s = beginSave(s, ROWS[1]!);
    s = saveSucceeded(s, ROWS[1]!, {
      duration: null,
      roleLabel: "Deputy",
      roleDuration: null,
      extraContribution: null,
    });

    expect(s.a).toMatchObject({
      saving: false,
      saved: false,
      error: "That person is no longer a member.",
    });
    expect(s.b!.error).toBeNull();
    // b is saved on the server, so only a is still unsaved once rows reload.
    const reloaded = [ROWS[0]!, row("b", { roleLabel: "Deputy" }), ROWS[2]!];
    expect(dirtyRows(s, reloaded).map((r) => r.userID)).toEqual(["a"]);
  });

  it("clears a row's error when it is edited again", () => {
    let s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    s = saveFailed(s, ROWS[0]!, "Nope");
    s = applyEdit(s, ROWS[0]!, { roleLabel: "Head2" });
    expect(s.a!.error).toBeNull();
  });

  it("stops a row whose text is over the limit from being sent", () => {
    const s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "x".repeat(61) });
    expect(rowBlocker(s, ROWS[0]!)).toMatch(/60/);
    expect(rowBlocker(EMPTY_BATCH, ROWS[0]!)).toBeNull();
  });
});

describe("roster name filter and wording", () => {
  it("filters by name in any case and keeps everyone for a blank filter", () => {
    const rows = [
      row("a", { displayName: "Alice Tan" }),
      row("b", { displayName: "Bob Lim" }),
    ];
    expect(filterRows(rows, "ALI").map((r) => r.userID)).toEqual(["a"]);
    expect(filterRows(rows, " ")).toHaveLength(2);
    expect(filterRows(rows, "zzz")).toEqual([]);
  });

  it("keeps edits on rows the filter hides", () => {
    const s = applyEdit(EMPTY_BATCH, ROWS[0]!, { roleLabel: "Head" });
    const shown = filterRows(
      [row("a", { displayName: "Alice" }), row("b", { displayName: "Bob" })],
      "bob",
    );
    expect(shown.map((r) => r.userID)).toEqual(["b"]);
    expect(unsavedCount(s, ROWS)).toBe(1);
  });

  it("words the counts", () => {
    expect(unsavedLine(1)).toBe("1 unsaved change");
    expect(unsavedLine(4)).toBe("4 unsaved changes");
    expect(saveAllFailureLine(1)).toMatch(/^1 row could not be saved/);
    expect(saveAllFailureLine(2)).toMatch(/^2 rows could not be saved/);
  });
});
