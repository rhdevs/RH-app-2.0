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

const SEM_SUFFIX = /(\(Sem [12]\))/;

/**
 * Text that may carry a semester suffix: "Sem" and its number are joined by a
 * no-break space and a parenthesised "(Sem 1)" is kept whole, so the suffix is
 * never split across lines. The rest of the text wraps as usual.
 */
export function SemText({ text }: { text: string | null | undefined }) {
  if (!text) return <>{text}</>;
  return (
    <>
      {text.split(SEM_SUFFIX).map((part, i) =>
        SEM_SUFFIX.test(part) ? (
          <span key={i} className="whitespace-nowrap">
            {part.replace(/Sem /g, "Sem ")}
          </span>
        ) : (
          part.replace(/Sem ([12])/g, "Sem $1")
        ),
      )}
    </>
  );
}

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
            <td className={TD}>
              <SemText text={row.role} />
            </td>
            <td className={`${TD} whitespace-nowrap`}>
              <SemText text={row.year} />
            </td>
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

/** Nested rows: smaller text, title indented one level under the CCA name. */
const NESTED = "px-1 py-0.5 align-top text-[10.5px]";
const NESTED_TITLE = `${NESTED} pl-[18px]`;
/** A description sits under its title, one level further in, across the CCA and Role columns. */
const NESTED_TEXT = `${NESTED} pl-[36px] pt-0`;

/**
 * The nested activity rows under a CCA row, in the main table's own grid and
 * with NO header row: the title in the CCA column (indented), the role in the
 * Role column and nothing in the Year column; the description on its own line
 * under the title, across the CCA and Role columns. The CCA's additional
 * contribution, when there is one, is the last entry: its label, then its text.
 * A title never separates from its description (`break-after-avoid`), and the
 * whole CCA group stays together on a page.
 */
function ActivityRows({
  activities,
  extraContribution,
}: {
  activities: InvolvementRow["activities"];
  extraContribution: string | null;
}) {
  return (
    <>
      {activities.map((a, i) => (
        <NestedEntry
          key={`${i}-${a.title}`}
          title={<SemText text={a.title} />}
          role={a.role}
          text={a.description}
        />
      ))}
      {extraContribution && (
        <NestedEntry
          title={<em>Additional contribution</em>}
          role={null}
          text={extraContribution}
        />
      )}
    </>
  );
}

function NestedEntry({
  title,
  role,
  text,
}: {
  title: ReactNode;
  role: string | null;
  text: string | null;
}) {
  return (
    <>
      <tr className={text ? "break-after-avoid" : undefined}>
        <td className={NESTED_TITLE}>{title}</td>
        <td className={NESTED}>
          <SemText text={role} />
        </td>
        <td className={NESTED} />
      </tr>
      {text && (
        <tr className="break-before-avoid">
          <td colSpan={2} className={NESTED_TEXT}>
            {text}
          </td>
          <td className={NESTED_TEXT} />
        </tr>
      )}
    </>
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
            <td className={TD}>
              <SemText text={row.title} />
            </td>
            <td className={TD}>{row.organiser}</td>
            <td className={TD}>
              <SemText text={row.role} />
            </td>
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
                  <SemText text={a.title} />: {a.text}
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
              <SemText text={a.title} />: {a.text}
            </p>
          ))}
        </section>
      )}

      {hasPartYear && (
        <p className="my-1 text-[10.5px]">
          Sem 1 / Sem 2: involvement for that semester only.
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
