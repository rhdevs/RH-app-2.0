import Link from "next/link";
import { notFound } from "next/navigation";
import Header from "../../_components/header";
import { assembleTranscript, yearToParam } from "~/lib/transcript/assemble";
import {
  TRANSCRIPT_FIXTURES,
  getFixtureYears,
  resolveFixtureYear,
  type TranscriptFixture,
} from "~/lib/transcript/fixtures";
import { PrintButton } from "./PrintButton";
import { TranscriptDocument } from "./TranscriptDocument";

/**
 * Everything around one transcript on screen: app header, specimen notice,
 * academic-year switch, Save-as-PDF button, and the document. On paper only the
 * document prints, on A4. One document per academic year, picked with
 * `?ay=2026-27`; no `ay` shows the latest. Shared by /transcript and the
 * dev-only /transcript/preview/[fixture].
 */
export function TranscriptPageShell({
  fixture,
  ay,
  basePath,
}: {
  fixture: TranscriptFixture;
  ay: string | undefined;
  /** The route this shell is served from, for the year links. */
  basePath: string;
}) {
  const academicYear = resolveFixtureYear(fixture, ay);
  if (!academicYear) notFound();

  const transcript = assembleTranscript(fixture.input, academicYear);
  const years = getFixtureYears(fixture);
  const isDev = process.env.NODE_ENV !== "production";

  return (
    <>
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

        {years.length > 1 && (
          <nav aria-label="Academic year" className="mb-3 flex flex-wrap gap-2">
            {years.map((year) => {
              const active = year === academicYear;
              return (
                <Link
                  key={year}
                  href={`${basePath}?ay=${yearToParam(year)}`}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full border px-3 py-1 text-sm font-medium ${
                    active
                      ? "border-emerald-800 bg-emerald-800 text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-emerald-700"
                  }`}
                >
                  {year}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrintButton />
          <Link
            href={`/verify/${transcript.issue.verificationCode}`}
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
