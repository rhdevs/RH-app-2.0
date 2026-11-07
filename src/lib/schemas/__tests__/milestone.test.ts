import { describe, expect, it } from "vitest";

import {
  EVIDENCE_ATTACH_MARGIN_MS,
  EVIDENCE_ATTACH_MAX_AGE_MS,
  MILESTONE_TEXT_MAX,
  milestoneRateInput,
  milestoneSaveRatingInput,
  milestoneYearInput,
} from "../milestone";
import { EVIDENCE_UNATTACHED_TTL_MS } from "../milestoneEvidence";

const ref = { kind: "event", eventID: 5 } as const;
const seen = "0123456789abcdef";

describe("milestone inputs", () => {
  it.each([0, 6, 2.5, -1, "3"])("a score of %s is refused", (score) => {
    expect(
      milestoneRateInput.safeParse({ ref, seen, score, text: "x" }).success,
    ).toBe(false);
  });

  it("scores 1 to 5 pass", () => {
    for (const score of [1, 2, 3, 4, 5]) {
      expect(
        milestoneRateInput.safeParse({ ref, seen, score, text: "fine" })
          .success,
      ).toBe(true);
    }
  });

  it("the text has a length limit and may not be blank", () => {
    const ok = (text: string) =>
      milestoneRateInput.safeParse({ ref, seen, score: 3, text }).success;
    expect(ok("a".repeat(MILESTONE_TEXT_MAX))).toBe(true);
    expect(ok("a".repeat(MILESTONE_TEXT_MAX + 1))).toBe(false);
    expect(ok("   ")).toBe(false);
  });

  it("a rating names the filing the director looked at (B151)", () => {
    const base = { ref, score: 3, text: "x" };
    expect(milestoneRateInput.safeParse(base).success).toBe(false);
    expect(
      milestoneRateInput.safeParse({ ...base, seen: "not a token" }).success,
    ).toBe(false);
    expect(milestoneRateInput.safeParse({ ...base, seen }).success).toBe(true);
  });

  it("a save names the version it read, or null for none", () => {
    const base = { ref, score: 3, text: "x" };
    expect(
      milestoneSaveRatingInput.safeParse({ ...base, expectedVersion: null })
        .success,
    ).toBe(true);
    expect(milestoneSaveRatingInput.safeParse(base).success).toBe(false);
  });

  it("the year must be a real academic year", () => {
    const year = (y?: string) =>
      milestoneYearInput.safeParse({ ccaID: 1, year: y }).success;
    expect(year("AY2026/27")).toBe(true);
    expect(year("AY2026/28")).toBe(false);
    expect(year()).toBe(true);
  });

  it("the attach cut-off is the TTL minus the named margin", () => {
    expect(EVIDENCE_ATTACH_MAX_AGE_MS).toBe(
      EVIDENCE_UNATTACHED_TTL_MS - EVIDENCE_ATTACH_MARGIN_MS,
    );
  });
});
