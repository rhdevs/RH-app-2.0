import { describe, expect, it } from "vitest";
import { CCA_DESCRIPTION_MAX, ccaDescriptionText } from "../ccaDescription";

describe("ccaDescriptionText", () => {
  it("keeps a short description as it is", () => {
    expect(ccaDescriptionText("A hall CCA.")).toBe("A hall CCA.");
  });

  it("keeps a description of exactly 180 characters whole", () => {
    const text = `${"a".repeat(89)} ${"b".repeat(90)}`;
    expect(text).toHaveLength(CCA_DESCRIPTION_MAX);
    expect(ccaDescriptionText(text)).toBe(text);
  });

  it("cuts a long description at the last word boundary and adds an ellipsis", () => {
    const text = "word ".repeat(60).trim();
    const out = ccaDescriptionText(text);
    expect(out.endsWith("word…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(CCA_DESCRIPTION_MAX + 1);
  });

  it("cuts at 180 when the word boundary is exactly there", () => {
    const text = `${"a".repeat(179)} ${"b".repeat(50)}`;
    expect(ccaDescriptionText(text)).toBe(`${"a".repeat(179)}…`);
  });

  it("cuts a single long word at 180", () => {
    expect(ccaDescriptionText("x".repeat(300))).toBe(`${"x".repeat(180)}…`);
  });

  it("collapses whitespace before measuring", () => {
    expect(ccaDescriptionText("  a \n\t b   c  ")).toBe("a b c");
  });

  it("is blank for a missing, empty or whitespace-only description", () => {
    expect(ccaDescriptionText(null)).toBe("");
    expect(ccaDescriptionText(undefined)).toBe("");
    expect(ccaDescriptionText("")).toBe("");
    expect(ccaDescriptionText("   \n ")).toBe("");
  });
});
