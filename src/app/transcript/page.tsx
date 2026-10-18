import { type Metadata } from "next";
import { redirect } from "next/navigation";
import { TRPCError } from "@trpc/server";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { instantToSgDate } from "~/lib/transcript/sgDate";
import {
  TRANSCRIPTS_OFF_NOTES,
  downloadByBanner,
  parseAyParam,
  selectTranscriptState,
} from "~/lib/transcript/pageState";
import { auth } from "~/server/auth";
import { api } from "~/trpc/server";
import { MarkOpened } from "./_components/MarkOpened";
import { NotAvailable } from "./_components/NotAvailable";
import { OnHold } from "./_components/OnHold";
import { YearSwitcher } from "./_components/YearSwitcher";
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
 * roster plus the current activity, volunteer, award and JCRC records). Viewing
 * writes nothing; the client notes the opening with `markOpened`, to drive the
 * "Ready" badge.
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
      // The kill switch is off: transcripts are not available to anyone.
      if (
        error instanceof TRPCError &&
        error.message === "TRANSCRIPT_DISABLED"
      ) {
        return (
          <NotAvailable academicYear={now} notes={TRANSCRIPTS_OFF_NOTES} />
        );
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
    published,
    requested: parseAyParam(searchParams.ay),
    currentAcademicYear: now,
  });

  if (state.kind === "unauthenticated") redirect("/login");
  if (state.kind === "none_published") {
    return <NotAvailable academicYear={state.currentAcademicYear} />;
  }

  const switcher = (
    <YearSwitcher
      choices={state.choices}
      active={state.academicYear}
      basePath="/transcript"
    />
  );
  // The current year before it opens: the calm page, with the switcher.
  if (state.view === "unavailable") {
    return (
      <NotAvailable academicYear={state.academicYear} switcher={switcher} />
    );
  }

  // Defensive: the year could change between listing it and fetching it.
  const result = await api.transcript.mine
    .get({ academicYear: state.academicYear })
    .catch((error: unknown) => {
      if (error instanceof TRPCError && error.code === "PRECONDITION_FAILED") {
        return null;
      }
      throw error;
    });
  // The hall office has put this resident's year on hold: nothing else shows.
  if (result?.status === "on_hold") {
    return <OnHold academicYear={state.academicYear} switcher={switcher} />;
  }
  if (!result || result.status !== "ready") {
    return (
      <NotAvailable academicYear={state.academicYear} switcher={switcher} />
    );
  }

  const banner = downloadByBanner({
    academicYear: state.academicYear,
    downloadBy: result.downloadBy,
    todaySg: instantToSgDate(new Date()),
  });

  return (
    <>
      <MarkOpened academicYear={state.academicYear} />
      <TranscriptFrame
        transcript={result.transcript}
        years={state.choices}
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
    </>
  );
}
