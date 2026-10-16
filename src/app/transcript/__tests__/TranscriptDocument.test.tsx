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

/** The markup exactly as rendered, with no-break spaces and no-wrap wrappers. */
function renderRaw(slug: string, year = AY): string {
  const fixture = getFixtureBySlug(slug);
  if (!fixture) throw new Error(`missing fixture ${slug}`);
  return renderToStaticMarkup(
    <TranscriptDocument transcript={assembleTranscript(fixture.input, year)} />,
  );
}

/** The same, read as words: semester suffixes unwrapped, no-break spaces as spaces. */
function render(slug: string, year = AY): string {
  return renderRaw(slug, year)
    .replace(/<span class="whitespace-nowrap">(\(Sem[^<]*)<\/span>/g, "$1")
    .replace(/ /g, " ");
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

  it("prints the semester in the Year and Role columns only when not a full year", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);

    expect(html).toContain("2027/28 Sem 2");
    expect(html).toContain("Head (Sem 2)");
    expect(render("cca-head")).not.toContain("Semester");
  });

  it("keeps the Year cell on one line, sized for '2026/27 Sem 2'", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);

    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("2027/28 Sem 2</td>");
    expect(html).toMatch(/whitespace-nowrap[^>]*>Year/);
    expect(html).toContain("w-[7.5rem]");
    // The part-year words never wrap onto a second line inside the cell.
    expect(html).not.toContain("2027/28<br");
  });

  it("explains Sem 1 / Sem 2 on the notes page only when a part-year item exists", () => {
    const withPart = render("jcrc-sports-secretary", JCRC_AY);
    const without = render("plain-member");

    expect(withPart).toContain(
      "Sem 1 / Sem 2: involvement for that semester only.",
    );
    expect(without).not.toContain("Sem 1 / Sem 2");
  });

  it("closes the notes page with one neutral sentence and no verification text", () => {
    const html = render("plain-member");

    expect(html).toMatch(/Generated from Raffles Hall.s records./);
    expect(html).not.toMatch(/verif|QR/i);
    expect(html).not.toContain("<svg");
  });

  it("has one row of exactly four details, and no Block, year of residence or Faculty", () => {
    for (const slug of ["plain-member", "many-ccas", "jcrc-sports-secretary"]) {
      const main = sheets(render(slug))[0]!;
      const labels = [...main.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(
        (m) => m[1],
      );
      expect(labels).toEqual([
        "Name",
        "Matric no.",
        "Academic year",
        "Date issued",
      ]);
      expect(main).toContain("sm:grid-cols-[2fr_1fr_1fr_1fr]");
      expect(main).not.toMatch(/Block \d|Residency|year of residence|Faculty/i);
      expect(main).not.toMatch(/(First|Second|Third|Fourth) year/);
    }
  });

  it("lays the JCRC page header out in four columns, with no empty one", () => {
    const jcrc = sheets(render("jcrc-sports-secretary", JCRC_AY))[1]!;
    const labels = [...jcrc.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(
      (m) => m[1],
    );
    expect(labels).toEqual(["Name", "Matric no.", "Position", "Term"]);
    expect(jcrc).toContain("sm:grid-cols-[1.5fr_1fr_2fr_1fr]");
    expect(jcrc).not.toMatch(/<dd[^>]*><\/dd>/);
  });

  it("joins 'Sem' and its number with a no-break space, and keeps '(Sem N)' whole", () => {
    const html = renderRaw("member-with-activities");
    expect(html).toContain("Sem\u00a02");
    expect(html).not.toMatch(/Sem [12]/);
    expect(html).toMatch(
      /<span class="whitespace-nowrap">\(Sem\u00a0[12]\)<\/span>/,
    );
    // The role suffix and the Year cell too.
    const many = renderRaw("jcrc-sports-secretary", JCRC_AY);
    expect(many).toContain("2027/28 Sem 2");
    expect(many).toContain(
      'Head <span class="whitespace-nowrap">(Sem 2)</span>',
    );
    expect(many).not.toMatch(/Sem [12]/);
  });

  it("has no summary strip on page 1, for any kind of resident", () => {
    const cases: Array<[string, string?]> = [
      ["plain-member"],
      ["jcrc-sports-secretary", JCRC_AY],
      ["empty-year"],
    ];
    for (const [slug, year] of cases) {
      const html = render(slug, year);
      for (const label of ["Leadership roles", "Volunteering"]) {
        expect(html).not.toContain(label);
      }
      expect(html).not.toMatch(/<dt>(CCAs|Awards)<\/dt>/);
      expect(html).not.toMatch(/\d+ h</);
    }
  });

  it("goes straight from the resident details to the first section", () => {
    const html = render("plain-member");

    const details = html.indexOf("Date issued");
    const section = html.indexOf("I. Leadership and CCA participation");
    expect(details).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(details);
    expect(html.slice(details, section)).not.toMatch(/border border-black/);
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

    expect(html).toContain(
      '@bottom-right { content: "Page " counter(page) " of " counter(pages)',
    );
  });

  it("puts the name and the page count in margin boxes on one baseline, with the fixed name as the fallback", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);
    const box = (name: string) =>
      new RegExp(`@${name} \{[^}]*vertical-align: top;`);

    expect(html).toMatch(box("bottom-left"));
    expect(html).toMatch(box("bottom-right"));
    expect(html).not.toContain("margin-top: -");
    // The name in the margin box is hex-escaped: "T" is 54, "a" is 61.
    expect(html).toContain(String.raw`@bottom-left { content: "\54 \61 \6e `);
    expect(html.match(/class="rh-print-footer"/g)).toHaveLength(1);
    expect(html).toContain(
      '<p class="rh-print-footer">Tan Wei Ming (A0011000X)</p>',
    );
    expect(html).toMatch(
      /.rh-print-footer {[^}]*position: fixed; left: 0; bottom: 0;/,
    );
    // Where margin boxes work, the fixed copy is switched off: never two names.
    expect(html).toContain(
      "@supports (interpolate-size: allow-keywords) { .rh-print-footer { display: none; } }",
    );
  });

  it("reserves the footer space on every sheet so body text never prints under it", () => {
    const pages = sheets(render("jcrc-sports-secretary", JCRC_AY));

    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.match(/<tfoot class="rh-print-spacer">/g)).toHaveLength(1);
    }
  });

  it("repeats the crest header on every printed page of a sheet via its table head", () => {
    for (const page of sheets(render("many-ccas"))) {
      const head = page.slice(
        page.indexOf("<thead>"),
        page.indexOf("</thead>"),
      );
      expect(head.match(CREST)).toHaveLength(1);
    }
  });

  it("hides the on-screen page footer in print", () => {
    const pages = sheets(render("jcrc-sports-secretary", JCRC_AY));

    expect(pages[0]).toMatch(/<footer[^>]*print:hidden[^>]*>/);
    expect(pages[2]).toContain("Page 3 of 3");
  });

  it("marks specimens and drops the hatch in print", () => {
    const html = render("plain-member");

    expect(html).toMatch(/<section class="rh-paper rh-specimen/);
    expect(html).toContain("SPECIMEN");
    expect(html).toMatch(
      /@media print[\s\S]*\.rh-paper \{ background-image: none; \}/,
    );
  });

  it("escapes hostile resident names and keeps them out of the stylesheet", () => {
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
    expect(css).not.toContain("Evil");
    expect(css).not.toContain("<");
    expect(html).toContain("Evil&quot;&lt;/style&gt;&lt;script&gt;");
  });
});

