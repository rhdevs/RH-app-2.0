import { type Metadata } from "next";
import { redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import {
  parseAyParam,
  selectTranscriptState,
} from "~/lib/transcript/pageState";
import { auth } from "~/server/auth";
import { api } from "~/trpc/server";
import { NotAvailable } from "./_components/NotAvailable";
import { getVerifyUrl } from "./_components/siteOrigin";
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
 * What is shown is the SNAPSHOT stored when the transcript was issued, never a
 * recomputation, so it is exactly what /verify/<code> shows. Opening a published
 * year for the first time issues it (idempotent).
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

  let published: string[] = [];
  if (session?.user) {
    try {
      published = await api.transcript.mine.years();
    } catch (error) {
      if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
        redirect("/login");
      }
      // FORBIDDEN (no canonical identity): nothing can be issued for them.
    }
  }

  const state = selectTranscriptState({
    authenticated: Boolean(session?.user),
    published,
    requested: parseAyParam(searchParams.ay),
    currentAcademicYear: now,
  });

  if (state.kind === "unauthenticated") redirect("/login");
  if (state.kind === "none_published") {
    return <NotAvailable academicYear={state.currentAcademicYear} />;
  }

  const result = await api.transcript.mine.get({
    academicYear: state.academicYear,
  });
  if (result.status !== "ready") {
    return <NotAvailable academicYear={state.academicYear} />;
  }

  return (
    <TranscriptFrame
      transcript={result.transcript}
      years={state.published}
      basePath="/transcript"
      verifyUrl={getVerifyUrl()}
    />
  );
}
