import { type Metadata } from "next";

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
 */
export default function TranscriptsAdminPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Transcripts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Run each academic year&rsquo;s transcripts: when they open, which CCAs
          record volunteering, and the Colours Awards.
        </p>
      </header>
      <PeriodPanel />
      <VolunteeringTags />
      <AwardsPanel />
      <PreviewPicker />
    </div>
  );
}
