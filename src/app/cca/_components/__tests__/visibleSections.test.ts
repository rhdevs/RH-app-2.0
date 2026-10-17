import { describe, expect, it } from "vitest";

import {
  headsThisCca,
  visibleSections,
} from "~/app/cca/_components/visibleSections";

const sections = [
  { slug: "" },
  { slug: "members" },
  { slug: "points" },
  { slug: "events" },
];

describe("visibleSections", () => {
  it("keeps every tab when the viewer heads this CCA", () => {
    expect(visibleSections(sections, true).map((s) => s.slug)).toEqual([
      "",
      "members",
      "points",
      "events",
    ]);
  });

  it("hides only the Points tab for a viewer who does not head it", () => {
    expect(visibleSections(sections, false).map((s) => s.slug)).toEqual([
      "",
      "members",
      "events",
    ]);
  });
});

describe("headsThisCca", () => {
  it("is false while the viewer's CCAs are still loading", () => {
    expect(headsThisCca(undefined, 9005)).toBe(false);
  });

  it("is false for a JCRC member whose own CCAs do not include this one", () => {
    expect(headsThisCca([{ ccaID: 9001 }, { ccaID: 9002 }], 9005)).toBe(false);
    expect(headsThisCca([], 9005)).toBe(false);
  });

  it("is true when this CCA is among the ones the viewer heads", () => {
    expect(headsThisCca([{ ccaID: 9001 }, { ccaID: 9005 }], 9005)).toBe(true);
  });

  it("makes the Points tab visible only for a head", () => {
    const sections = [{ slug: "members" }, { slug: "points" }];
    const slugs = (ccas: { ccaID: number }[] | undefined) =>
      visibleSections(sections, headsThisCca(ccas, 9005)).map((s) => s.slug);
    expect(slugs(undefined)).toEqual(["members"]);
    expect(slugs([{ ccaID: 9001 }])).toEqual(["members"]);
    expect(slugs([{ ccaID: 9005 }])).toEqual(["members", "points"]);
  });
});
