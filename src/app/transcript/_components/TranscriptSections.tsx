import { Fragment } from "react";
import {
  type AwardRow,
  type InvolvementRow,
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
 * The body of page 1. Page 1 is one block per section in
 * the view model, in the order the assembler produced. Adding a section kind
 * means adding a member to `TranscriptSection`, one case in `SectionBody` and
 * one title below; the document and the pages do not change.
 *
 * Page breaks: every row stays whole, and the header row of each table repeats
 * on every printed page.
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

/**
 * The one table of CCAs and their activities: # | CCA / activity | Role |
 * Description | Year, with one header row (repeated on each printed page). CCAs
 * are numbered 1, 2, 3 and each activity 1.1, 1.2 ... on ONE row of its own,
 * indented, with its role and description and an empty Year. A CCA's
 * additional contribution is its last row, unnumbered, its text in the
 * Description column. The Year column fits "2026/27 Sem 2" on one line.
 *
 * Page breaks: every row stays whole, and a CCA row never separates from its
 * first activity (or its additional contribution).
 */
function Involvements({ rows }: { rows: InvolvementRow[] }) {
  return (
    <table className="w-full table-fixed border-collapse">
      <colgroup>
        <col className="w-[6%]" />
        <col className="w-[26%]" />
        <col className="w-[16%]" />
        <col />
        <col className="w-[6.5rem]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className={TH}>
            #
          </th>
          <th scope="col" className={TH}>
            CCA / activity
          </th>
          <th scope="col" className={TH}>
            Role
          </th>
          <th scope="col" className={TH}>
            Description
          </th>
          <th scope="col" className={`${TH} whitespace-nowrap`}>
            Year
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const hasNested =
            row.activities.length > 0 || row.extraContribution !== null;
          return (
            <Fragment key={row.number}>
              <tr
                className={`break-inside-avoid ${hasNested ? "break-after-avoid" : ""}`}
              >
                <td className={TD}>{row.number}</td>
                <td className={TD}>{row.ccaName}</td>
                <td className={TD}>
                  <SemText text={row.role} />
                </td>
                <td className={TD}>{row.description}</td>
                <td className={`${TD} whitespace-nowrap`}>
                  <SemText text={row.year} />
                </td>
              </tr>
              {row.activities.map((a) => (
                <tr key={a.number} className="break-inside-avoid">
                  <td className={`${NESTED} text-neutral-700`}>{a.number}</td>
                  <td className={`${NESTED} pl-[18px]`}>
                    <SemText text={a.title} />
                  </td>
                  <td className={NESTED}>{a.role}</td>
                  <td className={NESTED}>{a.description}</td>
                  <td className={NESTED} />
                </tr>
              ))}
              {row.extraContribution && (
                <tr className="break-inside-avoid">
                  <td className={NESTED} />
                  <td className={`${NESTED} pl-[18px] italic`}>
                    Additional contribution
                  </td>
                  <td className={NESTED} />
                  <td className={NESTED}>{row.extraContribution}</td>
                  <td className={NESTED} />
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** Activity and contribution rows sit under their CCA in smaller type. */
const NESTED = "px-1 py-0.5 align-top text-[10.5px]";

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

/**
 * The end of the document, after the last page: the Sem 1 / Sem 2 key (only
 * when a part-year item appears), About this record, and the end marker. It
 * stays together on one page.
 */
export function ClosingBlock({ hasPartYear }: { hasPartYear: boolean }) {
  return (
    <div className="break-inside-avoid">
      {hasPartYear && (
        <p className="my-1 mt-3 text-[10.5px]">
          <SemText text="Sem 1 / Sem 2: involvement for that semester only." />
        </p>
      )}
      <section>
        <h2 className={`${SEC_HEADING} mt-3.5`}>About this record</h2>
        <p className="my-0.5 text-[10.5px]">
          Generated from Raffles Hall&rsquo;s records.
        </p>
        <p className="mt-3 text-center font-bold tracking-[0.06em]">
          — END OF TRANSCRIPT —
        </p>
      </section>
    </div>
  );
}
