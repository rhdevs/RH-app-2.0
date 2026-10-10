import Link from "next/link";
import { type Metadata } from "next";
import Header from "../_components/header";
import { DEMO_TRANSCRIPT } from "~/lib/transcript/demoData";
import { TranscriptDocument } from "./_components/TranscriptDocument";
import { PrintButton } from "./_components/PrintButton";

export const metadata: Metadata = {
  title: "CCA Transcript (Specimen) · RHApp",
};

/**
 * SHOWCASE. Renders the fixed specimen, not the signed-in resident's record —
 * there is no historical membership data to build a real one from yet (see
 * src/lib/transcript/demoData.ts). Not login-gated (MatricGate only ever
 * redirects SIGNED-IN users) — fine while it shows nothing but the specimen.
 * WHEN IT SHOWS A REAL RECORD it must read the session server-side and render
 * only the signed-in resident's own transcript.
 */
export default function TranscriptPage() {
  return (
    <>
      {/* A4, and nothing but the document on paper. */}
      <style>{`@page { size: A4; margin: 14mm; }`}</style>

      <div className="print:hidden">
        <Header currentPage="profile" />
      </div>

      <div className="mx-auto max-w-[210mm] px-4 pb-4 pt-24 print:hidden">
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Preview of an upcoming feature</p>
          <p className="mt-1">
            This is a sample transcript with made-up names, CCAs and
            signatures. Your own transcript will appear here once CCA records
            are kept by academic year.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrintButton />
          <Link
            href={`/verify/${DEMO_TRANSCRIPT.verificationCode}`}
            className="text-sm font-medium text-emerald-800 underline hover:text-emerald-600"
          >
            See what a verifier sees →
          </Link>
        </div>
      </div>

      <div className="px-2 pb-16 sm:px-4 print:p-0">
        <TranscriptDocument transcript={DEMO_TRANSCRIPT} />
      </div>
    </>
  );
}
