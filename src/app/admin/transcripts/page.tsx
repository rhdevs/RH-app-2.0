import { type Metadata } from "next";
import Link from "next/link";

import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { api, HydrateClient } from "~/trpc/server";
import AwardsPanel from "./_components/AwardsPanel";
import PeriodPanel from "./_components/PeriodPanel";
import PreviewPicker from "./_components/PreviewPicker";
import VolunteeringTags from "./_components/VolunteeringTags";

export const metadata: Metadata = {
  title: "Transcripts",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Transcript administration, for admin and jcrc. The gate is ./layout.tsx (a
 * live role read) and every procedure behind these panels re-checks it; this
 * page only lays the four sections out, in the order a year is run: set up and
 * publish the year, mark the volunteering CCAs, record awards, then preview.
 *
 * The three lists the panels open with are fetched here, on the server, and
 * handed to the client panels, so the page arrives filled in rather than as
 * four loading placeholders. A failed prefetch is not fatal: the panel simply
 * fetches (and reports its own error) in the browser.
 */
export default async function TranscriptsAdminPage() {
  await Promise.allSettled([
    api.transcript.periods.list.prefetch(),
    api.transcriptManage.ccaTags.list.prefetch(),
    api.transcriptManage.awards.list.prefetch({
      academicYear: currentAcademicYear(new Date()),
    }),
  ]);

  return (
    <HydrateClient>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">Transcripts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Run each academic year&rsquo;s transcripts: when they open, which
            CCAs record volunteering, and the Colours Awards.
          </p>
          <p className="mt-2 text-sm">
            <Link
              href="/admin/transcripts/jcrc"
              className="font-medium text-emerald-800 underline underline-offset-2"
            >
              Your JCRC page
            </Link>
            {" · "}
            <Link
              href="/admin/transcripts/residents"
              className="font-medium text-emerald-800 underline underline-offset-2"
            >
              Resident corrections
            </Link>
          </p>
        </header>
        <PeriodPanel />
        <VolunteeringTags />
        <AwardsPanel />
        <PreviewPicker />
      </div>
    </HydrateClient>
  );
}
