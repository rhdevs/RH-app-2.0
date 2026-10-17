import { type Metadata } from "next";
import Link from "next/link";

import { api, HydrateClient } from "~/trpc/server";
import ResidentsAdmin from "./_components/ResidentsAdmin";

export const metadata: Metadata = {
  title: "Resident corrections",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * One resident's transcript data, for admin and jcrc: correct it (after an
 * unlock, once the year is published), add a CCA the membership data misses,
 * hold the transcript back, and see what was done. The gate is ../layout.tsx
 * (a live role read) and every procedure behind these screens re-checks it.
 */
export default async function ResidentCorrectionsPage() {
  await Promise.allSettled([api.transcript.periods.list.prefetch()]);

  return (
    <HydrateClient>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">
            Resident corrections
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            A published year is read-only. To fix one resident&rsquo;s records,
            unlock that resident, correct them, then relock. Every change is
            logged.
          </p>
          <p className="mt-2 text-sm">
            <Link
              href="/admin/transcripts"
              className="font-medium text-emerald-800 underline underline-offset-2"
            >
              Back to transcripts
            </Link>
          </p>
        </header>
        <ResidentsAdmin />
      </div>
    </HydrateClient>
  );
}
