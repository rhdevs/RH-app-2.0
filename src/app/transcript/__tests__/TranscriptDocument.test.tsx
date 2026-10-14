import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assembleTranscript } from "~/lib/transcript/assemble";
import {
  FIXTURE_ACADEMIC_YEAR,
  TRANSCRIPT_FIXTURES,
  getFixtureBySlug,
} from "~/lib/transcript/fixtures";
import {
  EMPTY_YEAR_MESSAGE,
  TranscriptDocument,
} from "../_components/TranscriptDocument";

const AY = FIXTURE_ACADEMIC_YEAR;
const JCRC_AY = "AY2027/28";
const CREST = /<img[^>]*alt="Raffles Hall crest"[^>]*>/g;

function render(slug: string, year = AY): string {
  const fixture = getFixtureBySlug(slug);
  if (!fixture) throw new Error(`missing fixture ${slug}`);
  return renderToStaticMarkup(
    <TranscriptDocument transcript={assembleTranscript(fixture.input, year)} />,
  );
}

/** The rendered HTML of each page (sheet) of a document. */
function sheets(html: string): string[] {
  return html.split('<section class="rh-paper').slice(1);
}

describe("TranscriptDocument: crest", () => {
  it("shows the crest on the main page and the notes page of a non-JCRC resident", () => {
    const pages = sheets(render("plain-member"));

    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.match(CREST)).toHaveLength(1);
  });

  it("shows the crest on every page of a JCRC resident, including the JCRC page", () => {
    const pages = sheets(render("jcrc-sports-secretary", JCRC_AY));

    expect(pages).toHaveLength(3);
    for (const page of pages) expect(page.match(CREST)).toHaveLength(1);
  });

  it("uses a real, eagerly loaded image at 42x48, never a CSS background", () => {
    const html = render("jcrc-only");

    const tag = html.match(CREST)?.[0] ?? "";
    expect(tag).toContain('width="42"');
    expect(tag).toContain('height="48"');
    expect(tag).toContain('loading="eager"');
    expect(tag).toMatch(/rh-crest\.png/);
    expect(html).not.toMatch(/background[^;"]*rh-crest/);
  });

  it("shows no other logo", () => {
    expect(render("jcrc-only")).not.toContain("raffles-hall-logo");
  });
});

describe("TranscriptDocument: pages", () => {
  it("renders the JCRC page only for a JCRC resident, between main and notes", () => {
    const jcrc = render("jcrc-sports-secretary", JCRC_AY);
    const plain = render("many-ccas");

    expect(jcrc).toContain("Hall leadership record");
    expect(plain).not.toContain("Hall leadership record");
    expect(plain).not.toContain("Testimonial from the Hall Master");
    expect(jcrc.indexOf("Student Development Transcript")).toBeLessThan(
      jcrc.indexOf("Hall leadership record"),
    );
    expect(jcrc.indexOf("Hall leadership record")).toBeLessThan(
      jcrc.indexOf("Explanatory notes"),
    );
  });

  it("starts the JCRC page and the notes page on a new printed page", () => {
    const pages = sheets(render("jcrc-sports-secretary", JCRC_AY));

    expect(pages[0]).not.toContain("print:break-before-page");
    expect(pages[1]).toContain("print:break-before-page");
    expect(pages[2]).toContain("print:break-before-page");
  });

  it("works for a JCRC member with no other CCAs", () => {
    const html = render("jcrc-only");

    expect(html).toContain("Junior Common Room Committee (JCRC), Welfare");
    expect(html).toContain("Testimonial from the Hall Master");
  });

  it("shows the empty-year message instead of a broken page", () => {
    const html = render("empty-year");

    expect(html).toContain(EMPTY_YEAR_MESSAGE);
    expect(html).toContain("— END OF TRANSCRIPT —");
    expect(html).not.toContain("Leadership and CCA participation");
  });

  it("renders every issued year of every specimen", () => {
    for (const f of TRANSCRIPT_FIXTURES) {
      for (const issue of f.input.issues) {
        const vm = assembleTranscript(f.input, issue.academicYear);
        expect(() =>
          renderToStaticMarkup(<TranscriptDocument transcript={vm} />),
        ).not.toThrow();
      }
    }
  });
});

describe("TranscriptDocument: content", () => {
  it("numbers the sections I, II, III and omits the empty ones", () => {
    const full = render("jcrc-sports-secretary", JCRC_AY);
    const bare = render("plain-member");

    expect(full).toContain("I. Leadership and CCA participation");
    expect(full).toContain("II. Volunteer hours");
    expect(full).toContain("III. Awards");
    expect(bare).toContain("I. Leadership and CCA participation");
    expect(bare).not.toContain("Volunteer hours");
    expect(bare).not.toContain("III. Awards");
  });

  it("prints Additional contribution and the see-JCRC sub-rows", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);

    expect(html).toContain(
      "Additional contribution: Choreographed and directed the Hall Night finale.",
    );
    expect(html).toContain("for a full account of this role");
  });

  it("shows the muted placeholder for a CCA without a description", () => {
    const html = render("missing-description");

    expect(html).toContain("Hall Orchestra: Description not yet available.");
  });

  it("shows block and year of residence", () => {
    expect(render("plain-member")).toContain("Block 3 · Second year");
  });

  it("shows all four summary cells even when zero", () => {
    const html = render("empty-year");

    for (const label of [
      "CCAs",
      "Leadership roles",
      "Volunteering",
      "Awards",
    ]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
    expect(html).toContain("0 h");
  });
});

