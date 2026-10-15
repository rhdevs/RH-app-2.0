import { describe, expect, it } from "vitest";
import {
  NOT_AVAILABLE_NOTES,
  VERIFY_NOTES,
  parseAyParam,
  resolveSiteOrigin,
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
  it("states each verify outcome plainly", () => {
    expect(VERIFY_NOTES.valid).toBe("This record is valid.");
    expect(VERIFY_NOTES.revoked).toBe("This record has been revoked.");
    expect(VERIFY_NOTES.rate_limited).toBe(
      "Too many attempts. Try again later.",
    );
    expect(VERIFY_NOTES.superseded).toMatch(/superseded by a later version/);
    expect(VERIFY_NOTES.not_found).not.toMatch(/close|similar|did you mean/i);
  });

  it("names the year in the not-available headline and promises no date", () => {
    expect(NOT_AVAILABLE_NOTES.headline("AY2026/27")).toBe(
      "Your transcript for AY2026/27 isn’t available yet.",
    );
    expect(NOT_AVAILABLE_NOTES.detail).toBe(
      "It opens once the hall publishes transcripts.",
    );
  });
});

describe("resolveSiteOrigin", () => {
  it("prefers the request host and its protocol", () => {
    expect(
      resolveSiteOrigin({
        host: "rhapp.example.org",
        proto: "https",
        envUrl: "https://other.example.org",
      }),
    ).toBe("https://rhapp.example.org");
  });

  it("uses http for localhost when no protocol is given", () => {
    expect(resolveSiteOrigin({ host: "localhost:3000" })).toBe(
      "http://localhost:3000",
    );
  });

  it("assumes https for a public host with no protocol header", () => {
    expect(resolveSiteOrigin({ host: "Example.org" })).toBe(
      "https://example.org",
    );
  });

  it("takes the first entry of a forwarded chain", () => {
    expect(
      resolveSiteOrigin({
        host: "a.example.org, b.example.org",
        proto: "https, http",
      }),
    ).toBe("https://a.example.org");
  });

  it("rejects a host that is not a plain hostname and falls back to NEXTAUTH_URL", () => {
    for (const host of [
      "evil.com/path",
      "a b",
      "x@evil.com",
      "javascript:alert(1)",
      "",
      "<b>",
    ]) {
      expect(
        resolveSiteOrigin({
          host,
          envUrl: "https://hall.example.org/some/path",
        }),
      ).toBe("https://hall.example.org");
    }
  });

  it("is null when nothing usable is available", () => {
    expect(resolveSiteOrigin({})).toBeNull();
    expect(resolveSiteOrigin({ host: null, envUrl: "not a url" })).toBeNull();
    expect(resolveSiteOrigin({ envUrl: "ftp://files.example.org" })).toBeNull();
  });
});
