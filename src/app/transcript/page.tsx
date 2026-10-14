import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { getFixtureBySlug } from "~/lib/transcript/fixtures";
import { TranscriptPageShell } from "./_components/TranscriptPageShell";

export const metadata: Metadata = {
  title: "Transcript (Specimen) · RHApp",
};

const SHOWCASE_FIXTURE = "volunteering";

/**
 * SHOWCASE. Renders a specimen, not the signed-in resident's record: there is
 * no stored per-year membership data to build a real one from yet. Not
 * login-gated (MatricGate only ever redirects SIGNED-IN users), which is fine
 * while it shows nothing but a specimen. WHEN IT SHOWS A REAL RECORD it must
 * read the session server-side and render only the signed-in resident's own
 * transcript.
 */
export default function TranscriptPage() {
  const fixture = getFixtureBySlug(SHOWCASE_FIXTURE);
  if (!fixture) notFound();
  return <TranscriptPageShell fixture={fixture} />;
}
