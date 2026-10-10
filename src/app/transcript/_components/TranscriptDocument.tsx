import Image from "next/image";
import {
  type CommitmentLevel,
  type Signatory,
  type Transcript,
  formatIssuedOn,
  groupByYear,
} from "~/lib/transcript/demoData";
import { documentSerif, signatureScript } from "./fonts";
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

const COMMITMENT_STYLE: Record<CommitmentLevel, string> = {
  High: "bg-emerald-100 text-emerald-900",
  Moderate: "bg-amber-100 text-amber-900",
  Light: "bg-stone-200 text-stone-800",
};

function Signature({
  signatory,
  size = "md",
}: {
  signatory: Signatory;
  size?: "sm" | "md";
}) {
  return (
    <div className="flex flex-col">
      <span
        className={`${signatureScript.className} leading-none text-[#1d2b5c] ${
          size === "sm" ? "text-[26px]" : "text-[38px]"
        }`}
        aria-hidden
      >
        {signatory.name}
      </span>
      <span
        className={`border-t border-stone-400 pt-1 ${
          size === "sm" ? "text-[11px]" : "text-sm"
        }`}
      >
        <span className="font-semibold">{signatory.name}</span>
        <br />
        <span className="text-stone-600">{signatory.title}</span>
      </span>
    </div>
  );
}

export function TranscriptDocument({ transcript }: { transcript: Transcript }) {
  const years = groupByYear(transcript.entries);
  const leadership = transcript.entries.filter((e) =>
    isLeadershipPosition(e.position),
  ).length;
  const distinctCcas = new Set(transcript.entries.map((e) => e.ccaName)).size;

  return (
    <article
      className={`${documentSerif.className} relative mx-auto w-full max-w-[210mm] bg-[#fdfcf8] px-6 py-8 text-stone-900 shadow-xl sm:px-12 sm:py-12 print:max-w-none print:px-0 print:py-0 print:shadow-none`}
      style={{
        backgroundImage: transcript.isSpecimen ? WATERMARK : undefined,
        printColorAdjust: "exact",
        WebkitPrintColorAdjust: "exact",
      }}
    >
      {transcript.isSpecimen && (
        <p className="mb-6 rounded border border-red-300 bg-red-50 px-3 py-2 text-center font-sans text-xs font-semibold uppercase tracking-wider text-red-800">
          Specimen · demonstration data · not an official record of Raffles Hall
        </p>
      )}

      {/* Letterhead */}
      <header className="flex items-center gap-4 border-b-2 border-emerald-900 pb-5">
        <Image
          src="/raffles-hall-logo.svg"
          alt="Raffles Hall crest"
          width={64}
          height={64}
          className="h-16 w-16"
        />
        <div className="flex-1">
          <p className="text-xs uppercase tracking-[0.25em] text-stone-600">
            National University of Singapore
          </p>
          <h1 className="text-2xl font-semibold tracking-wide text-emerald-950 sm:text-3xl">
            Raffles Hall
          </h1>
          <p className="text-base italic text-stone-700">
            Co-Curricular Activities Transcript
          </p>
        </div>
      </header>

      {/* Resident particulars */}
      <section className="grid grid-cols-1 gap-x-8 gap-y-2 border-b border-stone-300 py-5 text-[15px] sm:grid-cols-2">
        <Particular label="Name of resident" value={transcript.resident.name} />
        <Particular label="Matriculation no." value={transcript.resident.matric} />
        <Particular label="Faculty" value={transcript.resident.faculty} />
        <Particular label="Period of residence" value={transcript.residencyPeriod} />
        <Particular label="Date of issue" value={formatIssuedOn(transcript.issuedOn)} />
        <Particular
          label="Verification code"
          value={transcript.verificationCode}
          mono
        />
      </section>

      {/* Summary */}
      <section className="grid grid-cols-3 border-b border-stone-300 py-4 text-center">
        <Stat value={years.length} label="Academic years" />
        <Stat value={distinctCcas} label="CCAs" />
        <Stat value={leadership} label="Leadership roles" />
      </section>

      {/* Record, one block per academic year */}
      <section className="space-y-6 py-6">
        {years.map(({ academicYear, entries }) => (
          <div key={academicYear} className="break-inside-avoid">
            <h2 className="mb-2 text-lg font-semibold uppercase tracking-widest text-emerald-900">
              {academicYear}
            </h2>
            <ol className="divide-y divide-stone-200 border-y border-stone-300">
              {entries.map((e) => (
                <li
                  key={`${e.academicYear}-${e.ccaName}`}
                  className="grid grid-cols-1 gap-3 py-3 sm:grid-cols-[1fr_190px] sm:gap-6"
                >
                  <div>
                    <p className="text-[17px] font-semibold leading-snug">
                      {e.ccaName}
                      <span className="font-normal text-stone-600">
                        {" "}
                        — {e.position}
                      </span>
                    </p>
                    <p className="text-xs uppercase tracking-wider text-stone-500">
                      {e.category}
                    </p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                      <span
                        className={`rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold ${COMMITMENT_STYLE[e.commitment.level]}`}
                      >
                        {e.commitment.level} commitment
                      </span>
                      <span className="text-stone-600">
                        ~{e.commitment.hoursPerWeek} h/week
                      </span>
                    </p>
                    <p className="mt-1 text-[15px] italic text-stone-700">
                      {e.commitment.summary}
                    </p>
                  </div>
                  <Signature signatory={e.certifiedBy} size="sm" />
                </li>
              ))}
            </ol>
          </div>
        ))}
      </section>

      {/* Endorsement */}
      <section className="break-inside-avoid border-t-2 border-emerald-900 pt-6">
        <p className="mb-8 text-[15px] leading-relaxed text-stone-700">
          We certify that the above is a true record of the resident&rsquo;s
          participation in the co-curricular life of Raffles Hall, as attested
          by the respective CCA leaders for each academic year.
        </p>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
          <Signature signatory={transcript.jcrcPresident} />
          <Signature signatory={transcript.master} />
        </div>
      </section>

      {/* Verification footer */}
      <footer className="mt-10 flex items-center gap-4 border-t border-stone-300 pt-4 font-sans text-xs text-stone-600">
        <VerifyQr code={transcript.verificationCode} />
        <p className="leading-relaxed">
          To verify this transcript, scan the code or visit{" "}
          <span className="font-semibold">rhapp.lol/verify</span> and enter{" "}
          <span className="font-mono font-semibold text-stone-900">
            {transcript.verificationCode}
          </span>
          . The verification page shows the record as held by Raffles Hall;
          any difference from this copy means this copy has been altered.
        </p>
      </footer>
    </article>
  );
}

/**
 * Named roles, not "anything but Member": Writer or Developer is a function in
 * the CCA, not a leadership position, and counting it would overstate the
 * record to exactly the outside reader this document is for.
 */
function isLeadershipPosition(position: string): boolean {
  return /captain|head|chair|president|secretary|director|lead/i.test(position);
}

function Particular({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wider text-stone-500">
        {label}
      </span>
      <span className={mono ? "font-mono text-sm font-semibold" : "font-semibold"}>
        {value}
      </span>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="text-2xl font-semibold text-emerald-900">{value}</p>
      <p className="text-[11px] uppercase tracking-wider text-stone-500">
        {label}
      </p>
    </div>
  );
}
