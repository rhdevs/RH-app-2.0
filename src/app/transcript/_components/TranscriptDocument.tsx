import Image from "next/image";
import { type ReactNode } from "react";
import {
  type YearTranscript,
  formatAcademicYear,
  formatIssuedOn,
  formatSemesters,
  formatYearOfResidence,
} from "~/lib/transcript/demoData";
import { letterheadSerif } from "./fonts";
import { VerifyQr } from "./VerifyQr";

/**
 * Tiled diagonal "SPECIMEN" behind the whole document. A background TILE
 * rather than one absolutely-positioned word, so it repeats onto every printed
 * page; `print-color-adjust: exact` stops the browser dropping it when
 * printing, which it otherwise does to all backgrounds by default.
 */
const WATERMARK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='360' height='240'><text x='50%' y='50%' text-anchor='middle' dominant-baseline='middle' transform='rotate(-30 180 120)' font-family='Georgia,serif' font-size='44' font-weight='700' letter-spacing='6' fill='rgba(180,40,40,0.09)'>SPECIMEN</text></svg>`,
)}")`;

/** Faint diagonal hatching, after the security paper transcripts print on. */
const SECURITY_HATCH =
  "repeating-linear-gradient(135deg, rgba(6,78,59,0.035) 0 1px, transparent 1px 7px)";

/**
 * One academic year's record, laid out like an institutional transcript:
 * particulars, then a table per category, then explanatory notes. A category
 * with no rows is left out entirely, as the notes say.
 */
export function TranscriptDocument({
  transcript: t,
}: {
  transcript: YearTranscript;
}) {
  // Same rule as the sections: a category with nothing in it is not mentioned.
  const counts = (
    [
      [t.leadership.length, "JCRC appointments"],
      [t.ccas.length, "CCAs"],
      [t.achievements.length, "Achievements"],
    ] as const
  ).filter(([n]) => n > 0);

  return (
    <article
      className="relative mx-auto w-full max-w-[210mm] bg-white px-5 py-7 font-[Arial,Helvetica,sans-serif] text-[12.5px] leading-snug text-black shadow-xl sm:px-10 sm:py-10 print:max-w-none print:px-0 print:py-0 print:shadow-none"
      style={{
        backgroundImage: t.isSpecimen
          ? `${WATERMARK}, ${SECURITY_HATCH}`
          : SECURITY_HATCH,
        printColorAdjust: "exact",
        WebkitPrintColorAdjust: "exact",
      }}
    >
      {t.isSpecimen && (
        <p className="mb-5 border border-red-300 bg-red-50 px-3 py-1.5 text-center text-[11px] font-bold uppercase tracking-wider text-red-800">
          Specimen · demonstration data · not an official record of Raffles Hall
        </p>
      )}

      {/* Letterhead */}
      <header className="flex items-center gap-4 border-b-[3px] border-double border-black pb-3">
        <Image
          src="/raffles-hall-logo.svg"
          alt="Raffles Hall crest"
          width={60}
          height={60}
          className="h-[60px] w-[60px]"
        />
        <div className="flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em]">
            National University of Singapore
          </p>
          <h1
            className={`${letterheadSerif.className} text-[26px] font-semibold uppercase leading-tight tracking-[0.08em]`}
          >
            Raffles Hall
          </h1>
          <p className="text-[11px] font-bold uppercase tracking-[0.15em]">
            Record of Co-Curricular Activities
          </p>
        </div>
        <div className="hidden text-right sm:block">
          <p className="text-[10px] uppercase tracking-wider text-neutral-600">
            Record for
          </p>
          <p className="text-[15px] font-bold">{t.academicYear}</p>
        </div>
      </header>

      {/* Particulars */}
      <table className="mt-4 w-full border-collapse border border-black text-[12px]">
        <tbody>
          <tr>
            <Particular label="Name">{t.resident.name}</Particular>
            <Particular label="Matriculation No.">
              {t.resident.matric}
            </Particular>
          </tr>
          <tr>
            <Particular label="Academic Year">
              {formatAcademicYear(t.academicYear)}
            </Particular>
            <Particular label="Residence">
              {t.resident.block} · {formatYearOfResidence(t.yearOfResidence)}
            </Particular>
          </tr>
          <tr>
            <Particular label="Date of Issue">
              {formatIssuedOn(t.issuedOn)}
            </Particular>
            <Particular label="Verification Code">
              <span className="font-mono">{t.verificationCode}</span>
            </Particular>
          </tr>
        </tbody>
      </table>

      {/* Record */}
      <div className="mt-5 space-y-5">
        {t.leadership.length > 0 && (
          <Section
            title="Leadership"
            head={["Appointment", "Organisation", "Period"]}
            widths={["34%", "48%", "18%"]}
            rows={t.leadership.map((r) => [
              r.appointment,
              "Junior Common Room Committee (JCRC)",
              formatSemesters(r.semesters),
            ])}
          />
        )}
        {t.ccas.length > 0 && (
          <Section
            title="CCA Participation"
            head={["CCA", "Category", "Position", "Period"]}
            widths={["34%", "26%", "22%", "18%"]}
            rows={t.ccas.map((r) => [
              r.cca,
              r.category,
              r.position,
              formatSemesters(r.semesters),
            ])}
          />
        )}
        {t.achievements.length > 0 && (
          <Section
            title="Achievements and Awards"
            head={["Achievement", "Details", "Date"]}
            widths={["34%", "48%", "18%"]}
            rows={t.achievements.map((r) => [r.title, r.detail, r.month])}
          />
        )}
      </div>

      <p className="mt-4 border-t border-black pt-1.5 text-[11px]">
        <span className="font-bold uppercase tracking-wider">Summary: </span>
        {counts.map(([n, label], i) => (
          <span key={label}>
            {i > 0 && " · "}
            {label} {n}
          </span>
        ))}
      </p>

      <p className="mt-5 text-center text-[11px] font-bold uppercase tracking-[0.3em]">
        — End of Record —
      </p>

      {/* Authentication: electronic issue, no signature */}
      <section className="mt-6 flex break-inside-avoid items-center gap-4 border border-black p-3">
        <VerifyQr code={t.verificationCode} />
        <div className="text-[11px] leading-relaxed">
          <p className="font-bold uppercase tracking-wider">
            Electronically issued record
          </p>
          <p>
            This record is generated and digitally issued by Raffles Hall. It is
            valid without a signature. To confirm it is authentic, scan the code
            or visit <span className="font-bold">rhapp.lol/verify</span> and
            enter{" "}
            <span className="font-mono font-bold">{t.verificationCode}</span>.
            Any difference between this copy and the record shown there means
            this copy has been altered.
          </p>
        </div>
      </section>

      <ExplanatoryNotes transcript={t} />
    </article>
  );
}

