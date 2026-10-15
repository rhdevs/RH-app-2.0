import { type Metadata } from "next";
import { TRPCError } from "@trpc/server";
import {
  assembleTranscript,
  normaliseVerificationCode,
} from "~/lib/transcript/assemble";
import { getFixtureByCode } from "~/lib/transcript/fixtures";
import { api } from "~/trpc/server";
import { getVerifyUrl } from "../../transcript/_components/siteOrigin";
import { VerifyResult, type VerifyOutcome } from "../_components/VerifyResult";

export const metadata: Metadata = {
  title: "Verify a transcript",
  // A verification result is for the person holding the code, not for search.
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * PUBLIC: exempt from MatricGate and needs no login. Reached from the QR on a
 * transcript. Everything is decided by transcript.verify (rate limited per
 * client address); this page only renders the answer.
 *
 * It reveals nothing beyond that answer: no resident list, no list of years, no
 * near matches. A code the server does not know and a code that is not even
 * shaped like one get the same neutral message.
 *
 * DEVELOPMENT ONLY: a made-up specimen code (src/lib/transcript/fixtures.ts)
 * renders its specimen so the preview's "see what a verifier sees" link works.
 * In production only real issued codes verify.
 */
export default async function VerifyCodePage({
  params,
}: {
  params: { code: string };
}) {
  const code = normaliseVerificationCode(safeDecode(params.code)).slice(0, 64);

  let outcome: VerifyOutcome;
  try {
    outcome = await api.transcript.verify({ code });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS") {
      outcome = { status: "rate_limited" };
    } else if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
      outcome = { status: "not_found" };
    } else {
      throw error;
    }
  }

  if (outcome.status === "not_found" && process.env.NODE_ENV !== "production") {
    const specimen = getFixtureByCode(code);
    if (specimen) {
      outcome = {
        status: "specimen",
        transcript: assembleTranscript(
          specimen.fixture.input,
          specimen.academicYear,
        ),
      };
    }
  }

  return <VerifyResult outcome={outcome} verifyUrl={getVerifyUrl()} />;
}

/** A stray `%` in a hand-typed link must be "no match", not a 500. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
