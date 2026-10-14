import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { getFixtureBySlug } from "~/lib/transcript/fixtures";
import { TranscriptPageShell } from "./_components/TranscriptPageShell";

export const metadata: Metadata = {
  title: "Transcript (Specimen) · RHApp",
};

const SHOWCASE_FIXTURE = "jcrc-sports-secretary";

/**
 * SHOWCASE. Renders a specimen, not the signed-in resident's record: there is
 * no stored per-year membership data to build a real one from yet. One
 * document per academic year, picked with `?ay=2026-27`; no `ay` shows the
 * latest.
 *
 * Not login-gated (MatricGate only ever redirects SIGNED-IN users), which is
 * fine while it shows nothing but a specimen. WHEN IT SHOWS A REAL RECORD it
 * must read the session server-side and render only the signed-in resident's
 * own transcript.
 */
export default function TranscriptPage({
  searchParams,
}: {
  searchParams: { ay?: string | string[] };
}) {
  const fixture = getFixtureBySlug(SHOWCASE_FIXTURE);
  if (!fixture) notFound();
  const ay = Array.isArray(searchParams.ay)
    ? searchParams.ay[0]
    : searchParams.ay;
  return (
    <TranscriptPageShell fixture={fixture} ay={ay} basePath="/transcript" />
  );
}