function Particular({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      <th className="w-[19%] border border-black bg-neutral-100/80 px-2 py-1 text-left align-top text-[10.5px] font-bold uppercase tracking-wide">
        {label}
      </th>
      <td className="border border-black px-2 py-1 align-top font-semibold">
        {children}
      </td>
    </>
  );
}

function Section({
  title,
  head,
  widths,
  rows,
}: {
  title: string;
  head: string[];
  widths: string[];
  rows: string[][];
}) {
  return (
    <section className="break-inside-avoid">
      <h2 className="mb-1 text-[12px] font-bold uppercase tracking-[0.12em] underline underline-offset-2">
        {title}
      </h2>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-black">
            {head.map((h) => (
              <th
                key={h}
                className="py-1 pr-2 text-left text-[11px] font-bold italic"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="align-top">
              {cells.map((c, j) => (
                <td key={j} className="break-words py-[3px] pr-2">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * The back page. An outside reader has never heard of RHMP or Inter-Hall
 * Games; the notes are what let them read the record without asking anyone.
 */
function ExplanatoryNotes({ transcript: t }: { transcript: YearTranscript }) {
  return (
    <section className="mt-10 print:mt-0 print:break-before-page">
      {/* A loose back page must still say whose record it belongs to. */}
      <p className="mb-2 hidden justify-between border-b border-black pb-1 text-[10.5px] print:flex">
        <span>
          {t.resident.name} · {t.resident.matric} · {t.academicYear}
        </span>
        <span className="font-mono">{t.verificationCode}</span>
      </p>
      <div className="border border-black p-4 text-[11px] leading-relaxed">
        <h2 className="mb-2 text-[12px] font-bold uppercase tracking-[0.12em] underline underline-offset-2">
          Explanatory Notes
        </h2>
        <dl className="space-y-2.5">
          <Note term="Explanation of record categories (only categories with entries for the year are included)">
            Raffles Hall is a residential hall of the National University of
            Singapore. This record lists a resident&rsquo;s co-curricular
            involvement in the hall for one academic year. Each academic year is
            issued as a separate record.
          </Note>
          <Note term="Leadership">
            Appointments held on the Junior Common Room Committee (JCRC), the
            elected student government of Raffles Hall. Only JCRC appointments
            are listed here.
          </Note>
          <Note term="CCA Participation">
            Every hall co-curricular activity (CCA) the resident took part in,
            including hall committees, with the position held and the category
            the hall groups that CCA under. Positions such as Captain or Head
            are the leadership of that CCA. RHMP is the Raffles Hall Musical
            Production, staged annually by residents.
          </Note>
          <Note term="Achievements and Awards">
            Results at competitions the resident represented the hall in,
            including the Inter-Hall Games (IHG) between NUS halls of residence,
            and awards conferred by the hall. Included only when there is an
            entry to record.
          </Note>
          <Note term="Period">
            Semester 1 runs from August to December and Semester 2 from January
            to May. &ldquo;Sem 1 &amp; 2&rdquo; denotes involvement across the
            whole academic year.
          </Note>
          <Note term="Authenticity">
            Every entry is confirmed before the record is issued: CCA entries by
            the head of that CCA, and Leadership entries by the JCRC. The record
            is issued electronically and bears no signature; its authenticity is
            established only by the verification page at rhapp.lol/verify.
          </Note>
        </dl>
      </div>
    </section>
  );
}

function Note({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-bold italic">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
