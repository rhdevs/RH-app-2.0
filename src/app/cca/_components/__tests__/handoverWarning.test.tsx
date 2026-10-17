import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/trpc/react", () => ({ api: {} }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));

const { HandoverTranscriptWarning } = await import("../CcaHandoverDialog");

const render = (
  state: Parameters<typeof HandoverTranscriptWarning>[0]["state"],
) =>
  renderToStaticMarkup(
    <HandoverTranscriptWarning ccaID={9005} state={state} />,
  );

describe("the transcript warning in the handover dialog (F15)", () => {
  it("names the year only when the handover will freeze it", () => {
    const html = render({ kind: "freezes", year: "AY2026/27" });
    expect(html).toContain("freezes the member list for AY2026/27");
    expect(html).toContain('href="/cca/9005/transcript"');
  });

  it("says nothing about freezing when no freeze would happen", () => {
    expect(render({ kind: "none" })).toBe("");
    expect(render({ kind: "loading" })).toBe("");
  });

  it("falls back to a general reminder when the check fails", () => {
    const html = render({ kind: "unknown" });
    expect(html).toContain(
      "Finish this year&#x27;s transcript records before handing over.",
    );
    expect(html).not.toContain("freezes the member list");
  });
});
