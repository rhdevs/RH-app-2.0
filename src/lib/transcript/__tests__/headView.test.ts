import { describe, expect, it } from "vitest";
import {
  EXTRA_MAX,
  PUBLISHED_NOTE,
  ROLE_MAX,
  counterText,
  draftOf,
  durationOptions,
  headYearOptions,
  isDirty,
  remainingCharacters,
  rowProblem,
  upsertFields,
} from "../headView";
import { rosterUpsertInput } from "../manageInput";

const saved = draftOf({
  duration: null,
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
});

describe("duration option labels", () => {
  it("has no Default entry: a full year is the default", () => {
    expect(durationOptions().map((o) => o.label)).toEqual([
      "Full year",
      "Semester 1 only",
      "Semester 2 only",
    ]);
    expect(durationOptions().map((o) => o.value)).toEqual(["", "sem1", "sem2"]);
  });

  it("never shows 'Default (...)'", () => {
    expect(JSON.stringify(durationOptions())).not.toContain("Default");
  });
});

describe("dirty-row detection", () => {
  it("is clean for an unchanged row, however blank is spelled", () => {
    expect(isDirty(saved, saved)).toBe(false);
    expect(isDirty({ ...saved, roleLabel: "   " }, saved)).toBe(false);
    expect(isDirty({ ...saved, extra: "\r\n" }, saved)).toBe(false);
  });

  it("is dirty after any field changes", () => {
    expect(isDirty({ ...saved, duration: "sem1" }, saved)).toBe(true);
    expect(isDirty({ ...saved, roleLabel: "Treasurer" }, saved)).toBe(true);
    expect(isDirty({ ...saved, roleDuration: "sem2" }, saved)).toBe(true);
    expect(isDirty({ ...saved, extra: "Ran the fair" }, saved)).toBe(true);
  });

  it("ignores surrounding whitespace and line-ending style", () => {
    const base = { ...saved, extra: "a\nb" };
    expect(isDirty({ ...saved, extra: " a\r\nb " }, base)).toBe(false);
  });

  it("is clean again when an edit is undone", () => {
    const edited = { ...saved, duration: "sem2" as const };
    expect(isDirty(edited, saved)).toBe(true);
    expect(isDirty({ ...edited, duration: "" }, saved)).toBe(false);
  });

  it("reads stored overrides, ignoring unknown durations", () => {
    expect(
      draftOf({
        duration: "sem2",
        roleLabel: "Head",
        roleDuration: "garbage",
        extraContribution: "x",
      }),
    ).toEqual({
      duration: "sem2",
      roleLabel: "Head",
      roleDuration: "",
      extra: "x",
    });
  });
});

describe("what a row sends to the server", () => {
  it("sends null for default and blank, so they clear", () => {
    expect(upsertFields(saved)).toEqual({
      duration: null,
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
  });

  it("trims text and keeps explicit durations", () => {
    expect(
      upsertFields({
        duration: "sem1",
        roleLabel: " Treasurer ",
        roleDuration: "sem2",
        extra: " Ran the fair\r\n",
      }),
    ).toEqual({
      duration: "sem1",
      roleLabel: "Treasurer",
      roleDuration: "sem2",
      extraContribution: "Ran the fair",
    });
  });

  it("produces input the server accepts", () => {
    const parsed = rosterUpsertInput.safeParse({
      ccaID: 9005,
      academicYear: "AY2026/27",
      userID: "SEED-R12",
      ...upsertFields({
        duration: "sem2",
        roleLabel: "Treasurer",
        roleDuration: "",
        extra: "Ran the fair",
      }),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("limits", () => {
  it("match the server's", () => {
    expect(ROLE_MAX).toBe(60);
    expect(EXTRA_MAX).toBe(500);
    const ok = rosterUpsertInput.safeParse({
      ccaID: 1,
      academicYear: "AY2026/27",
      userID: "X",
      roleLabel: "r".repeat(60),
      extraContribution: "e".repeat(500),
    });
    const tooLong = rosterUpsertInput.safeParse({
      ccaID: 1,
      academicYear: "AY2026/27",
      userID: "X",
      roleLabel: "r".repeat(61),
    });
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });

  it("counts characters left, never below zero", () => {
    expect(remainingCharacters("abc", 10)).toBe(7);
    expect(remainingCharacters("abc", 2)).toBe(0);
    expect(counterText("", 500)).toBe("500 characters left");
  });

  it("flags text over a limit", () => {
    expect(
      rowProblem({ ...saved, roleLabel: "r".repeat(ROLE_MAX + 1) }),
    ).toMatch(/at most 60/);
    expect(rowProblem({ ...saved, extra: "e".repeat(EXTRA_MAX + 1) })).toMatch(
      /at most 500/,
    );
    expect(rowProblem(saved)).toBeNull();
  });
});

describe("wording and years", () => {
  it("states the published note in plain words", () => {
    expect(PUBLISHED_NOTE("AY2026/27")).toBe(
      "Transcripts for AY2026/27 are open. Editing is closed. Ask the JCRC to fix individual residents.",
    );
  });

  it("lists academic years from AY2026/27 to the current one, newest first", () => {
    expect(headYearOptions(2026)).toEqual(["AY2026/27"]);
    expect(headYearOptions(2028)).toEqual([
      "AY2028/29",
      "AY2027/28",
      "AY2026/27",
    ]);
    expect(headYearOptions(2020)).toEqual(["AY2026/27"]);
  });
});
