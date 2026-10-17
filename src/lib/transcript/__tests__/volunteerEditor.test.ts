import { describe, expect, it } from "vitest";
import {
  addPerson,
  clearAll,
  emptyVolunteerDraft,
  hoursText,
  isVolunteerDirty,
  outsiders,
  parseVolunteerHours,
  removePerson,
  selectAll,
  togglePerson,
  volunteerDraftOf,
  volunteerFields,
  volunteerProblem,
} from "../volunteerEditor";

const A = { userID: "a", displayName: "Alice" };
const B = { userID: "b", displayName: "Bob" };

describe("volunteer editor", () => {
  it("starts as a regular activity with nobody", () => {
    expect(emptyVolunteerDraft()).toMatchObject({
      kind: "regular",
      title: "",
      people: [],
    });
  });

  it("reads a saved one-off with its session", () => {
    const d = volunteerDraftOf({
      title: "Beach clean-up",
      kind: "oneoff",
      description: "",
      defaultHours: null,
      people: [A],
      session: { date: "2026-11-02", hours: 3.5 },
    });
    expect(d).toMatchObject({
      kind: "oneoff",
      date: "2026-11-02",
      hours: "3.5",
      defaultHours: "",
    });
  });

  it("parses hours as quarter hours or null", () => {
    expect(parseVolunteerHours("1.5")).toBe(1.5);
    expect(parseVolunteerHours(" 24 ")).toBe(24);
    for (const bad of ["", "0", "0.1", "25", "abc", "1.3"]) {
      expect(parseVolunteerHours(bad), bad).toBeNull();
    }
    expect(hoursText("")).toBeNull();
    expect(hoursText("abc")).toMatch(/number/);
    expect(hoursText("0")).toMatch(/at least 0.25/);
    expect(hoursText("25")).toMatch(/at most 24/);
    expect(hoursText("1.3")).toMatch(/steps of 0.25/);
  });

  it("needs a title, and for a one-off a date and hours", () => {
    expect(volunteerProblem(emptyVolunteerDraft())).toMatch(/title/);
    const regular = { ...emptyVolunteerDraft(), title: "Tuition" };
    expect(volunteerProblem(regular)).toBeNull();
    const oneoff = { ...regular, kind: "oneoff" as const };
    expect(volunteerProblem(oneoff)).toMatch(/date/);
    expect(volunteerProblem({ ...oneoff, date: "2026-11-02" })).toMatch(
      /hours/,
    );
    expect(
      volunteerProblem({ ...oneoff, date: "2026-11-02", hours: "3" }),
    ).toBeNull();
  });

  it("flags over-long text and a bad default", () => {
    const base = { ...emptyVolunteerDraft(), title: "T" };
    expect(volunteerProblem({ ...base, title: "x".repeat(81) })).toMatch(/80/);
    expect(volunteerProblem({ ...base, description: "x".repeat(301) })).toMatch(
      /300/,
    );
    expect(volunteerProblem({ ...base, defaultHours: "30" })).toMatch(/24/);
  });

  it("is dirty after any change, and not when only spelling differs", () => {
    const saved = volunteerDraftOf({
      title: "T",
      kind: "regular",
      description: "",
      defaultHours: 1,
      people: [A],
    });
    expect(isVolunteerDirty(saved, saved)).toBe(false);
    expect(isVolunteerDirty({ ...saved, title: " T " }, saved)).toBe(false);
    expect(isVolunteerDirty({ ...saved, title: "U" }, saved)).toBe(true);
    expect(isVolunteerDirty(addPerson(saved, B), saved)).toBe(true);
    expect(isVolunteerDirty(removePerson(saved, "a"), saved)).toBe(true);
    expect(isVolunteerDirty({ ...saved, defaultHours: "2" }, saved)).toBe(true);
  });

  it("ticks, selects all and clears the people shown, keeping outsiders", () => {
    let d = selectAll(emptyVolunteerDraft(), [A, B]);
    expect(d.people.map((p) => p.userID)).toEqual(["a", "b"]);
    d = addPerson(d, { userID: "z", displayName: "Zed" });
    expect(outsiders(d, [A, B]).map((p) => p.userID)).toEqual(["z"]);
    d = clearAll(d, [A, B]);
    expect(d.people.map((p) => p.userID)).toEqual(["z"]);
    expect(togglePerson(d, A).people).toHaveLength(2);
    expect(togglePerson(togglePerson(d, A), A).people).toHaveLength(1);
  });

  it("does not mutate the draft it is given", () => {
    const d = emptyVolunteerDraft();
    const snapshot = JSON.stringify(d);
    addPerson(d, A);
    selectAll(d, [A, B]);
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("builds the create / update fields", () => {
    expect(
      volunteerFields({
        ...emptyVolunteerDraft(),
        title: " Tuition ",
        defaultHours: "1.5",
      }),
    ).toEqual({ title: "Tuition", description: "", defaultHours: 1.5 });
    expect(
      volunteerFields({ ...emptyVolunteerDraft(), title: "T" }).defaultHours,
    ).toBeNull();
  });
});
