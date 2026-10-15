import { describe, expect, it } from "vitest";
import {
  AWARD_CITATION_MAX,
  AWARD_NAME_MAX,
  EMPTY_SELECTION,
  MAX_ASSIGN,
  MAX_BULK,
  assignResultLine,
  cleanCitation,
  groupByAward,
  groupLine,
  isDuplicateAward,
  matchesSearch,
  normalizeAwardName,
  planAssignment,
  pruneSelection,
  selectionSplit,
  toggleMany,
  toggleSelected,
  UNDO_BATCH_CONFIRMATION,
  type ListedAward,
} from "../awards";
import {
  awardBatchUndoInput,
  awardTypeCreateInput,
  awardTypeUpdateInput,
  awardUpdateInput,
  awardsAssignInput,
  awardsBulkInput,
} from "../manageInput";

const ID = "0123456789abcdef01234567";
const AY = "AY2026/27";

describe("normalizeAwardName", () => {
  it("lower-cases, trims and collapses inner spaces", () => {
    expect(normalizeAwardName("  Full   Colours ")).toBe("full colours");
    expect(normalizeAwardName("FULL\tCOLOURS\n")).toBe("full colours");
    expect(normalizeAwardName("Full Colours")).toBe(
      normalizeAwardName("full  colours"),
    );
  });

  it("keeps different names different", () => {
    expect(normalizeAwardName("Half Colours")).not.toBe(
      normalizeAwardName("Full Colours"),
    );
  });

  it("is stable", () => {
    const once = normalizeAwardName(" A  B ");
    expect(normalizeAwardName(once)).toBe(once);
  });

  it("treats a blank citation as none", () => {
    expect(cleanCitation("  ")).toBeNull();
    expect(cleanCitation(null)).toBeNull();
    expect(cleanCitation(" For service ")).toBe("For service");
  });
});

describe("duplicate awards", () => {
  const type = { id: "t1", name: "Full Colours" };

  it("is a duplicate when the same person holds the same catalogue entry", () => {
    expect(
      isDuplicateAward(
        { userID: "a", awardTypeID: "t1", title: "Full Colours" },
        "a",
        type,
      ),
    ).toBe(true);
  });

  it("is not a duplicate for another person or another entry", () => {
    expect(
      isDuplicateAward(
        { userID: "b", awardTypeID: "t1", title: "x" },
        "a",
        type,
      ),
    ).toBe(false);
    expect(
      isDuplicateAward(
        { userID: "a", awardTypeID: "t2", title: "Full Colours" },
        "a",
        type,
      ),
    ).toBe(false);
  });

  it("compares the normalised name when the existing award has no entry", () => {
    expect(
      isDuplicateAward(
        { userID: "a", awardTypeID: null, title: "  full   COLOURS " },
        "a",
        type,
      ),
    ).toBe(true);
    expect(
      isDuplicateAward(
        { userID: "a", awardTypeID: null, title: "Half Colours" },
        "a",
        type,
      ),
    ).toBe(false);
  });

  it("plans an assignment: creates new people, skips people who have it and repeats", () => {
    const plan = planAssignment(
      [{ userID: "a", awardTypeID: "t1", title: "Full Colours" }],
      type,
      [
        { userID: "a", citation: "x" },
        { userID: "b" },
        { userID: "c" },
        { userID: "b" },
      ],
    );
    expect(plan.create.map((r) => r.userID)).toEqual(["b", "c"]);
    expect(plan.skipped.map((r) => r.userID)).toEqual(["a", "b"]);
  });

  it("creates everyone when nobody has it, and nothing for an empty list", () => {
    expect(
      planAssignment([], type, [{ userID: "a" }, { userID: "b" }]).create,
    ).toHaveLength(2);
    expect(planAssignment([], type, [])).toEqual({ create: [], skipped: [] });
  });
});

