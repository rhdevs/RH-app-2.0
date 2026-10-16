import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { selectTranscriptState } from "~/lib/transcript/pageState";
import { YearSwitcher } from "../_components/YearSwitcher";

const choicesFor = (
  viewable: Array<{ academicYear: string; draft: boolean }>,
) => {
  const state = selectTranscriptState({
    authenticated: true,
    viewable,
    requested: null,
    currentAcademicYear: "AY2026/27",
  });
  if (state.kind !== "show") throw new Error("expected a switcher");
  return state;
};

describe("the year switcher", () => {
  it("labels the collecting current year 'not yet available' beside a published one", () => {
    const state = choicesFor([{ academicYear: "AY2025/26", draft: false }]);
    const html = renderToStaticMarkup(
      <YearSwitcher
        choices={state.choices}
        active={state.academicYear}
        basePath="/transcript"
      />,
    );
    expect(html).toContain(">AY2025/26<");
    expect(html).toContain(">AY2026/27 (not yet available)<");
    expect(html).toContain('href="/transcript?ay=2026-27"');
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/transcript\?ay=2025-26"|href="\/transcript\?ay=2025-26"[^>]*aria-current="page"/,
    );
  });

  it("labels a closed current year '(draft)'", () => {
    const state = choicesFor([
      { academicYear: "AY2025/26", draft: false },
      { academicYear: "AY2026/27", draft: true },
    ]);
    const html = renderToStaticMarkup(
      <YearSwitcher
        choices={state.choices}
        active="AY2026/27"
        basePath="/transcript"
      />,
    );
    expect(html).toContain(">AY2026/27 (draft)<");
  });

  it("draws nothing without choices", () => {
    expect(
      renderToStaticMarkup(
        <YearSwitcher choices={[]} active="AY2026/27" basePath="/transcript" />,
      ),
    ).toBe("");
  });
});
