import { type ReactNode } from "react";
import { formatIssuedOn } from "~/lib/transcript/assemble";
import {
  type TranscriptPage,
  type TranscriptViewModel,
} from "~/lib/transcript/types";
import { JcrcPageBody } from "./JcrcPageBody";
import { META_COLUMNS, MetaRow, PageHeader } from "./PageHeader";
import { ClosingBlock, TranscriptSections } from "./TranscriptSections";

export const EMPTY_YEAR_MESSAGE =
  "No recorded involvements for this academic year.";

/** A light diagonal word across the page. Grey, not coloured: the document's only colour is the crest. */
const watermark = (word: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='240'><text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' transform='rotate(-24 180 120)' font-family='Arial,Helvetica,sans-serif' font-size='44' font-weight='700' letter-spacing='6' fill='rgba(0,0,0,0.06)'>${word}</text></svg>`,
  )}")`;
const WATERMARK = watermark("SPECIMEN");
const DRAFT_WATERMARK = watermark("DRAFT");

/** Faint paper hatch, on screen only (never printed). */
const HATCH =
  "repeating-linear-gradient(135deg, rgba(0,0,0,.025) 0 1px, transparent 1px 4px)";

/**
 * Print rules.
 *
 * FOOTER, in two layers so it works everywhere. Where the browser supports
 * `@page` margin boxes (Chrome 131+) both halves of the footer are margin
 * boxes, so they share one baseline: the resident's name and matric at the left
 * and "Page X of Y", counted by the browser, at the right. The name is written
 * into the stylesheet as CSS hex escapes of every character, so nothing the
 * resident typed can reach the CSS as markup. Everywhere else the name and
 * matric are a plain `position: fixed` element, which every browser repeats on
 * every printed page (pinned to the bottom of the content area: a fixed element
 * pushed into the page margin is clipped on page 1 in Chrome), and no page
 * numbers print. The fixed element is switched off where the margin boxes work
 * (`interpolate-size`, which shipped in Chrome just before them), or Chrome
 * would print the name twice. Each sheet ends in a repeating empty table footer
 * (`rh-print-spacer`) that reserves the footer's space, so body text never
 * prints underneath it.
 * On screen each logical page shows its own footer instead.
 *
 * Backgrounds are dropped when printing unless `print-color-adjust: exact`, so
 * the SPECIMEN watermark sets it. The hatch is removed in print so nothing
 * dark is printed.
 */
/** Every character as a CSS hex escape: safe inside a CSS string whatever it is. */
const cssString = (text: string) =>
  [...text].map((c) => "\\" + c.codePointAt(0)!.toString(16) + " ").join("");

const documentCss = (footerText: string) => `
@page {
  size: A4;
  margin: 14mm 14mm 12mm;
  @bottom-left { content: "${cssString(footerText)}"; vertical-align: top; font: 10.5px Arial, Helvetica, sans-serif; color: #000; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); vertical-align: top; font: 10.5px Arial, Helvetica, sans-serif; color: #000; }
}
.rh-paper { background-image: ${HATCH}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.rh-paper.rh-specimen { background-image: ${WATERMARK}, ${HATCH}; }
.rh-paper.rh-draft { background-image: ${DRAFT_WATERMARK}, ${HATCH}; }
.rh-print-footer, .rh-print-spacer { display: none; }
@media print {
  html, body, main { background: #fff !important; }
  .rh-paper { background-image: none; }
  .rh-paper.rh-specimen { background-image: ${WATERMARK}; }
  .rh-paper.rh-draft { background-image: ${DRAFT_WATERMARK}; }
  .rh-print-footer { display: block; position: fixed; left: 0; bottom: 0; font: 10.5px Arial, Helvetica, sans-serif; color: #000; }
  @supports (interpolate-size: allow-keywords) { .rh-print-footer { display: none; } }
  .rh-print-spacer { display: table-footer-group; }
  .rh-print-spacer td { height: 8mm; padding: 0; }
}`;

/**
 * One academic year's transcript: an ordered list of pages, each starting on a
 * new printed page. Black text on white, thin rules, tables. The only colour is
 * the Raffles Hall crest in each page header.
 */
export function TranscriptDocument({
  transcript,
}: {
  transcript: TranscriptViewModel;
}) {
  const { resident } = transcript;

  return (
    <article className="font-[Arial,Helvetica,sans-serif] text-[11.5px] leading-[1.4] text-black">
      <style
        dangerouslySetInnerHTML={{
          __html: documentCss(`${resident.name} (${resident.matric})`),
        }}
      />
      <p className="rh-print-footer">
        {resident.name} ({resident.matric})
      </p>
      {transcript.pages.map((page, index) => (
        <Sheet
          key={page.kind}
          index={index}
          total={transcript.pages.length}
          transcript={transcript}
          {...pageParts(page, transcript)}
        />
      ))}
    </article>
  );
}

