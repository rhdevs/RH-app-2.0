import { type ReactNode } from "react";
import {
  type AwardRow,
  type InvolvementRow,
  type NoteRow,
  type TranscriptSection,
  type VolunteerHoursModel,
} from "~/lib/transcript/types";

/**
 * The body of page 1 and of the notes page. Page 1 is one block per section in
 * the view model, in the order the assembler produced. Adding a section kind
 * means adding a member to `TranscriptSection`, one case in `SectionBody` and
 * one title below; the document and the pages do not change.
 *
 * Page breaks: a CCA row stays together with its sub-rows (each CCA is its own
 * <tbody>), and the header row of each table repeats on every printed page.
 */

const SECTION_TITLES: Record<TranscriptSection["kind"], string> = {
  involvements: "Leadership and CCA participation",
  volunteerHours: "Volunteer hours",
  awards: "Awards",
};

const ROMAN = ["I", "II", "III", "IV", "V", "VI"];

const SEC_HEADING =
  "mb-0.5 mt-3 break-after-avoid border-b border-black text-xs font-bold uppercase";
const TH = "border-b border-black px-1 py-0.5 text-left font-bold";
const TD = "px-1 py-0.5 align-top";

export function TranscriptSections({
  sections,
}: {
  sections: TranscriptSection[];
}) {
  return (
    <>
      {sections.map((section, index) => (
        <section key={section.kind}>
          <h2 className={SEC_HEADING}>
            {ROMAN[index]}. {SECTION_TITLES[section.kind]}
          </h2>
          <SectionBody section={section} />
        </section>
      ))}
    </>
  );
}

function SectionBody({ section }: { section: TranscriptSection }) {
  switch (section.kind) {
    case "involvements":
      return <Involvements rows={section.rows} />;
    case "volunteerHours":
      return <VolunteerHours volunteer={section.volunteer} />;
    case "awards":
      return <Awards rows={section.rows} />;
  }
}

/** Fixed column widths shared by the two tables on page 1. */
function Columns() {
  return (
    <colgroup>
      <col className="w-[56%]" />
      <col className="w-[30%]" />
      <col className="w-[14%]" />
    </colgroup>
  );
}

function SubRow({ children }: { children: ReactNode }) {
  return (
    <tr>
      <td colSpan={3} className="px-1 py-0.5 pl-[18px] italic text-neutral-800">
        {children}
      </td>
    </tr>
  );
}

function Involvements({ rows }: { rows: InvolvementRow[] }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <Columns />
      <thead>
        <tr>
          <th scope="col" className={TH}>
            CCA / portfolio
          </th>
          <th scope="col" className={TH}>
            Role
          </th>
          <th scope="col" className={TH}>
            Year
          </th>
        </tr>
      </thead>
      {rows.map((row) => (
        <tbody key={row.footnote} className="break-inside-avoid">
          <tr>
            <td className={TD}>
              {row.ccaName} <sup>{row.footnote}</sup>
            </td>
            <td className={TD}>{row.role}</td>
            <td className={TD}>{row.year}</td>
          </tr>
          {row.isJcrc && (
            <SubRow>
              See the Junior Common Room Committee page for a full account of
              this role.
            </SubRow>
          )}
          {row.extraContribution && (
            <SubRow>Additional contribution: {row.extraContribution}</SubRow>
          )}
        </tbody>
      ))}
    </table>
  );
}

function VolunteerHours({ volunteer }: { volunteer: VolunteerHoursModel }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <Columns />
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Activity
          </th>
          <th scope="col" className={TH}>
            Organiser
          </th>
          <th scope="col" className={TH}>
            Hours
          </th>
        </tr>
      </thead>
      <tbody>
        {volunteer.rows.map((row) => (
          <tr
            key={`${row.kind}-${row.activity}`}
            className="break-inside-avoid"
          >
            <td className={TD}>{row.activity}</td>
            <td className={TD}>{row.organiser}</td>
            <td className={TD}>{row.hours}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="break-inside-avoid font-bold">
          <td className={`${TD} border-t border-black`} colSpan={2}>
            Total volunteer hours
          </td>
          <td className={`${TD} border-t border-black`}>{volunteer.total}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function Awards({ rows }: { rows: AwardRow[] }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <tbody>
        {rows.map((row) => (
          <tr
            key={`${row.academicYear}-${row.title}`}
            className="break-inside-avoid"
          >
            <td className={TD}>
              {row.title} ({row.academicYear})
              {row.citation && (
                <span className="block italic text-neutral-800">
                  {row.citation}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The footnotes for the superscripts on page 1, then a neutral closing line. */
export function NotesBody({ notes }: { notes: NoteRow[] }) {
  return (
    <>
      {notes.length > 0 && (
        <section>
          <h2 className={`${SEC_HEADING} mt-3.5`}>
            Notes on leadership and CCAs
          </h2>
          {notes.map((note) => (
            <p
              key={note.number}
              className={`my-0.5 break-inside-avoid ${
                note.isMissing ? "text-neutral-600" : ""
              }`}
            >
              <sup>{note.number}</sup> {note.title}: {note.text}
            </p>
          ))}
        </section>
      )}

      <section className="break-inside-avoid">
        <h2 className={SEC_HEADING}>About this record</h2>
        <p className="my-0.5 text-[10.5px]">
          Generated from Raffles Hall&rsquo;s records.
        </p>
        <p className="mt-3 text-center font-bold tracking-[0.06em]">
          — END OF TRANSCRIPT —
        </p>
      </section>
    </>
  );
}
