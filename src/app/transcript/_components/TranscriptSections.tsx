import { formatIssuedOn } from "~/lib/transcript/assemble";
import {
  type AwardRow,
  type CcaDescriptionRow,
  type InvolvementRow,
  type TranscriptSection,
  type VolunteerHoursModel,
} from "~/lib/transcript/types";

/**
 * The body of a transcript: one block per section in the view model, in the
 * order the assembler produced. Adding a section kind means adding a member to
 * `TranscriptSection`, one case in `SectionBody` and one title below. The
 * document shell and the pages do not change.
 *
 * Page breaks: headings stay with their content, and a CCA row stays together
 * with its "Additional contributions" subsection (each CCA is its own
 * <tbody>). The header row of each table repeats on every printed page.
 */

const SECTION_TITLES: Record<TranscriptSection["kind"], string> = {
  involvements: "Co-curricular involvements",
  ccaDescriptions: "CCA descriptions",
  volunteerHours: "Volunteer hours",
  awards: "Awards",
};

export function TranscriptSections({
  sections,
}: {
  sections: TranscriptSection[];
}) {
  return (
    <>
      {sections.map((section, index) => (
        <section key={section.kind} className="py-5">
          <h2 className="mb-3 break-after-avoid text-base font-semibold uppercase tracking-widest text-emerald-900">
            {index + 1}. {SECTION_TITLES[section.kind]}
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
    case "ccaDescriptions":
      return <CcaDescriptions rows={section.rows} />;
    case "volunteerHours":
      return <VolunteerHours volunteer={section.volunteer} />;
    case "awards":
      return <Awards rows={section.rows} />;
  }
}

const TH =
  "py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-stone-500";

function Involvements({ rows }: { rows: InvolvementRow[] }) {
  return (
    <table className="w-full border-collapse text-[15px]">
      <thead className="border-y border-stone-300">
        <tr>
          <th scope="col" className={`${TH} w-[45%]`}>
            CCA
          </th>
          <th scope="col" className={TH}>
            Category
          </th>
          <th scope="col" className={TH}>
            Role
          </th>
        </tr>
      </thead>
      {rows.map((row) => (
        <tbody
          key={row.ccaName}
          className="break-inside-avoid border-b border-stone-200"
        >
          <tr>
            <td className="py-2 pr-3 font-semibold">{row.ccaName}</td>
            <td className="py-2 pr-3 text-stone-600">{row.category}</td>
            <td className="py-2">{row.role}</td>
          </tr>
          {row.extraContribution && (
            <tr>
              <td colSpan={3} className="pb-2 pl-4 pr-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-500">
                  Additional contributions
                </p>
                <p className="text-[15px] text-stone-800">
                  {row.extraContribution}
                </p>
              </td>
            </tr>
          )}
        </tbody>
      ))}
    </table>
  );
}

function CcaDescriptions({ rows }: { rows: CcaDescriptionRow[] }) {
  return (
    <dl className="space-y-3">
      {rows.map((row) => (
        <div key={row.ccaName} className="break-inside-avoid">
          <dt className="font-semibold">{row.ccaName}</dt>
          <dd
            className={
              row.isMissing
                ? "text-sm text-stone-400"
                : "text-[15px] text-stone-700"
            }
          >
            {row.description}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function hours(value: number): string {
  return `${value} h`;
}

function VolunteerHours({ volunteer }: { volunteer: VolunteerHoursModel }) {
  const { regular, oneOff, total } = volunteer;
  return (
    <div className="space-y-4">
      {regular.rows.length > 0 && (
        <div className="break-inside-avoid">
          <h3 className="mb-1 text-sm font-semibold text-stone-700">
            Regular (through a CCA)
          </h3>
          <table className="w-full border-collapse text-[15px]">
            <thead className="border-y border-stone-300">
              <tr>
                <th scope="col" className={TH}>
                  CCA
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Hours
                </th>
              </tr>
            </thead>
            <tbody>
              {regular.rows.map((row) => (
                <tr key={row.ccaName} className="border-b border-stone-200">
                  <td className="py-1.5">{row.ccaName}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {hours(row.hours)}
                  </td>
                </tr>
              ))}
            </tbody>
            <SubtotalFoot label="Regular subtotal" value={regular.subtotal} />
          </table>
        </div>
      )}

      {oneOff.rows.length > 0 && (
        <div className="break-inside-avoid">
          <h3 className="mb-1 text-sm font-semibold text-stone-700">One-off</h3>
          <table className="w-full border-collapse text-[15px]">
            <thead className="border-y border-stone-300">
              <tr>
                <th scope="col" className={TH}>
                  Event
                </th>
                <th scope="col" className={TH}>
                  Date
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Hours
                </th>
              </tr>
            </thead>
            <tbody>
              {oneOff.rows.map((row) => (
                <tr
                  key={`${row.date}-${row.eventName}`}
                  className="border-b border-stone-200"
                >
                  <td className="py-1.5 pr-3">{row.eventName}</td>
                  <td className="py-1.5 pr-3 text-stone-600">
                    {formatIssuedOn(row.date)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {hours(row.hours)}
                  </td>
                </tr>
              ))}
            </tbody>
            <SubtotalFoot
              label="One-off subtotal"
              value={oneOff.subtotal}
              colSpan={2}
            />
          </table>
        </div>
      )}

      <p className="flex justify-between border-t-2 border-stone-400 pt-2 text-[15px] font-semibold">
        <span>Total volunteer hours</span>
        <span className="tabular-nums">{hours(total)}</span>
      </p>
    </div>
  );
}

function SubtotalFoot({
  label,
  value,
  colSpan = 1,
}: {
  label: string;
  value: number;
  colSpan?: number;
}) {
  return (
    <tfoot>
      <tr>
        <td
          colSpan={colSpan}
          className="pt-1.5 text-right text-sm text-stone-600"
        >
          {label}
        </td>
        <td className="pt-1.5 text-right font-semibold tabular-nums">
          {hours(value)}
        </td>
      </tr>
    </tfoot>
  );
}

function Awards({ rows }: { rows: AwardRow[] }) {
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li
          key={`${row.academicYear}-${row.title}`}
          className="break-inside-avoid"
        >
          <p className="flex flex-wrap items-baseline justify-between gap-x-4">
            <span className="font-semibold">{row.title}</span>
            <span className="text-sm text-stone-600">{row.academicYear}</span>
          </p>
          {row.citation && (
            <p className="text-[15px] italic text-stone-700">{row.citation}</p>
          )}
        </li>
      ))}
    </ul>
  );
}
