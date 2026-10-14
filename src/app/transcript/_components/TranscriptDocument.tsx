import { type ReactNode } from "react";
import { formatIssuedOn } from "~/lib/transcript/assemble";
import {
  type TranscriptPage,
  type TranscriptViewModel,
} from "~/lib/transcript/types";
import { JcrcPageBody } from "./JcrcPageBody";
import { MetaRow, PageHeader } from "./PageHeader";
import {
  NotesBody,
  SummaryStrip,
  TranscriptSections,
} from "./TranscriptSections";
import { VerifyQr } from "./VerifyQr";

export const EMPTY_YEAR_MESSAGE =
  "No recorded involvements for this academic year.";

/** Grey, not coloured: the document's only colour is the crest. */
const WATERMARK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='240'><text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' transform='rotate(-24 180 120)' font-family='Arial,Helvetica,sans-serif' font-size='44' font-weight='700' letter-spacing='6' fill='rgba(0,0,0,0.06)'>SPECIMEN</text></svg>`,
)}")`;

/** Faint paper hatch, on screen only (never printed). */
const HATCH =
  "repeating-linear-gradient(135deg, rgba(0,0,0,.025) 0 1px, transparent 1px 4px)";

/** Safe to put inside a double-quoted CSS string inside a <style> element. */
function cssString(value: string): string {
  return value.replace(/[\\"<>\r\n]/g, "");
}

/**
 * Print rules. `@page` margin boxes give every printed page its footer: the
 * resident on the left and "Page X of Y" on the right, counted by the browser
 * so nothing is hard-coded (Chrome 131+; browsers without margin boxes print
 * no footer). On screen each logical page shows its own footer instead.
 *
 * Backgrounds are dropped when printing unless `print-color-adjust: exact`, so
 * the SPECIMEN watermark sets it. The hatch is removed in print so nothing
 * dark is printed.
 */
function documentCss(name: string, matric: string): string {
  const who = cssString(`${name} (${matric})`);
  const margin = "font: 10.5px Arial, Helvetica, sans-serif; color: #000;";
  return `
@page {
  size: A4;
  margin: 14mm 14mm 18mm;
  @bottom-left { content: "${who}"; ${margin} }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); ${margin} }
}
.rh-paper { background-image: ${HATCH}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.rh-paper.rh-specimen { background-image: ${WATERMARK}, ${HATCH}; }
@media print {
  html, body, main { background: #fff !important; }
  .rh-paper { background-image: none; }
  .rh-paper.rh-specimen { background-image: ${WATERMARK}; }
}`;
}

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
          __html: documentCss(resident.name, resident.matric),
        }}
      />
      {transcript.pages.map((page, index) => (
        <Sheet
          key={page.kind}
          index={index}
          total={transcript.pages.length}
          transcript={transcript}
        >
          <PageBody page={page} transcript={transcript} />
        </Sheet>
      ))}
    </article>
  );
}

/** One page of the document: the sheet, its footer, and a page break before. */
function Sheet({
  index,
  total,
  transcript,
  children,
}: {
  index: number;
  total: number;
  transcript: TranscriptViewModel;
  children: ReactNode;
}) {
  const { resident } = transcript;
  return (
    <section
      className={`rh-paper ${
        resident.isSpecimen ? "rh-specimen" : ""
      } relative mx-auto mb-3.5 flex min-h-[297mm] w-full max-w-[210mm] flex-col bg-white p-5 shadow-[0_1px_6px_rgba(0,0,0,0.2)] sm:p-[14mm] print:mb-0 print:min-h-0 print:max-w-none print:p-0 print:shadow-none ${
        index > 0 ? "print:break-before-page" : ""
      }`}
    >
      {index === 0 && resident.isSpecimen && (
        <p className="mb-3 border border-black px-2 py-1 text-center text-[10.5px] font-bold uppercase tracking-wider">
          Specimen · demonstration data · not an official record of Raffles Hall
        </p>
      )}
      <div className="flex-1">{children}</div>
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

function PageBody({
  page,
  transcript,
}: {
  page: TranscriptPage;
  transcript: TranscriptViewModel;
}) {
  const { resident, issue, academicYear } = transcript;
  const code = issue.verificationCode;

  switch (page.kind) {
    case "main":
      return (
        <>
          <PageHeader
            level="h1"
            title="Student Development Transcript"
            subtitle="Raffles Hall, National University of Singapore"
            aside={<VerifyQr code={code} size={64} />}
          />
          <MetaRow
            items={[
              { label: "Name", value: resident.name.toUpperCase() },
              { label: "Matric no.", value: resident.matric },
              {
                label: "Residency",
                value: academicYear,
                detail: `${issue.block} · ${yearOfResidence(issue.yearOfResidence)}`,
              },
              { label: "Date issued", value: formatIssuedOn(issue.issuedOn) },
              { label: "Verification", value: code },
            ]}
          />
          <SummaryStrip summary={transcript.summary} />
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
      );
    case "jcrc":
      return (
        <>
          <PageHeader
            title="Junior Common Room Committee"
            subtitle={`Hall leadership record · ${page.jcrc.term}`}
          />
          <MetaRow
            items={[
              { label: "Name", value: resident.name.toUpperCase() },
              { label: "Matric no.", value: resident.matric },
              {
                label: "Position",
                value: `${page.jcrc.position}, ${page.jcrc.portfolio}`,
              },
              { label: "Term", value: page.jcrc.term },
              { label: "Verification", value: code },
            ]}
          />
          <JcrcPageBody jcrc={page.jcrc} />
        </>
      );
    case "notes":
      return (
        <>
          <PageHeader title="Explanatory notes" />
          <NotesBody notes={page.notes} verificationCode={code} />
        </>
      );
  }
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];

function yearOfResidence(n: number): string {
  return `${ORDINALS[n - 1] ?? `${n}th`} year`;
}
