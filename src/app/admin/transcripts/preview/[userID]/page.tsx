import { type Metadata } from "next";
import Link from "next/link";
import { TRPCError } from "@trpc/server";

import { errorText } from "~/lib/transcript/adminView";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { parseAyParam } from "~/lib/transcript/pageState";
import { api } from "~/trpc/server";
import { TranscriptDocument } from "../../../../transcript/_components/TranscriptDocument";

export const metadata: Metadata = {
  title: "Transcript preview",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Printing: the admin shell (site header and tab bar) sits beside <main> in the
 * layout above this page, so it is hidden here, by the one fact that this page
 * is inside it, rather than by editing the shell. Padding and width caps go too,
 * so the document prints exactly as the resident's own transcript does.
 */
const PRINT_CSS = `
@media print {
  div:has(> main > .rh-preview-root) > :not(main) { display: none !important; }
  div:has(> main > .rh-preview-root) { margin-bottom: 0 !important; background: none !important; }
  main:has(> .rh-preview-root) { max-width: none !important; padding: 0 !important; }
}`;

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
    <div className="rh-preview-root space-y-4">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />
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
            {result.status === "published"
              ? `Showing ${academicYear} as residents receive it.`
              : result.status === "closed"
                ? `Showing ${academicYear} as the draft residents see while it is closed for review.`
                : `Showing ${academicYear} as it stands now. Member lists that are not frozen use the current members.`}
          </p>
          <TranscriptDocument transcript={result.transcript} />
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