/**
 * One page of the document: the sheet, its footer, and a page break before.
 *
 * The page header sits in a table <thead> so that, when a page runs onto a
 * second printed page, the crest and title repeat there like a letterhead
 * (browsers repeat a table header on every printed page it spans).
 */
function Sheet({
  index,
  total,
  transcript,
  header,
  body,
}: {
  index: number;
  total: number;
  transcript: TranscriptViewModel;
  header: ReactNode;
  body: ReactNode;
}) {
  const { resident } = transcript;
  return (
    <section
      className={`rh-paper ${
        resident.isSpecimen ? "rh-specimen" : ""
      } ${transcript.isDraft ? "rh-draft" : ""} relative mx-auto mb-3.5 flex min-h-[297mm] w-full max-w-[210mm] flex-col bg-white p-5 shadow-[0_1px_6px_rgba(0,0,0,0.2)] sm:p-[14mm] print:mb-0 print:min-h-0 print:max-w-none print:p-0 print:shadow-none ${
        index > 0 ? "print:break-before-page" : ""
      }`}
    >
      {index === 0 && resident.isSpecimen && (
        <p className="mb-3 border border-black px-2 py-1 text-center text-[10.5px] font-bold uppercase tracking-wider">
          Specimen · demonstration data · not an official record of Raffles Hall
        </p>
      )}
      <table className="w-full flex-1 border-collapse">
        <thead>
          <tr>
            <td className="p-0">{header}</td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="p-0 align-top">
              {body}
              {index === total - 1 && <ClosingBlock />}
            </td>
          </tr>
        </tbody>
        <tfoot className="rh-print-spacer">
          <tr>
            <td />
          </tr>
        </tfoot>
      </table>
      <footer className="mt-4 flex justify-between border-t border-black pt-[3px] text-[10.5px] print:hidden">
        <span>
          {resident.name} ({resident.matric})
        </span>
        <span>
          Page {index + 1} of {total}
        </span>
      </footer>
    </section>
  );
}

/** A page split into the part that repeats in print and the part that flows. */
function pageParts(
  page: TranscriptPage,
  transcript: TranscriptViewModel,
): { header: ReactNode; body: ReactNode } {
  const { resident, issue, academicYear } = transcript;

  switch (page.kind) {
    case "main":
      return {
        header: (
          <PageHeader
            level="h1"
            title="Student Development Transcript"
            subtitle="Raffles Hall, National University of Singapore"
          />
        ),
        body: (
          <>
            {transcript.isDraft && (
              <p
                role="note"
                className="mt-2 border border-black px-2 py-1 text-center text-[11px] font-bold"
              >
                {DRAFT_NOTE}
              </p>
            )}
            <MetaRow
              items={[
                { label: "Name", value: resident.name.toUpperCase() },
                { label: "Matric no.", value: resident.matric },
                { label: "Academic year", value: academicYear },
                {
                  label: "Date issued",
                  value: issue.issuedOn
                    ? formatIssuedOn(issue.issuedOn)
                    : "Not yet issued",
                },
              ]}
            />
            {transcript.isEmpty ? (
              <p
                role="status"
                className="py-10 text-center italic text-neutral-700"
              >
                {EMPTY_YEAR_MESSAGE}
              </p>
            ) : (
              <TranscriptSections sections={page.sections} />
            )}
          </>
        ),
      };
    case "jcrc":
      return {
        header: (
          <PageHeader
            title="Junior Common Room Committee"
            subtitle={`Hall leadership record · ${page.jcrc.term}`}
          />
        ),
        body: (
          <>
            <MetaRow
              columns={META_COLUMNS.jcrc}
              items={[
                { label: "Name", value: resident.name.toUpperCase() },
                { label: "Matric no.", value: resident.matric },
                {
                  label: "Position",
                  value: `${page.jcrc.position}, ${page.jcrc.portfolio}`,
                },
                { label: "Term", value: page.jcrc.term },
              ]}
            />
            <JcrcPageBody jcrc={page.jcrc} />
          </>
        ),
      };
  }
}

/** Shown at the top of page 1 while the year is closed for review. */
export const DRAFT_NOTE =
  "Draft - check your information. If something is wrong, tell your CCA head or the JCRC.";
