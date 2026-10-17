import { describe, expect, it } from "vitest";
import {
  clearIfUnchanged,
  draftOf,
  isDirty,
  reconcileAfterSave,
  upsertFields,
  type RowDraft,
} from "../headView";

const clean = (a: RowDraft, b: RowDraft) => !isDirty(a, b);

describe("what a form shows after a successful save", () => {
  const submitted: RowDraft = {
    duration: "sem2",
    roleLabel: "  Treasurer ",
    roleDuration: "",
    extra: "Ran the fair  ",
  };
  // The server trims, so what it stored differs in spacing from what was typed.
  const stored = draftOf({
    duration: "sem2",
    roleLabel: "Treasurer",
    roleDuration: null,
    extraContribution: "Ran the fair",
  });

  it("shows the saved values and is no longer dirty when nothing changed meanwhile", () => {
    const shown = reconcileAfterSave(submitted, submitted, stored, clean);

    expect(shown).toBe(stored);
    expect(isDirty(shown, stored)).toBe(false);
  });

  it("keeps newer typing, still dirty, when the person kept typing during the save", () => {
    const typedSince = { ...submitted, extra: "Ran the fair and the quiz" };
    const shown = reconcileAfterSave(typedSince, submitted, stored, clean);

    expect(shown).toBe(typedSince);
    expect(isDirty(shown, stored)).toBe(true);
  });

  it("still shows the values saved, not blanks, after a save", () => {
    const sent = upsertFields(submitted);
    expect(sent).toMatchObject({ roleLabel: "Treasurer", duration: "sem2" });
    expect(stored.roleLabel).toBe("Treasurer");
    expect(stored.duration).toBe("sem2");
  });
});

describe("an add form after a successful add", () => {
  it("clears what was added", () => {
    expect(clearIfUnchanged("Beach clean-up", "Beach clean-up")).toBe("");
  });

  it("leaves what was typed for the next entry while the add was in flight", () => {
    expect(clearIfUnchanged("Beach clean-up, part 2", "Beach clean-up")).toBe(
      "Beach clean-up, part 2",
    );
  });
});
