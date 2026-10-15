import { type Metadata } from "next";
import Link from "next/link";
import { TRPCError } from "@trpc/server";

import { errorText } from "~/lib/transcript/adminView";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { parseAyParam } from "~/lib/transcript/pageState";
import { api } from "~/trpc/server";
import { TranscriptDocument } from "../../../../transcript/_components/TranscriptDocument";
import { getVerifyUrl } from "../../../../transcript/_components/siteOrigin";

export const metadata: Metadata = {
  title: "Transcript preview",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * A manager's preview of one resident's transcript, assembled from LIVE data
 * (or the frozen roster once the year is published) with the Template C
 * document. transcript.preview never creates an issue, so previewing leaves no
 * trace and gives the resident nothing. The segment layout above admits admin
 * and jcrc only, and the procedure checks the live role again.
 */
export default async function TranscriptPreviewPage({
  params,
  searchParams,
}: {
  params: { userID: string };
  searchParams: { ay?: string | string[] };
}) {
  const userID = safeDecode(params.userID);
  const academicYear =
    parseAyParam(searchParams.ay) ?? currentAcademicYear(new Date());

  let result: Awaited<ReturnType<typeof api.transcript.preview>> | null = null;
  let problem: string | null = null;
  try {
    result = await api.transcript.preview({ userID, academicYear });
  } catch (error) {
    if (error instanceof TRPCError) {
      problem = errorText(error.message);
    } else {
      throw error;
    }
  }

  return (
    <div className="space-y-4">
      {/* On screen only: the document is what prints. */}
      <div
        role="status"
        className="flex flex-wrap items-center justify-between gap-3 border border-black bg-white px-4 py-3 text-sm font-bold text-black print:hidden"
      >
        <span>Preview. Not issued. Residents cannot see this.</span>
        <Link
          href="/admin/transcripts"
          className="text-sm font-medium text-emerald-800 underline underline-offset-2"
        >
          Back to transcripts
        </Link>
      </div>

      {result ? (
        <>
          <p className="text-xs text-gray-500 print:hidden">
            {result.mode === "frozen"
              ? `Showing the frozen member list for ${academicYear}, as residents will receive it.`
              : `Showing the current member list for ${academicYear}. It is not frozen until the year is published.`}
          </p>
          <TranscriptDocument
            transcript={result.transcript}
            verifyUrl={getVerifyUrl()}
          />
        </>
      ) : (
        <p className="text-sm text-red-700" role="alert">
          {problem ?? "The preview could not be loaded."}
        </p>
      )}
    </div>
  );
}

/** A stray `%` in a hand-typed address must not be a 500. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
