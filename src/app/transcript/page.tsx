import { type Metadata } from "next";
import { redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { instantToSgDate } from "~/lib/transcript/sgDate";
import {
  downloadByBanner,
  parseAyParam,
  selectTranscriptState,
} from "~/lib/transcript/pageState";
import { auth } from "~/server/auth";
import { api } from "~/trpc/server";
import { NotAvailable } from "./_components/NotAvailable";
import { TranscriptFrame } from "./_components/TranscriptFrame";

export const metadata: Metadata = {
  title: "Transcript",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * THE SIGNED-IN RESIDENT'S OWN TRANSCRIPT. Gated the way the repo gates its
 * other server pages: `auth()` and a redirect to /login. The identity comes
 * only from the session (transcript.mine.get takes no userID), so there is no
 * way to ask for anyone else's.
 *
 * What is shown is ASSEMBLED FROM THE DATA on every view (the year's frozen
 * roster plus the current activity, volunteer, award and JCRC records). Opening
 * a published year is noted, to drive the "Ready" badge.
 *
 * `?ay=2026-27` picks a published year; anything else falls back to the latest
 * published year. While nothing is published there is a calm "not available" page.
 */
export default async function TranscriptPage({
  searchParams,
}: {
  searchParams: { ay?: string | string[] };
}) {
  const session = await auth();
  const now = currentAcademicYear(new Date());

  let viewable: Array<{ academicYear: string; draft: boolean }> = [];
  if (session?.user) {
    try {
      viewable = await api.transcript.mine.years();
    } catch (error) {
      if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
        redirect("/login");
      }
      // FORBIDDEN (no canonical identity): nothing can be issued for them.
      // Anything else (a database outage, say) must not read as "not
      // published yet", so it propagates to the error page.
      if (!(error instanceof TRPCError && error.code === "FORBIDDEN")) {
        throw error;
      }
    }
  }

  const state = selectTranscriptState({
    authenticated: Boolean(session?.user),
    published: viewable.map((y) => y.academicYear),
    requested: parseAyParam(searchParams.ay),
    currentAcademicYear: now,
  });

  if (state.kind === "unauthenticated") redirect("/login");
  if (state.kind === "none_published") {
    return <NotAvailable academicYear={state.currentAcademicYear} />;
  }

  // The year can be reopened between listing it and fetching it.
  const result = await api.transcript.mine
    .get({ academicYear: state.academicYear })
    .catch((error: unknown) => {
      if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") {
        return null;
      }
      throw error;
    });
  if (!result || result.status !== "ready") {
    return <NotAvailable academicYear={state.academicYear} />;
  }

  // A draft (the year is closed for review) carries no download-by banner.
  const banner = result.draft
    ? null
    : downloadByBanner({
        academicYear: state.academicYear,
        downloadBy: result.downloadBy,
        todaySg: instantToSgDate(new Date()),
      });

  return (
    <TranscriptFrame
      transcript={result.transcript}
      years={state.published}
      basePath="/transcript"
      notice={
        banner ? (
          <p
            role="status"
            className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
          >
            {banner}
          </p>
        ) : undefined
      }
    />
  );
}
