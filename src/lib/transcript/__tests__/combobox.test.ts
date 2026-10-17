import { describe, expect, it } from "vitest";
import {
  COMBO_CLOSED,
  comboReduce,
  listboxId,
  optionId,
  type ComboState,
} from "../combobox";

const open = (active: number): ComboState => ({ open: true, active });

describe("resident picker keyboard handling", () => {
  it("opens with nothing active as the person types", () => {
    expect(comboReduce(COMBO_CLOSED, "Type", 3).state).toEqual(open(-1));
    expect(comboReduce(open(2), "Type", 3).state).toEqual(open(-1));
  });

  it("ArrowDown opens a closed list on the first option, then moves, wrapping at the end", () => {
    expect(comboReduce(COMBO_CLOSED, "ArrowDown", 3).state).toEqual(open(0));
    expect(comboReduce(open(-1), "ArrowDown", 3).state).toEqual(open(0));
    expect(comboReduce(open(0), "ArrowDown", 3).state).toEqual(open(1));
    expect(comboReduce(open(2), "ArrowDown", 3).state).toEqual(open(0));
  });

  it("ArrowUp opens a closed list on the last option, then moves, wrapping at the start", () => {
    expect(comboReduce(COMBO_CLOSED, "ArrowUp", 3).state).toEqual(open(2));
    expect(comboReduce(open(-1), "ArrowUp", 3).state).toEqual(open(2));
    expect(comboReduce(open(2), "ArrowUp", 3).state).toEqual(open(1));
    expect(comboReduce(open(0), "ArrowUp", 3).state).toEqual(open(2));
  });

  it("stops the browser from moving the caret when it handles an arrow", () => {
    expect(comboReduce(open(0), "ArrowDown", 3).prevent).toBe(true);
    expect(comboReduce(open(0), "ArrowUp", 3).prevent).toBe(true);
  });

  it("does nothing on an arrow when there are no options", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"] as const) {
      const result = comboReduce(open(-1), key, 0);
      expect(result.state).toEqual(open(-1));
      expect(result.pick).toBeNull();
      expect(result.prevent).toBe(false);
    }
  });

  it("Home and End jump to the first and last option of an open list", () => {
    expect(comboReduce(open(1), "Home", 4).state).toEqual(open(0));
    expect(comboReduce(open(1), "End", 4).state).toEqual(open(3));
    expect(comboReduce(COMBO_CLOSED, "End", 4).state).toEqual(COMBO_CLOSED);
  });

  it("Enter picks the active option and closes the list", () => {
    const result = comboReduce(open(1), "Enter", 3);

    expect(result.pick).toBe(1);
    expect(result.state).toEqual(COMBO_CLOSED);
    expect(result.prevent).toBe(true);
  });

  it("Enter without an active option picks nothing and is left alone", () => {
    for (const state of [open(-1), COMBO_CLOSED, open(5)]) {
      const result = comboReduce(state, "Enter", 3);
      expect(result.pick).toBeNull();
      expect(result.prevent).toBe(false);
    }
  });

  it("Escape closes an open list and keeps the typed text out of it", () => {
    const result = comboReduce(open(2), "Escape", 3);

    expect(result.state).toEqual(COMBO_CLOSED);
    expect(result.prevent).toBe(true);
    // Already closed: Escape is not swallowed.
    expect(comboReduce(COMBO_CLOSED, "Escape", 3).prevent).toBe(false);
  });

  it("derives the ids the ARIA attributes point at", () => {
    expect(listboxId("volunteer")).toBe("volunteer-listbox");
    expect(optionId("volunteer", 2)).toBe("volunteer-option-2");
  });
});
