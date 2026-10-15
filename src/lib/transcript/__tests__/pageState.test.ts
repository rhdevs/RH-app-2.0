import { describe, expect, it } from "vitest";
import {
  NOT_AVAILABLE_NOTES,
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
  const base = {
    authenticated: true,
    published: ["AY2026/27", "AY2027/28"],
    requested: null,
    currentAcademicYear: "AY2027/28",
  };

  it("sends an unauthenticated visitor to sign in, whatever else is true", () => {
    expect(selectTranscriptState({ ...base, authenticated: false })).toEqual({
      kind: "unauthenticated",
    });
  });

  it("says not available when no year is published", () => {
    expect(selectTranscriptState({ ...base, published: [] })).toEqual({
      kind: "none_published",
      currentAcademicYear: "AY2027/28",
    });
  });

  it("defaults to the latest published year, however the list is ordered", () => {
    const state = selectTranscriptState({
      ...base,
      published: ["AY2027/28", "AY2026/27"],
    });

    expect(state).toEqual({
      kind: "show",
      academicYear: "AY2027/28",
      published: ["AY2026/27", "AY2027/28"],
    });
  });

  it("honours a requested year that is published", () => {
    expect(
      selectTranscriptState({ ...base, requested: "AY2026/27" }),
    ).toMatchObject({ kind: "show", academicYear: "AY2026/27" });
  });

  it("falls back to the latest when the requested year is not published or invalid", () => {
    expect(
      selectTranscriptState({ ...base, requested: "AY2030/31" }),
    ).toMatchObject({ academicYear: "AY2027/28" });
    expect(selectTranscriptState({ ...base, requested: null })).toMatchObject({
      academicYear: "AY2027/28",
    });
  });

  it("does not mutate the published list it is given", () => {
    const published = ["AY2027/28", "AY2026/27"];

    selectTranscriptState({ ...base, published });

    expect(published).toEqual(["AY2027/28", "AY2026/27"]);
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
