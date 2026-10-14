import Link from "next/link";
import Header from "../../_components/header";
import { assembleTranscript } from "~/lib/transcript/assemble";
import {
  TRANSCRIPT_FIXTURES,
  type TranscriptFixture,
} from "~/lib/transcript/fixtures";
import { PrintButton } from "./PrintButton";
import { TranscriptDocument } from "./TranscriptDocument";

/**
 * Everything around one transcript on screen: app header, specimen notice,
 * Save-as-PDF button, and the document. On paper only the document prints, on
 * A4. Shared by /transcript and the dev-only /transcript/preview/[fixture].
 */
export function TranscriptPageShell({
  fixture,
}: {
  fixture: TranscriptFixture;
}) {
  const transcript = assembleTranscript(fixture.input, fixture.academicYear);
  const isDev = process.env.NODE_ENV !== "production";

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
            This is a sample transcript with made-up names and CCAs. Your own
            transcript will appear here once CCA records are kept by academic
            year.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrintButton />
          <Link
            href={`/verify/${fixture.input.resident.verificationCode}`}
            className="text-sm font-medium text-emerald-800 underline hover:text-emerald-600"
          >
            See what a verifier sees →
          </Link>
        </div>
        {isDev && (
          <nav
            aria-label="Specimen transcripts (development only)"
            className="mt-4 flex flex-wrap gap-2 text-xs"
          >
            {TRANSCRIPT_FIXTURES.map((f) => (
              <Link
                key={f.slug}
                href={`/transcript/preview/${f.slug}`}
                className={`rounded border px-2 py-1 ${
                  f.slug === fixture.slug
                    ? "border-emerald-800 bg-emerald-800 text-white"
                    : "border-stone-300 text-stone-700 hover:bg-stone-100"
                }`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
        )}
      </div>

      <div className="px-2 pb-16 sm:px-4 print:p-0">
        <TranscriptDocument transcript={transcript} />
      </div>
    </>
  );
}