describe("TranscriptDocument: signatures", () => {
  it("always prints two empty placeholder boxes and never a person's name", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);

    expect(html).toContain("[Master signature placeholder]");
    expect(html).toContain("[President signature placeholder]");
    expect(html.match(/Date: \[placeholder\]/g)).toHaveLength(2);
    expect(html).toContain("Master, Raffles Hall");
    expect(html).toContain("President, JCRC");
  });

  it("prints no signature boxes on a transcript without a JCRC page", () => {
    expect(render("cca-head")).not.toContain("signature placeholder");
  });
});

describe("TranscriptDocument: print", () => {
  it("counts printed pages in the browser rather than hard-coding them", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);

    expect(html).toContain("@bottom-left");
    expect(html).toContain('"Page " counter(page) " of " counter(pages)');
    expect(html).toContain("Tan Wei Ming (A0011000X)");
  });

  it("hides the on-screen page footer in print", () => {
    const pages = sheets(render("jcrc-sports-secretary", JCRC_AY));

    expect(pages[0]).toMatch(/<footer[^>]*print:hidden[^>]*>/);
    expect(pages[2]).toContain("Page 3 of 3");
  });

  it("marks specimens and drops the hatch in print", () => {
    const html = render("plain-member");

    expect(html).toContain("rh-specimen");
    expect(html).toContain("SPECIMEN");
    expect(html).toMatch(
      /@media print[\s\S]*\.rh-paper \{ background-image: none; \}/,
    );
  });

  it("keeps hostile resident names out of the stylesheet and the markup", () => {
    const fixture = getFixtureBySlug("plain-member")!;
    const vm = assembleTranscript(
      {
        ...fixture.input,
        resident: {
          ...fixture.input.resident,
          name: 'Evil"</style><script>alert(1)</script>',
        },
      },
      AY,
    );

    const html = renderToStaticMarkup(<TranscriptDocument transcript={vm} />);

    expect(html).not.toContain("<script>");
    const css = html.slice(
      html.indexOf("<style>") + "<style>".length,
      html.indexOf("</style>"),
    );
    expect(css).not.toContain("<");
    expect(css).toContain('content: "Evil/stylescriptalert(1)/script');
  });
});
