import { describe, expect, it, vi } from "vitest";
import {
  PERSON_DESCRIPTION_PLACEHOLDER,
  ROLE_PLACEHOLDER,
  activityFields,
  addPerson,
  clearAll,
  editorOf,
  editorProblem,
  emptyEditor,
  filterMembers,
  isEditorDirty,
  outsiders,
  participantsPayload,
  patchPerson,
  peopleCountLine,
  removePerson,
  selectAll,
  togglePerson,
} from "../activityEditor";
import { errorText } from "../adminView";
import { DISCARD_CHANGES_QUESTION, mayLeave } from "../useUnsavedChangesGuard";

const A = { userID: "a", displayName: "Alice Tan" };
const B = { userID: "b", displayName: "Bob Lim" };
const C = { userID: "c", displayName: "Cara Ng" };
const MEMBERS = [A, B, C];

describe("activity editor state", () => {
  it("starts empty with a full-year period", () => {
    expect(emptyEditor()).toEqual({
      activity: { title: "", description: "", period: "full" },
      people: [],
    });
  });

  it("reads a saved activity, treating an unknown period as the full year", () => {
    const state = editorOf({
      title: "T",
      description: "D",
      period: "weird",
      participants: [{ ...A, role: "Lead", description: "" }],
    });
    expect(state.activity.period).toBe("full");
    expect(state.people).toEqual([{ ...A, role: "Lead", description: "" }]);
  });

  it("ticks and unticks a person, and never ticks one twice", () => {
    let s = togglePerson(emptyEditor(), A);
    expect(s.people.map((p) => p.userID)).toEqual(["a"]);
    s = addPerson(s, A);
    expect(s.people).toHaveLength(1);
    s = togglePerson(s, A);
    expect(s.people).toEqual([]);
  });

  it("does not mutate the state it is given", () => {
    const s = emptyEditor();
    const before = JSON.stringify(s);
    togglePerson(s, A);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("selects and clears only the people shown by the filter", () => {
    const shown = filterMembers(MEMBERS, "  a");
    expect(shown.map((m) => m.userID)).toEqual(["a", "c"]);

    let s = selectAll(emptyEditor(), shown);
    expect(s.people.map((p) => p.userID)).toEqual(["a", "c"]);
    s = selectAll(s, MEMBERS);
    expect(s.people.map((p) => p.userID)).toEqual(["a", "c", "b"]);
    s = clearAll(s, shown);
    expect(s.people.map((p) => p.userID)).toEqual(["b"]);
  });

  it("keeps people from outside the CCA when members are cleared", () => {
    const outsider = { userID: "z", displayName: "Zed" };
    let s = addPerson(selectAll(emptyEditor(), MEMBERS), outsider);
    expect(outsiders(s, MEMBERS).map((p) => p.userID)).toEqual(["z"]);
    s = clearAll(s, MEMBERS);
    expect(s.people.map((p) => p.userID)).toEqual(["z"]);
    expect(removePerson(s, "z").people).toEqual([]);
  });

  it("filters by name in any case and shows everyone for a blank filter", () => {
    expect(filterMembers(MEMBERS, "BOB").map((m) => m.userID)).toEqual(["b"]);
    expect(filterMembers(MEMBERS, "   ")).toHaveLength(3);
    expect(filterMembers(MEMBERS, "nobody")).toEqual([]);
  });

  it("falls back to the key when a member has no name", () => {
    expect(
      filterMembers([{ userID: "e0001", displayName: null }], "e00"),
    ).toHaveLength(1);
  });

  it("customises one person without touching the others", () => {
    let s = selectAll(emptyEditor(), [A, B]);
    s = patchPerson(s, "a", { role: "Lead" });
    expect(s.people.map((p) => p.role)).toEqual(["Lead", ""]);
  });

  it("builds the participants.set payload with trimmed text", () => {
    let s = selectAll(emptyEditor(), [A]);
    s = patchPerson(s, "a", { role: "  Lead ", description: " did it " });
    expect(participantsPayload(s)).toEqual([
      { userID: "a", role: "Lead", description: "did it" },
    ]);
    expect(
      activityFields({ title: " T ", description: "", period: "sem1" }),
    ).toEqual({ title: "T", description: "", period: "sem1" });
  });

  it("explains how to leave a role or description empty", () => {
    expect(ROLE_PLACEHOLDER).toBe("Leave empty if no role");
    expect(PERSON_DESCRIPTION_PLACEHOLDER).toBe(
      "What they did; leave empty to use the general description",
    );
  });
});

describe("activity editor dirty tracking and problems", () => {
  const saved = editorOf({
    title: "Concert",
    description: "",
    period: "full",
    participants: [{ ...A, role: "", description: "" }],
  });

  it("is clean when nothing changed, whatever the order or blank spelling", () => {
    expect(isEditorDirty(saved, saved)).toBe(false);
    const reworded = {
      ...saved,
      activity: { ...saved.activity, title: "  Concert " },
    };
    expect(isEditorDirty(reworded, saved)).toBe(false);
  });

  it("is dirty after any change to the activity or its people", () => {
    expect(
      isEditorDirty(
        { ...saved, activity: { ...saved.activity, period: "sem2" } },
        saved,
      ),
    ).toBe(true);
    expect(isEditorDirty(addPerson(saved, B), saved)).toBe(true);
    expect(isEditorDirty(removePerson(saved, "a"), saved)).toBe(true);
    expect(
      isEditorDirty(patchPerson(saved, "a", { role: "Lead" }), saved),
    ).toBe(true);
  });

  it("flags a missing title and over-long text before the server does", () => {
    expect(editorProblem(emptyEditor())).toMatch(/title/);
    const base = { ...emptyEditor(), activity: { ...saved.activity } };
    expect(editorProblem(base)).toBeNull();
    expect(
      editorProblem({
        ...base,
        activity: { ...base.activity, title: "x".repeat(81) },
      }),
    ).toMatch(/80/);
    expect(
      editorProblem({
        ...base,
        activity: { ...base.activity, description: "x".repeat(301) },
      }),
    ).toMatch(/300/);
    expect(
      editorProblem(
        patchPerson(selectAll(base, [A]), "a", { role: "x".repeat(61) }),
      ),
    ).toMatch(/60/);
  });

  it("counts people in plain words", () => {
    expect(peopleCountLine(1)).toBe("1 person selected");
    expect(peopleCountLine(3)).toBe("3 people selected");
  });
});

describe("unsaved-changes guard decision", () => {
  it("lets you leave without asking when nothing is unsaved", () => {
    const ask = vi.fn(() => false);
    expect(mayLeave(false, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks once and obeys the answer when there are unsaved changes", () => {
    expect(mayLeave(true, () => true)).toBe(true);
    const ask = vi.fn(() => false);
    expect(mayLeave(true, ask)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(DISCARD_CHANGES_QUESTION).toMatch(/unsaved/);
  });
});

describe("activity error wording", () => {
  it("turns the new server codes into sentences", () => {
    expect(errorText("ACTIVITY_REMOVED")).toMatch(/Restore/);
    expect(errorText("TOO_MANY_AT_ONCE")).toMatch(/smaller steps/);
    expect(errorText("DUPLICATE_PARTICIPANT")).toMatch(/twice/);
    expect(errorText("ACTIVITY_NOT_FOUND")).toMatch(/no longer/);
    expect(errorText("NOT_A_CCA_HEAD")).toMatch(/CCA heads/);
  });
});
