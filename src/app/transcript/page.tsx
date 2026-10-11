import Link from "next/link";
import { notFound } from "next/navigation";
import { type Metadata } from "next";
import Header from "../_components/header";
import {
  getTranscriptForYear,
  getYearsForResident,
  yearToParam,
} from "~/lib/transcript/demoData";
import { TranscriptDocument } from "./_components/TranscriptDocument";
import { PrintButton } from "./_components/PrintButton";

export const metadata: Metadata = {
  title: "CCA Transcript (Specimen) · RHApp",
};

/**
 * SHOWCASE. Renders a fixed specimen, not the signed-in resident's record —
 * there is no historical membership data to build a real one from yet (see
 * src/lib/transcript/demoData.ts). One document per academic year, picked
 * with `?ay=2025-26`; no `ay` shows the latest.
 *
 * Not login-gated (MatricGate only ever redirects SIGNED-IN users) — fine
 * while it shows nothing but the specimen. WHEN IT SHOWS A REAL RECORD it must
 * read the session server-side and render only the signed-in resident's own
 * transcript.
 */
export default function TranscriptPage({
  searchParams,
}: {
  searchParams: { ay?: string | string[] };
}) {
  const ay = Array.isArray(searchParams.ay)
    ? searchParams.ay[0]
    : searchParams.ay;
  const transcript = getTranscriptForYear(ay);
  if (!transcript) notFound();
  const years = getYearsForResident();

  return (
    <>
      {/* A4, and nothing but the document on paper. */}
      <style>{`@page { size: A4; margin: 14mm; } @media print { html, body, main { background: #fff !important; } }`}</style>

      <div className="print:hidden">
        <Header currentPage="profile" />
      </div>

      <div className="mx-auto max-w-[210mm] px-4 pb-4 pt-24 print:hidden">
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Preview of an upcoming feature</p>
          <p className="mt-1">
            This is a sample transcript with made-up names and CCAs. Your own
            transcripts, one for each academic year, will appear here once CCA
            records are kept by year.
          </p>
        </div>

        <nav aria-label="Academic year" className="mb-3 flex flex-wrap gap-2">
          {years.map((y) => {
            const active = y === transcript.academicYear;
            return (
              <Link
                key={y}
                href={`/transcript?ay=${yearToParam(y)}`}
                aria-current={active ? "page" : undefined}
                className={`rounded-full border px-3 py-1 text-sm font-medium ${
                  active
                    ? "border-emerald-800 bg-emerald-800 text-white"
                    : "border-gray-300 bg-white text-gray-700 hover:border-emerald-700"
                }`}
              >
                {y}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrintButton />
          <Link
            href={`/verify/${transcript.verificationCode}`}
            className="text-sm font-medium text-emerald-800 underline hover:text-emerald-600"
          >
            See what a verifier sees →
          </Link>
        </div>
      </div>

      <div className="px-2 pb-16 sm:px-4 print:p-0">
        <TranscriptDocument transcript={transcript} />
      </div>
    </>
  );
}
