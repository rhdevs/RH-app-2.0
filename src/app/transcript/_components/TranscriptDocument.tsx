import Image from "next/image";
import { formatIssuedOn } from "~/lib/transcript/assemble";
import { type TranscriptViewModel } from "~/lib/transcript/types";
import { documentSerif } from "./fonts";
import { TranscriptSections } from "./TranscriptSections";
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

export const EMPTY_YEAR_MESSAGE =
  "No recorded involvements for this academic year.";

export function TranscriptDocument({
  transcript,
}: {
  transcript: TranscriptViewModel;
}) {
  const { resident } = transcript;

  return (
    <article
      className={`${documentSerif.className} relative mx-auto w-full max-w-[210mm] bg-[#fdfcf8] px-6 py-8 text-stone-900 shadow-xl sm:px-12 sm:py-12 print:max-w-none print:px-0 print:py-0 print:shadow-none`}
      style={{
        backgroundImage: resident.isSpecimen ? WATERMARK : undefined,
        printColorAdjust: "exact",
        WebkitPrintColorAdjust: "exact",
      }}
    >
      {resident.isSpecimen && (
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
            Co-Curricular Transcript
          </p>
        </div>
      </header>

      {/* Resident details and verification */}
      <section className="flex flex-wrap items-start justify-between gap-6 border-b border-stone-300 py-5">
        <div className="grid flex-1 grid-cols-1 gap-x-8 gap-y-2 text-[15px] sm:grid-cols-2">
          <Particular label="Name of resident" value={resident.name} />
          <Particular label="Matriculation no." value={resident.matric} />
          {resident.faculty && (
            <Particular label="Faculty" value={resident.faculty} />
          )}
          <Particular label="Academic year" value={transcript.academicYear} />
          <Particular
            label="Date of issue"
            value={formatIssuedOn(resident.issuedOn)}
          />
          <Particular
            label="Verification code"
            value={resident.verificationCode}
            mono
          />
        </div>
        <div className="flex flex-col items-center gap-1 font-sans text-[10px] text-stone-500">
          <VerifyQr code={resident.verificationCode} />
          <span>Scan to verify</span>
        </div>
      </section>

      {transcript.isEmpty ? (
        <p
          role="status"
          className="py-12 text-center text-[17px] italic text-stone-600"
        >
          {EMPTY_YEAR_MESSAGE}
        </p>
      ) : (
        <TranscriptSections sections={transcript.sections} />
      )}

      <footer className="mt-6 break-inside-avoid border-t border-stone-300 pt-4 font-sans text-xs leading-relaxed text-stone-600">
        To verify this transcript, scan the code or visit{" "}
        <span className="font-semibold">rhapp.lol/verify</span> and enter{" "}
        <span className="font-mono font-semibold text-stone-900">
          {resident.verificationCode}
        </span>
        . The verification page shows the record as held by Raffles Hall; any
        difference from this copy means this copy has been altered.
      </footer>
    </article>
  );
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
      <span
        className={mono ? "font-mono text-sm font-semibold" : "font-semibold"}
      >
        {value}
      </span>
    </div>
  );
}
