import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { saveThenPeople } from "../activityEditor";
import {
  REFRESH_FAILED_NOTE,
  applyDraftPatch,
  draftOf,
  type RowDraft,
} from "../headView";
import {
  mayLeave,
  totalUnsaved,
  DISCARD_CHANGES_QUESTION,
} from "../useUnsavedChangesGuard";
import {
  applyEdits,
  cellKey,
  editsFrom,
  gridChanges,
  reconcileEdits,
  type Cells,
} from "../volunteerGrid";

describe("unsaved work anywhere on the tab guards the year switch (F10)", () => {
  it("adds up every part", () => {
    expect(totalUnsaved({})).toBe(0);
    expect(totalUnsaved({ roster: 0, volunteer: 0, activities: 0 })).toBe(0);
    expect(totalUnsaved({ roster: 0, volunteer: 3, activities: 0 })).toBe(3);
    expect(totalUnsaved({ roster: 1, volunteer: 2, activities: 1 })).toBe(4);
  });

  it("asks before the year changes when only attendance ticks are unsaved", () => {
    const ask = vi.fn(() => false);

    const may = mayLeave(
      totalUnsaved({ roster: 0, volunteer: 2, activities: 0 }) > 0,
      ask,
    );

    expect(ask).toHaveBeenCalledTimes(1);
    expect(may).toBe(false);
    expect(DISCARD_CHANGES_QUESTION).toMatch(/unsaved changes/);
  });

  it("does not ask when nothing is unsaved", () => {
    const ask = vi.fn(() => false);
    expect(mayLeave(totalUnsaved({ roster: 0, volunteer: 0 }) > 0, ask)).toBe(
      true,
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it("the tab includes the volunteer and activity counts in its guard", () => {
    const source = readFileSync(
      "src/app/cca/[ccaID]/transcript/_components/TranscriptTab.tsx",
      "utf8",
    );
    expect(source).toContain("totalUnsaved(unsaved) > 0");
    expect(source).toContain("onUnsavedChange={onVolunteerUnsaved}");
    expect(source).toContain("onUnsavedChange={onActivitiesUnsaved}");
    expect(source).toContain("onUnsavedChange={onRosterUnsaved}");
  });
});

describe("attendance edits are kept apart from what the server has (F13)", () => {
  const k = (s: string, u: string) => cellKey(s, u);
  const live: Cells = { [k("s1", "A")]: null, [k("s1", "B")]: 2 };

  it("records only the cells I changed", () => {
    const next: Cells = { ...live, [k("s2", "A")]: null };
    expect(editsFrom(live, next)).toEqual({
      [k("s2", "A")]: { attended: true, hoursOverride: null },
    });
    const unticked: Cells = { [k("s1", "A")]: null };
    expect(editsFrom(live, unticked)).toEqual({
      [k("s1", "B")]: { attended: false, hoursOverride: null },
    });
  });

  it("does not untick another editor's tick that arrives in a refetch", () => {
    const edits = editsFrom(live, { ...live, [k("s2", "A")]: null });
    // Someone else ticks C meanwhile; the server now has it.
    const refetched: Cells = { ...live, [k("s1", "C")]: null };

    const shown = applyEdits(refetched, edits);

    expect(shown[k("s1", "C")]).toBeNull();
    expect(k("s1", "C") in shown).toBe(true);
    expect(k("s2", "A") in shown).toBe(true);
    // What is sent is my tick only: nothing about C.
    expect(gridChanges(refetched, shown).map((c) => c.userID)).toEqual(["A"]);
  });

  it("keeps a tick made while the save was running", () => {
    const submitted = editsFrom(live, { ...live, [k("s2", "A")]: null });
    const now = {
      ...submitted,
      [k("s2", "B")]: { attended: true, hoursOverride: null },
    };

    expect(reconcileEdits(submitted, now)).toEqual({
      [k("s2", "B")]: { attended: true, hoursOverride: null },
    });
  });

  it("keeps a cell that was changed again while saving, and clears the rest", () => {
    const submitted = {
      [k("s2", "A")]: { attended: true, hoursOverride: null },
      [k("s2", "B")]: { attended: true, hoursOverride: null },
    };
    const now = {
      ...submitted,
      [k("s2", "B")]: { attended: true, hoursOverride: 1.5 },
    };

    expect(reconcileEdits(submitted, now)).toEqual({
      [k("s2", "B")]: { attended: true, hoursOverride: 1.5 },
    });
  });

  it("leaves nothing when nothing changed during the save", () => {
    const submitted = editsFrom(live, { ...live, [k("s2", "A")]: null });
    expect(reconcileEdits(submitted, submitted)).toBeNull();
    expect(reconcileEdits(submitted, null)).toBeNull();
  });

  it("the grid is disabled while saving", () => {
    const source = readFileSync(
      "src/app/cca/[ccaID]/transcript/_components/VolunteerAttendance.tsx",
      "utf8",
    );
    expect(source).toContain("readOnly={readOnly || save.isPending}");
  });
});

describe("a failed refresh keeps the editors (F14)", () => {
  it("words the non-blocking banner", () => {
    expect(REFRESH_FAILED_NOTE).toBe(
      "Couldn't refresh. Your changes are still here.",
    );
  });

  it("the tab and the volunteer editor show the blocking error only without data", () => {
    const tab = readFileSync(
      "src/app/cca/[ccaID]/transcript/_components/TranscriptTab.tsx",
      "utf8",
    );
    expect(tab).toContain("roster.error && !roster.data");
    expect(tab).toContain("REFRESH_FAILED_NOTE");
    const editor = readFileSync(
      "src/app/cca/[ccaID]/transcript/_components/VolunteerEditor.tsx",
      "utf8",
    );
    expect(editor).toContain("if (!detail.data)");
    expect(editor).not.toContain("detail.error || !detail.data");
    expect(editor).toContain("refreshFailed={detail.error != null}");
  });
});

describe("create then people (F22)", () => {
  it("does not create a second activity when the people step failed and Save is pressed again", async () => {
    let createdID: string | null = null;
    const create = vi.fn(() => Promise.resolve({ id: "act-1" }));
    const update = vi.fn(() => Promise.resolve());
    const setPeople = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(undefined);
    const list = vi.fn();
    const run = () =>
      saveThenPeople({
        existingID: createdID,
        create,
        update,
        setPeople,
        onCreated: (id) => {
          createdID = id;
          list();
        },
      });

    await expect(run()).rejects.toThrow("network");
    // The list was refreshed as soon as the activity existed.
    expect(list).toHaveBeenCalledTimes(1);
    expect(createdID).toBe("act-1");

    await expect(run()).resolves.toBe("act-1");

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("act-1");
    expect(setPeople).toHaveBeenCalledTimes(2);
    expect(setPeople).toHaveBeenLastCalledWith("act-1");
  });

  it("both editors save through it", () => {
    for (const name of ["ActivityEditor", "VolunteerEditor"]) {
      const source = readFileSync(
        `src/app/cca/[ccaID]/transcript/_components/${name}.tsx`,
        "utf8",
      );
      expect(source, name).toContain("saveThenPeople(");
    }
  });
});

describe("a role period fit is worked out outside the state updater (F25)", () => {
  const blank: RowDraft = draftOf({
    duration: null,
    roleLabel: null,
    roleDuration: null,
    extraContribution: null,
  });

  it("returns the fitted draft and its note together, without side effects", () => {
    const draft: RowDraft = {
      ...blank,
      roleLabel: "Treasurer",
      roleDuration: "sem1",
    };
    const before = structuredClone(draft);

    const result = applyDraftPatch(draft, { duration: "sem2" });

    expect(result.draft).toMatchObject({
      duration: "sem2",
      roleDuration: "sem2",
    });
    expect(result.note).toBe(
      "Role period changed to Semester 2 only to match membership.",
    );
    expect(draft).toEqual(before);
  });

  it("gives no note for a change that is not to the membership", () => {
    const result = applyDraftPatch(blank, { roleLabel: "Head" });
    expect(result.note).toBeNull();
    expect(result.draft.roleLabel).toBe("Head");
  });

  it("MembershipForm no longer sets state from inside an updater", () => {
    const source = readFileSync(
      "src/app/admin/transcripts/residents/_components/MembershipForm.tsx",
      "utf8",
    );
    expect(source).toContain("applyDraftPatch(draft, patch)");
    expect(source).not.toMatch(/setDraft\(\(d\)/);
  });
});
