import Link from "next/link";
import { notFound } from "next/navigation";
import { assembleTranscript } from "~/lib/transcript/assemble";
import {
  TRANSCRIPT_FIXTURES,
  getFixtureYears,
  resolveFixtureYear,
  type TranscriptFixture,
} from "~/lib/transcript/fixtures";
import { choiceLabel } from "~/lib/transcript/pageState";
import { TranscriptFrame } from "./TranscriptFrame";

/**
 * SPECIMENS ONLY (the dev preview route). A fixture is made-up data, flagged
 * `isSpecimen`, so the document carries the SPECIMEN watermark; real data never
 * does. The real resident page is src/app/transcript/page.tsx.
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

  return (
    <TranscriptFrame
      transcript={assembleTranscript(fixture.input, academicYear)}
      // The specimen switch only matters with more than one year.
      years={
        getFixtureYears(fixture).length > 1
          ? getFixtureYears(fixture).map((academicYear) => ({
              academicYear,
              kind: "published" as const,
              label: choiceLabel(academicYear, "published"),
            }))
          : []
      }
      basePath={basePath}
      notice={
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Specimen (development only)</p>
          <p className="mt-1">
            This is a sample transcript with made-up names and CCAs.
          </p>
        </div>
      }
      footerNav={
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
      }
    />
  );
}
