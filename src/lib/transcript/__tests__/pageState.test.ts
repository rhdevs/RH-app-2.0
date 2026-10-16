import { describe, expect, it } from "vitest";
import {
  NOT_AVAILABLE_NOTES,
  choiceLabel,
  parseAyParam,
  selectTranscriptState,
} from "../pageState";

describe("parseAyParam", () => {
  it.each([
    ["2026-27", "AY2026/27"],
    ["AY2026/27", "AY2026/27"],
    [" 2026-27 ", "AY2026/27"],
    [["2026-27", "2027-28"], "AY2026/27"],
  ])("reads %j as %j", (raw, expected) => {
    expect(parseAyParam(raw)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "2026",
    "2026-28",
    "26-27",
    "abc",
    "2026-27; DROP TABLE",
    "x".repeat(40),
    [],
  ])("returns null for %j rather than throwing", (raw) => {
    expect(parseAyParam(raw)).toBeNull();
  });
});

describe("selectTranscriptState", () => {
  const pub = (academicYear: string) => ({ academicYear, draft: false });
  const draft = (academicYear: string) => ({ academicYear, draft: true });
  const base = {
    authenticated: true,
    viewable: [pub("AY2025/26")],
    requested: null,
    currentAcademicYear: "AY2026/27",
  };
  const labels = (state: ReturnType<typeof selectTranscriptState>) =>
    state.kind === "show" ? state.choices.map((c) => c.label) : null;

  it("sends an unauthenticated visitor to sign in, whatever else is true", () => {
    expect(selectTranscriptState({ ...base, authenticated: false })).toEqual({
      kind: "unauthenticated",
    });
  });

  it("shows only the calm page, with no switcher, when nothing is published and the year is collecting", () => {
    expect(selectTranscriptState({ ...base, viewable: [] })).toEqual({
      kind: "none_published",
      currentAcademicYear: "AY2026/27",
    });
  });

  it("defaults to the latest published year, however the list is ordered", () => {
    const state = selectTranscriptState({
      ...base,
      viewable: [pub("AY2026/27"), pub("AY2025/26")],
    });
    expect(state).toMatchObject({
      kind: "show",
      academicYear: "AY2026/27",
      view: "published",
      showSwitcher: true,
    });
    expect(labels(state)).toEqual(["AY2025/26", "AY2026/27"]);
  });

  it("offers the collecting current year as 'not yet available', after the published ones", () => {
    const state = selectTranscriptState(base);
    expect(labels(state)).toEqual([
      "AY2025/26",
      "AY2026/27 (not yet available)",
    ]);
    expect(state).toMatchObject({
      academicYear: "AY2025/26",
      view: "published",
      showSwitcher: true,
    });
  });

  it("shows a published year when it is requested, and the draft entry the draft", () => {
    const withDraft = {
      ...base,
      viewable: [pub("AY2025/26"), draft("AY2026/27")],
    };
    expect(labels(selectTranscriptState(withDraft))).toEqual([
      "AY2025/26",
      "AY2026/27 (draft)",
    ]);
    expect(
      selectTranscriptState({ ...withDraft, requested: "AY2026/27" }),
    ).toMatchObject({ academicYear: "AY2026/27", view: "draft" });
    expect(
      selectTranscriptState({ ...withDraft, requested: "AY2025/26" }),
    ).toMatchObject({ academicYear: "AY2025/26", view: "published" });
  });

  it("opens the current year's 'not yet available' page when it is requested, never falling back", () => {
    expect(
      selectTranscriptState({ ...base, requested: "AY2026/27" }),
    ).toMatchObject({ academicYear: "AY2026/27", view: "unavailable" });
  });

  it("falls back to the latest published year for any other year asked for", () => {
    for (const requested of ["AY2030/31", "AY2020/21", null]) {
      expect(selectTranscriptState({ ...base, requested })).toMatchObject({
        academicYear: "AY2025/26",
        view: "published",
      });
    }
  });

  it("shows the switcher when the current year is closed even with nothing published", () => {
    const state = selectTranscriptState({
      ...base,
      viewable: [draft("AY2026/27")],
    });
    expect(state).toMatchObject({
      kind: "show",
      academicYear: "AY2026/27",
      view: "draft",
      showSwitcher: true,
    });
    expect(labels(state)).toEqual(["AY2026/27 (draft)"]);
  });

  it("does not mutate the list it is given", () => {
    const viewable = [pub("AY2026/27"), pub("AY2025/26")];
    selectTranscriptState({ ...base, viewable });
    expect(viewable.map((y) => y.academicYear)).toEqual([
      "AY2026/27",
      "AY2025/26",
    ]);
  });
});

describe("choiceLabel", () => {
  it("says what each year is", () => {
    expect(choiceLabel("AY2026/27", "published")).toBe("AY2026/27");
    expect(choiceLabel("AY2026/27", "draft")).toBe("AY2026/27 (draft)");
    expect(choiceLabel("AY2026/27", "unavailable")).toBe(
      "AY2026/27 (not yet available)",
    );
  });
});

describe("wording", () => {
  it("names the year in the not-available headline and promises no date", () => {
    expect(NOT_AVAILABLE_NOTES.headline("AY2026/27")).toBe(
      "Your transcript for AY2026/27 isn’t available yet.",
    );
    expect(NOT_AVAILABLE_NOTES.detail).toBe(
      "It opens once the hall publishes transcripts.",
    );
  });
});
