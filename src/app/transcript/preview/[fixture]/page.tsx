import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { getFixtureBySlug } from "~/lib/transcript/fixtures";
import { TranscriptPageShell } from "../../_components/TranscriptPageShell";

export const metadata: Metadata = {
  title: "Transcript specimen preview · RHApp",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * DEVELOPMENT ONLY. Lets each specimen (see src/lib/transcript/fixtures.ts) be
 * viewed so every layout edge case can be checked. 404s in production.
 */
export default function TranscriptPreviewPage({
  params,
  searchParams,
}: {
  params: { fixture: string };
  searchParams: { ay?: string | string[] };
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const fixture = getFixtureBySlug(params.fixture);
  if (!fixture) notFound();
  const ay = Array.isArray(searchParams.ay)
    ? searchParams.ay[0]
    : searchParams.ay;
  return (
    <TranscriptPageShell
      fixture={fixture}
      ay={ay}
      basePath={`/transcript/preview/${fixture.slug}`}
    />
  );
}
