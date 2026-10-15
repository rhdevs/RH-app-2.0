import { type ReactNode } from "react";
import {
  type ActivityNote,
  type AwardRow,
  type InvolvementRow,
  type NoteRow,
  type OtherInvolvementRow,
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
  otherInvolvement: "Other involvement",
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
    case "otherInvolvement":
      return <OtherInvolvement rows={section.rows} />;
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

/** The involvement table: the Year column is sized to "2026/27 Sem 2" and never wraps. */
function InvolvementColumns() {
  return (
    <colgroup>
      <col />
      <col className="w-[28%]" />
      <col className="w-[7.5rem]" />
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
      <InvolvementColumns />
      <thead>
        <tr>
          <th scope="col" className={TH}>
            CCA / portfolio
          </th>
          <th scope="col" className={TH}>
            Role
          </th>
          <th scope="col" className={`${TH} whitespace-nowrap`}>
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
            <td className={`${TD} whitespace-nowrap`}>{row.year}</td>
          </tr>
          {row.isJcrc && (
            <SubRow>
              See the Junior Common Room Committee page for a full account of
              this role.
            </SubRow>
          )}
          {row.activities.length > 0 ? (
            <ActivityRows
              activities={row.activities}
              extraContribution={row.extraContribution}
            />
          ) : (
            row.extraContribution && (
              <SubRow>Additional contribution: {row.extraContribution}</SubRow>
            )
          )}
        </tbody>
      ))}
    </table>
  );
}

/**
 * The nested Activity | Role | Description table under a CCA row. The CCA's
 * additional contribution, when there is one, is its last row.
 */
function ActivityRows({
  activities,
  extraContribution,
}: {
  activities: InvolvementRow["activities"];
  extraContribution: string | null;
}) {
  return (
    <tr>
      <td colSpan={3} className="px-1 pb-1 pl-[18px] pt-0.5">
        <table className="w-full table-fixed border-collapse text-[10.5px]">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[22%]" />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={`${TH} font-semibold`}>
                Activity
              </th>
              <th scope="col" className={`${TH} font-semibold`}>
                Role
              </th>
              <th scope="col" className={`${TH} font-semibold`}>
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {activities.map((a, i) => (
              <tr key={`${i}-${a.title}`} className="break-inside-avoid">
                <td className={TD}>{a.title}</td>
                <td className={TD}>{a.role}</td>
                <td className={TD}>{a.description}</td>
              </tr>
            ))}
            {extraContribution && (
              <tr className="break-inside-avoid">
                <td className={`${TD} italic`}>Additional contribution</td>
                <td className={TD} />
                <td className={TD}>{extraContribution}</td>
              </tr>
            )}
          </tbody>
        </table>
      </td>
    </tr>
  );
}

/** Activities of CCAs the resident is not a member of. */
function OtherInvolvement({ rows }: { rows: OtherInvolvementRow[] }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col className="w-[28%]" />
        <col className="w-[22%]" />
        <col className="w-[16%]" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Activity
          </th>
          <th scope="col" className={TH}>
            Organised by
          </th>
          <th scope="col" className={TH}>
            Role
          </th>
          <th scope="col" className={TH}>
            Description
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${i}-${row.title}`} className="break-inside-avoid">
            <td className={TD}>{row.title}</td>
            <td className={TD}>{row.organiser}</td>
            <td className={TD}>{row.role}</td>
            <td className={TD}>{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function VolunteerHours({ volunteer }: { volunteer: VolunteerHoursModel }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col />
        <col className="w-[14%]" />
        <col className="w-[28%]" />
        <col className="w-[12%]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Activity
          </th>
          <th scope="col" className={TH}>
            Type
          </th>
          <th scope="col" className={TH}>
            Organised by
          </th>
          <th scope="col" className={TH}>
            Hours
          </th>
        </tr>
      </thead>
      <tbody>
        {volunteer.rows.map((row, i) => (
          <tr key={`${i}-${row.activity}`} className="break-inside-avoid">
            <td className={TD}>{row.activity}</td>
            <td className={TD}>{row.type}</td>
            <td className={TD}>{row.organiser}</td>
            <td className={TD}>{row.hours}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="break-inside-avoid font-bold">
          <td className={`${TD} border-t border-black`} colSpan={3}>
            Total
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
      <colgroup>
        <col />
        <col className="w-[7.5rem]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Award
          </th>
          <th scope="col" className={`${TH} whitespace-nowrap`}>
            Year
          </th>
        </tr>
      </thead>
      {rows.map((row, i) => (
        <tbody key={`${i}-${row.title}`} className="break-inside-avoid">
          <tr>
            <td className={TD}>{row.title}</td>
            <td className={`${TD} whitespace-nowrap`}>
              {row.academicYear.replace(/^AY/, "")}
            </td>
          </tr>
          {row.citation && (
            <tr>
              <td
                colSpan={2}
                className="px-1 pb-0.5 pl-[18px] text-[10.5px] italic text-neutral-800"
              >
                {row.citation}
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );
}

/** The footnotes for the superscripts on page 1, then a neutral closing line. */
export function NotesBody({
  notes,
  otherNotes = [],
  hasPartYear = false,
}: {
  notes: NoteRow[];
  /** "Activity: general description" lines for Other involvement. */
  otherNotes?: ActivityNote[];
  /** Explain "Sem 1 / Sem 2" when any row uses it. */
  hasPartYear?: boolean;
}) {
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
              {note.activities.map((a, i) => (
                <span key={`${i}-${a.title}`} className="block pl-[18px]">
                  {a.title}: {a.text}
                </span>
              ))}
            </p>
          ))}
        </section>
      )}

      {otherNotes.length > 0 && (
        <section>
          <h2 className={`${SEC_HEADING} mt-3.5`}>
            Notes on other involvement
          </h2>
          {otherNotes.map((a, i) => (
            <p key={`${i}-${a.title}`} className="my-0.5 break-inside-avoid">
              {a.title}: {a.text}
            </p>
          ))}
        </section>
      )}

      {hasPartYear && (
        <p className="my-1 text-[10.5px]">
          Sem 1 / Sem 2: involvement for that semester only.
        </p>
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
