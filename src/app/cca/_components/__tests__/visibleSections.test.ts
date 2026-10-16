import { describe, expect, it } from "vitest";

import { visibleSections } from "~/app/cca/_components/visibleSections";

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

  it("hides Points while the viewer's CCAs are still loading", () => {
    // Callers pass false until listMine has answered.
    expect(
      visibleSections(sections, false).some((s) => s.slug === "points"),
    ).toBe(false);
  });
});
