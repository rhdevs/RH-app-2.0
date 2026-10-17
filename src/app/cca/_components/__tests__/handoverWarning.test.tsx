import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/trpc/react", () => ({ api: {} }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null }) }));

const { HandoverTranscriptReminder } = await import("../CcaHandoverDialog");

describe("the transcript reminder in the handover dialog", () => {
  it("only reminds the outgoing heads, with a link to the records", () => {
    const html = renderToStaticMarkup(
      <HandoverTranscriptReminder ccaID={9005} />,
    );
    expect(html).toContain(
      "Before you hand over, make sure this year&#x27;s transcript records (roles, activities, contributions and volunteer hours) are up to date. The new heads can continue them until the JCRC opens transcripts.",
    );
    expect(html).toContain('href="/cca/9005/transcript"');
    expect(html).toContain("Open transcript records");
  });

  it("says nothing about freezing or locking, and computes no year", () => {
    const html = renderToStaticMarkup(
      <HandoverTranscriptReminder ccaID={9005} />,
    );
    expect(html).not.toMatch(/freez|lock/i);
    expect(html).not.toMatch(/AY\d{4}/);
    const source = readFileSync(
      "src/app/cca/_components/CcaHandoverDialog.tsx",
      "utf8",
    );
    expect(source).not.toMatch(/roster\.term|freeze/);
  });
});
