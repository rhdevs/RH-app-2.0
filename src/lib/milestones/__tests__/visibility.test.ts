import { describe, expect, it } from "vitest";

import { neededFrom, visibleParts } from "../visibility";

const sub = (o = {}) => ({
  headScore: 4 as number | null,
  headText: "went well" as string | null,
  headRatedAt: new Date(0) as Date | null,
  frozen: false,
  ...o,
});
const assessment = {
  score: 3,
  text: "ok",
  selfRated: false,
  createdAt: new Date(0),
};
const head = { head: true, director: false };
const director = { head: false, director: true };

describe("blindness (Q15, A55) in the response shape", () => {
  it("a director before rating gets no head key at all", () => {
    const v = visibleParts(director, sub(), null);
    expect("head" in v).toBe(false);
    expect("assessment" in v).toBe(false);
    expect(JSON.stringify(v)).not.toContain("went well");
  });

  it("a director learns nothing about whether the head has rated", () => {
    const rated = visibleParts(director, sub(), null);
    const notRated = visibleParts(
      director,
      sub({ headScore: null, headText: null, headRatedAt: null }),
      null,
    );
    expect(rated).toEqual(notRated);
  });

  it("a head who has rated sees no assessment while none exists", () => {
    const v = visibleParts(head, sub(), null);
    expect(v.head?.score).toBe(4);
    expect("assessment" in v).toBe(false);
  });

  it("a head who never rated sees the director's rating once the filing is frozen (B150)", () => {
    const v = visibleParts(
      head,
      sub({ headScore: null, headText: null, headRatedAt: null, frozen: true }),
      assessment,
    );
    expect(v.assessment?.score).toBe(3);
    expect(v.locked).toBe(true);
    expect(v.head ?? null).toBeNull();
  });

  it("a head who has not rated learns nothing of a rating before the freeze", () => {
    const v = visibleParts(
      head,
      sub({ headScore: null, headText: null, headRatedAt: null }),
      null,
    );
    expect("assessment" in v).toBe(false);
    expect(v.locked).toBe(false);
  });

  it("once both are in, both sides see both", () => {
    for (const viewer of [head, director]) {
      const v = visibleParts(viewer, sub({ frozen: true }), assessment);
      expect(v.head?.score).toBe(4);
      expect(v.assessment?.score).toBe(3);
    }
  });
});

describe("what a person still has to do", () => {
  it("a head with no rating files; a locked one does not", () => {
    expect(neededFrom(head, null, 0, null)).toEqual(["file"]);
    expect(neededFrom(head, sub(), 0, null)).toEqual([]);
    expect(neededFrom(head, null, 0, assessment)).toEqual([]);
  });
  it("a director rates only with a filing and a photo", () => {
    expect(neededFrom(director, null, 0, null)).toEqual([]);
    expect(neededFrom(director, sub(), 0, null)).toEqual([]);
    expect(neededFrom(director, sub(), 1, null)).toEqual(["rate"]);
    expect(neededFrom(director, sub({ frozen: true }), 1, null)).toEqual([]);
  });
});
