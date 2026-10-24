import { type Metadata } from "next";
import Link from "next/link";

import AwardsAdmin from "./_components/AwardsAdmin";

export const metadata: Metadata = {
  title: "Awards · Transcripts",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Colours Awards, for admin and jcrc. The gate is ../layout.tsx (a live role
 * read) and every procedure behind these tabs re-checks it.
 */
export default function AwardsAdminPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Awards</h1>
        <p className="mt-1 text-sm text-gray-500">
          Assign Colours Awards to residents, keep the catalogue of awards, and
          undo an upload.
        </p>
        <p className="mt-2 text-sm">
          <Link
            href="/admin/transcripts"
            className="font-medium text-emerald-800 underline underline-offset-2"
          >
            Back to Transcripts
          </Link>
        </p>
      </header>
      <AwardsAdmin />
    </div>
  );
}
