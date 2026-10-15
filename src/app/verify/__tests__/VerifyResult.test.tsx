import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assembleTranscript } from "~/lib/transcript/assemble";
import { getFixtureBySlug } from "~/lib/transcript/fixtures";
import { VERIFY_NOTES } from "~/lib/transcript/pageState";
import { maskMatric } from "~/server/api/services/transcript/issue";
import { VerifyResult, type VerifyOutcome } from "../_components/VerifyResult";

const AY = "AY2026/27";
const REAL_MATRIC = "A9912000X";

/** A REAL (non-specimen) issued record, as transcript.verify returns it: matric masked. */
function realRecord() {
  const fixture = getFixtureBySlug("jcrc-sports-secretary")!;
  const input = {
    ...fixture.input,
    resident: {
      name: "Seed Resident 12",
      matric: REAL_MATRIC,
      isSpecimen: false,
    },
  };
  const transcript = assembleTranscript(input, "AY2027/28");
  return {
    ...transcript,
    resident: { ...transcript.resident, matric: maskMatric(REAL_MATRIC) },
  };
}

function render(outcome: VerifyOutcome, verifyUrl?: string): string {
  return renderToStaticMarkup(
    <VerifyResult outcome={outcome} verifyUrl={verifyUrl} />,
  );
}

/**
 * The stylesheet always DEFINES the specimen styling, so "no watermark" means
 * no sheet carries the class and no specimen banner is printed.
 */
const SPECIMEN_SHEET = /<section class="rh-paper rh-specimen/;
const SPECIMEN_BANNER = /Specimen · demonstration data/i;

const valid = (): VerifyOutcome => ({
  status: "valid",
  academicYear: "AY2027/28",
  issuedAt: "2028-05-09T00:00:00.000Z",
  transcript: realRecord(),
});

describe("VerifyResult: valid", () => {
  it("says the record is valid and shows the document with the matric masked", () => {
    const html = render(valid());

    expect(html).toContain(VERIFY_NOTES.valid);
    expect(html).toContain("Student Development Transcript");
    expect(html).toContain("SEED RESIDENT 12");
    expect(html).toContain("A*******X");
    expect(html).not.toContain(REAL_MATRIC);
  });

  it("is not a specimen: no watermark, no specimen banner", () => {
    const html = render(valid());

    expect(html).not.toMatch(SPECIMEN_SHEET);
    expect(html).not.toMatch(SPECIMEN_BANNER);
  });

  it("shows the JCRC page and the crest on every page", () => {
    const html = render(valid());

    expect(html).toContain("Hall leadership record");
    // 3 document pages plus the heading on the verification page itself.
    expect(html.match(/alt="Raffles Hall crest"/g)).toHaveLength(4);
  });

  it("prints the site's own address on the notes page when it is known", () => {
    const html = render(valid(), "https://hall.example.org/verify");

    expect(html).toContain("https://hall.example.org/verify");
  });

  it("words around the address when it is not known", () => {
    expect(render(valid())).toContain("the verification page of this site");
  });
});

describe("VerifyResult: superseded", () => {
  const outcome = (): VerifyOutcome => ({
    status: "superseded",
    academicYear: "AY2027/28",
    issuedAt: "2028-05-09T00:00:00.000Z",
    transcript: realRecord(),
  });

  it("shows the record under a prominent plain note, matric still masked", () => {
    const html = render(outcome());

    expect(html).toContain(VERIFY_NOTES.superseded);
    expect(html).not.toContain(VERIFY_NOTES.valid);
    expect(html).toMatch(/<p role="status" class="[^"]*border-2/);
    expect(html).toContain("A*******X");
    expect(html).not.toContain(REAL_MATRIC);
    expect(html).not.toMatch(SPECIMEN_SHEET);
    expect(html).not.toMatch(SPECIMEN_BANNER);
  });
});

describe("VerifyResult: nothing to show", () => {
  it.each([
    ["revoked", VERIFY_NOTES.revoked],
    ["not_found", VERIFY_NOTES.not_found],
    ["rate_limited", VERIFY_NOTES.rate_limited],
  ] as const)("%s shows only the note", (status, note) => {
    const html = render({ status } as VerifyOutcome);

    expect(html).toContain(note);
    expect(html).not.toContain("Student Development Transcript");
    expect(html).not.toContain('alt="Raffles Hall crest"' + "x");
    expect(html.match(/alt="Raffles Hall crest"/g)).toHaveLength(1);
    expect(html).not.toMatch(/SEED|Resident|AY20/);
  });

  it("never hints at a near match", () => {
    const html = render({ status: "not_found" });

    expect(html).not.toMatch(/did you mean|similar|close|almost|closest/i);
  });

  it("offers a way to try another code", () => {
    expect(render({ status: "not_found" })).toContain('href="/verify"');
  });
});

describe("VerifyResult: specimen (development only)", () => {
  it("is labelled a specimen and keeps the watermark", () => {
    const fixture = getFixtureBySlug("plain-member")!;
    const transcript = assembleTranscript(fixture.input, AY);

    const html = render({ status: "specimen", transcript });

    expect(html).toContain(VERIFY_NOTES.specimen);
    expect(html).not.toContain(VERIFY_NOTES.valid);
    expect(html).toMatch(SPECIMEN_SHEET);
    expect(html).toMatch(SPECIMEN_BANNER);
  });
});
