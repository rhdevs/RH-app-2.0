import { describe, expect, it } from "vitest";

import { decideCapCommit, parseCap } from "../capInput";

describe("parseCap", () => {
  it.each([
    ["", null],
    ["   ", null],
    [" 12 ", 12],
    ["1", 1],
    ["99", 99],
    ["0", null],
    ["100", null],
    ["12.5", null],
    ["-3", null],
    ["abc", null],
    ["007", 7],
  ])("parses %j as %j", (text, expected) => {
    expect(parseCap(text)).toBe(expected);
  });
});

describe("decideCapCommit", () => {
  it("does nothing for a blank box over no stored cap", () => {
    expect(decideCapCommit("", null)).toEqual({ kind: "noop" });
    expect(decideCapCommit("  ", null)).toEqual({ kind: "noop" });
  });

  it("clears the cap when the box is blanked", () => {
    expect(decideCapCommit("", 7)).toEqual({ kind: "save", cap: null });
  });

  it("treats the same number as a no-op however it is typed", () => {
    expect(decideCapCommit("7", 7)).toEqual({ kind: "noop" });
    expect(decideCapCommit("007", 7)).toEqual({ kind: "noop" });
    expect(decideCapCommit(" 7 ", 7)).toEqual({ kind: "noop" });
  });

  it("saves a new valid number, trimmed", () => {
    expect(decideCapCommit(" 12 ", 7)).toEqual({ kind: "save", cap: 12 });
    expect(decideCapCommit("5", null)).toEqual({ kind: "save", cap: 5 });
  });

  it.each(["0", "100", "12.5", "abc"])("flags %j as invalid", (text) => {
    expect(decideCapCommit(text, 7)).toEqual({ kind: "invalid" });
    expect(decideCapCommit(text, null)).toEqual({ kind: "invalid" });
  });
});
