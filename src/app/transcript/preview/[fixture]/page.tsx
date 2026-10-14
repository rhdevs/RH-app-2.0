import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { getFixtureBySlug } from "~/lib/transcript/fixtures";
import { TranscriptPageShell } from "../../_components/TranscriptPageShell";

export const metadata: Metadata = {
  title: "Transcript specimen preview · RHApp",
  robots: { index: false, follow: false },
};

/**
 * DEVELOPMENT ONLY. Lets each specimen (see src/lib/transcript/fixtures.ts) be
 * viewed so every layout edge case can be checked. 404s in production.
 */
export default function TranscriptPreviewPage({
  params,
}: {
  params: { fixture: string };
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const fixture = getFixtureBySlug(params.fixture);
  if (!fixture) notFound();
  return <TranscriptPageShell fixture={fixture} />;
}