describe("group by award", () => {
  const award = (over: Partial<ListedAward>): ListedAward => ({
    id: "x",
    title: "Full Colours",
    awardTypeID: "t1",
    displayName: "Alice",
    userID: "a",
    removed: false,
    ...over,
  });

  it("groups by catalogue entry, titles in order, people by name", () => {
    const groups = groupByAward([
      award({ id: "1", displayName: "Zed", userID: "z" }),
      award({ id: "2", displayName: "Amy", userID: "a" }),
      award({ id: "3", title: "Best Newcomer", awardTypeID: "t2" }),
    ]);
    expect(groups.map((g) => g.title)).toEqual([
      "Best Newcomer",
      "Full Colours",
    ]);
    expect(groups[1]!.items.map((i) => i.displayName)).toEqual(["Amy", "Zed"]);
    expect(groups[1]!.activeCount).toBe(2);
  });

  it("counts only awards that are not removed", () => {
    const groups = groupByAward([
      award({ id: "1" }),
      award({ id: "2", removed: true, displayName: "Bob", userID: "b" }),
    ]);
    expect(groups[0]!.activeCount).toBe(1);
    expect(groups[0]!.items).toHaveLength(2);
  });

  it("groups awards that have no entry by normalised name", () => {
    const groups = groupByAward([
      award({ id: "1", awardTypeID: null, title: "Old Award" }),
      award({ id: "2", awardTypeID: null, title: " old   award", userID: "b" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.activeCount).toBe(2);
  });

  it("words the group line with the right plural", () => {
    expect(groupLine("Full Colours", 14)).toBe("Full Colours: 14 residents");
    expect(groupLine("Full Colours", 1)).toBe("Full Colours: 1 resident");
  });

  it("searches the award and the person, any case", () => {
    const a = { title: "Full Colours", displayName: "Alice Tan", userID: "a" };
    expect(matchesSearch(a, "colour")).toBe(true);
    expect(matchesSearch(a, "ALICE")).toBe(true);
    expect(matchesSearch(a, "bob")).toBe(false);
    expect(matchesSearch(a, "  ")).toBe(true);
    expect(
      matchesSearch(
        { title: "T", displayName: null, userID: "SEED-R01" },
        "r01",
      ),
    ).toBe(true);
  });
});

describe("selecting awards", () => {
  it("toggles one award on and off without changing the set it was given", () => {
    const one = toggleSelected(EMPTY_SELECTION, "a");
    expect([...one]).toEqual(["a"]);
    expect([...EMPTY_SELECTION]).toEqual([]);
    expect([...toggleSelected(one, "a")]).toEqual([]);
  });

  it("selects a whole group, and clears it when all are already selected", () => {
    const all = toggleMany(EMPTY_SELECTION, ["a", "b", "c"]);
    expect([...all].sort()).toEqual(["a", "b", "c"]);
    expect([...toggleMany(all, ["a", "b", "c"])]).toEqual([]);
    const part = toggleSelected(EMPTY_SELECTION, "a");
    expect([...toggleMany(part, ["a", "b"])].sort()).toEqual(["a", "b"]);
  });

  it("drops ids that are no longer listed", () => {
    const s = toggleMany(EMPTY_SELECTION, ["a", "b", "c"]);
    expect([...pruneSelection(s, ["b", "z"])]).toEqual(["b"]);
  });

  it("splits the selection into what can be removed and what can be restored", () => {
    const awards = [
      { id: "a", removed: false },
      { id: "b", removed: true },
      { id: "c", removed: false },
    ];
    const s = toggleMany(EMPTY_SELECTION, ["a", "b"]);
    expect(selectionSplit(s, awards)).toEqual({
      removable: ["a"],
      restorable: ["b"],
    });
  });
});

describe("wording and limits", () => {
  it("says what an assignment did", () => {
    expect(assignResultLine(12, [])).toBe("12 assigned.");
    expect(assignResultLine(10, ["A", "B"])).toBe(
      "10 assigned. Skipped (already have it): A, B.",
    );
  });

  it("explains an undo", () => {
    expect(UNDO_BATCH_CONFIRMATION(3)).toBe(
      "This removes the 3 awards from this upload. You can restore them one by one later.",
    );
    expect(UNDO_BATCH_CONFIRMATION(1)).toContain("1 award ");
  });

  it("fixes the limits", () => {
    expect(AWARD_NAME_MAX).toBe(80);
    expect(AWARD_CITATION_MAX).toBe(300);
    expect(MAX_ASSIGN).toBe(300);
    expect(MAX_BULK).toBe(500);
  });
});

describe("award inputs", () => {
  it("takes a name of 1 to 80 characters and a citation up to 300", () => {
    const ok = (extra: object) =>
      awardTypeCreateInput.safeParse({ name: "Full Colours", ...extra })
        .success;
    expect(ok({})).toBe(true);
    expect(ok({ name: "x".repeat(80) })).toBe(true);
    expect(ok({ name: "x".repeat(81) })).toBe(false);
    expect(ok({ name: "   " })).toBe(false);
    expect(ok({ defaultCitation: "x".repeat(300) })).toBe(true);
    expect(ok({ defaultCitation: "x".repeat(301) })).toBe(false);
    expect(ok({ name: "bad\u0000" })).toBe(false);
    expect(ok({ name: "a‮b" })).toBe(false);
  });

  it("treats a blank citation as none", () => {
    expect(
      awardTypeCreateInput.parse({ name: "A", defaultCitation: "   " })
        .defaultCitation,
    ).toBeNull();
    expect(
      awardTypeCreateInput.parse({ name: "A" }).defaultCitation,
    ).toBeNull();
  });

  it("updates by id", () => {
    expect(awardTypeUpdateInput.safeParse({ id: ID, name: "A" }).success).toBe(
      true,
    );
    expect(
      awardTypeUpdateInput.safeParse({ id: "nope", name: "A" }).success,
    ).toBe(false);
    expect(
      awardUpdateInput.safeParse({ id: ID, title: "x".repeat(81) }).success,
    ).toBe(false);
  });

  it("assigns to 1 to 300 people", () => {
    const people = (n: number) =>
      awardsAssignInput.safeParse({
        academicYear: AY,
        awardTypeID: ID,
        recipients: Array.from({ length: n }, (_, i) => ({ userID: `e${i}` })),
      }).success;
    expect(people(1)).toBe(true);
    expect(people(300)).toBe(true);
    expect(people(301)).toBe(false);
    expect(people(0)).toBe(false);
  });

  it("removes or restores at most 500 awards at a time", () => {
    const ids = (n: number) =>
      awardsBulkInput.safeParse({ ids: Array.from({ length: n }, () => ID) })
        .success;
    expect(ids(500)).toBe(true);
    expect(ids(501)).toBe(false);
    expect(ids(0)).toBe(false);
    expect(awardBatchUndoInput.safeParse({ batchId: ID }).success).toBe(true);
  });
});