describe("TranscriptDocument: draft", () => {
  const draft = (slug: string, year = AY): string => {
    const fixture = getFixtureBySlug(slug)!;
    return renderToStaticMarkup(
      <TranscriptDocument
        transcript={assembleTranscript(fixture.input, year, { draft: true })}
      />,
    );
  };

  it("puts the draft note at the top of page 1 and a DRAFT watermark on every page", () => {
    const html = draft("jcrc-sports-secretary", JCRC_AY);

    expect(html).toContain(
      "Draft - check your information. If something is wrong, tell your CCA head or the JCRC.",
    );
    expect(html.match(/rh-draft/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("DRAFT");
    // the note is printed once, on page 1
    expect(html.match(/Draft - check your information/g)).toHaveLength(1);
  });

  it("is not marked as a draft when the year is published", () => {
    const html = render("plain-member");

    expect(html).not.toContain("Draft - check your information");
    expect(html).not.toMatch(/class="rh-paper[^"]*rh-draft/);
  });

  it("keeps the crest, footer and notes page", () => {
    const html = draft("plain-member");

    expect(html).toContain("Explanatory notes");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("Raffles Hall crest");
  });
});

describe("TranscriptDocument: activities", () => {
  it("nests the activity rows under the CCA, with the semester in the title", () => {
    const html = render("member-with-activities");

    expect(html).toContain("Annual hall concert");
    expect(html).toContain("Choir retreat (Sem 2)");
    expect(html).toContain("Soloist");
  });

  it("draws the nested activity rows with NO header row, and Other involvement keeps its own", () => {
    const html = render("member-with-activities");
    const leadership = html.slice(
      html.indexOf("I. Leadership and CCA participation"),
      html.indexOf("II. Other involvement"),
    );

    // One header row in that section: the CCA / Role / Year table itself.
    expect(leadership.match(/<thead/g)).toHaveLength(1);
    expect(leadership).not.toMatch(/<th[^>]*>Activity<\/th>/);
    expect(leadership).not.toMatch(/<th[^>]*>Description<\/th>/);
    // The three columns and the rows are still there.
    expect(leadership).toContain('aria-label="Activities"');
    expect(leadership).toContain("Annual hall concert");

    const other = html.slice(html.indexOf("II. Other involvement"));
    for (const word of ["Activity", "Organised by", "Role", "Description"]) {
      expect(other).toMatch(new RegExp(`<th[^>]*>${word}</th>`));
    }
  });

  it("draws the JCRC contributions with no header row", () => {
    const html = render("jcrc-sports-secretary", JCRC_AY);
    const start = html.indexOf("Contributions during the year");
    const section = html.slice(start, html.indexOf("</section>", start));

    expect(section).not.toContain("<thead");
    expect(section).not.toMatch(/<th[ >]/);
    expect(section).toContain("Inter-hall sports calendar");
    expect(section).toContain('aria-label="Contributions"');
  });

  it("uses the person's own description, else the activity's", () => {
    const html = render("member-with-activities");

    expect(html).toContain("Sang the opening solo");
    // No person text on this one: the general description is shown instead.
    expect(html).toContain("A December visit to sing carols");
  });

  it("makes the additional contribution the last row of the nested table", () => {
    const html = render("member-with-activities");
    const choir = html.slice(html.indexOf("Hall Choir"));

    expect(choir).toContain("Additional contribution");
    expect(choir.indexOf("Choir retreat")).toBeLessThan(
      choir.indexOf("Additional contribution"),
    );
    expect(choir).toContain("Arranged two pieces");
  });

  it("keeps the one-line sub-row for a CCA that has no activities", () => {
    const html = render("additional-contribution");

    expect(html).toContain("Additional contribution: Built the main set piece");
  });

  it("prints Other involvement between the CCA section and Volunteer hours", () => {
    const html = render("member-with-activities");

    expect(html).toContain("II. Other involvement");
    expect(html).toMatch(/<th[^>]*>Organised by<\/th>/);
    expect(html.indexOf("I. Leadership and CCA participation")).toBeLessThan(
      html.indexOf("II. Other involvement"),
    );
  });

  it("shows only Other involvement for a resident with no CCA row", () => {
    const html = render("other-involvement-only");

    expect(html).toContain("I. Other involvement");
    expect(html).not.toContain("Leadership and CCA participation");
    expect(html).not.toContain(EMPTY_YEAR_MESSAGE);
    expect(html).toContain("Hall Night pit band (Sem 1)");
  });

  it("lists the general descriptions on the notes page", () => {
    const pages = sheets(render("member-with-activities"));
    const notes = pages[pages.length - 1]!;

    expect(notes).toContain("Annual hall concert: The hall");
    expect(notes).toContain("Notes on other involvement");
    expect(notes).toContain("Exam-period care packs: Assembled");
  });

  it("keeps the crest and the Sem 1 / Sem 2 explanation with part-year activities", () => {
    const pages = sheets(render("member-with-activities"));

    for (const page of pages) expect(page.match(CREST)).toHaveLength(1);
    expect(pages[pages.length - 1]).toContain(
      "Sem 1 / Sem 2: involvement for that semester only.",
    );
  });

  it("escapes hostile activity text", () => {
    const fixture = getFixtureBySlug("member-with-activities")!;
    const input = {
      ...fixture.input,
      activities: [
        {
          ...fixture.input.activities![0]!,
          title: "<script>alert(1)</script>",
        },
      ],
    };
    const html = renderToStaticMarkup(
      <TranscriptDocument transcript={assembleTranscript(input, AY)} />,
    );

    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("TranscriptDocument: volunteer hours", () => {
  it("prints Activity, Type, Organised by and Hours, one row per activity, then a Total", () => {
    const html = render("volunteering");

    expect(html).toMatch(/<th[^>]*>Activity<\/th>/);
    expect(html).toMatch(/<th[^>]*>Type<\/th>/);
    expect(html).toMatch(/<th[^>]*>Organised by<\/th>/);
    expect(html).toMatch(/<th[^>]*>Hours<\/th>/);
    expect(html).toContain("Weekly tuition for neighbourhood children");
    expect(html).toContain(">Regular<");
    expect(html).toContain(">One-off<");
    expect(html).toMatch(/>Total<\/td><td[^>]*>55<\/td>/);
  });

  it("prints hours without trailing zeros and never a session count", () => {
    const html = render("volunteering");

    expect(html).toContain(">32.5<");
    expect(html).toContain(">12<");
    expect(html).toContain(">4.5<");
    expect(html).not.toMatch(/\d+ sessions?/i);
    expect(html).not.toMatch(/>(32\.50|12\.0|4\.50)</);
  });

  it("leaves the section out when there are no hours", () => {
    expect(render("no-volunteering")).not.toContain("Volunteer hours");
  });
});

describe("TranscriptDocument: awards", () => {
  it("prints Award and Year columns with the short year, no brackets", () => {
    const html = render("awards");

    expect(html).toMatch(/<th[^>]*>Award<\/th>/);
    expect(html).toMatch(/<th[^>]*>Year<\/th>/);
    expect(html).toContain("Colours Award for Sports");
    expect(html).toMatch(/>2026\/27<\/td>/);
    expect(html).not.toContain("(AY2026/27)");
  });

  it("puts the citation on its own line beneath, in smaller italic text", () => {
    const html = render("awards");

    expect(html).toMatch(
      /<td[^>]*text-\[10\.5px\][^>]*italic[^>]*>For leading the hall swimming team/,
    );
  });

  it("orders awards by title and leaves a citation row out when there is none", () => {
    const html = render("awards");

    expect(html.indexOf("Colours Award for Sports")).toBeLessThan(
      html.indexOf("Service Excellence Award"),
    );
    const plain = render("no-volunteering");
    expect(plain).toContain("Outstanding Newcomer");
    expect(plain).not.toMatch(/italic[^>]*><\/td>/);
  });
});
