import Link from "next/link";
import { type Metadata } from "next";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  assembleTranscript,
  normaliseVerificationCode,
} from "~/lib/transcript/assemble";
import { getFixtureByCode } from "~/lib/transcript/fixtures";
import { Crest } from "../../transcript/_components/PageHeader";
import { TranscriptDocument } from "../../transcript/_components/TranscriptDocument";

export const metadata: Metadata = {
  title: "Transcript Verification · Raffles Hall",
  // A verification result is for the person holding the code, not for search.
  robots: { index: false, follow: false },
};

/**
 * PUBLIC — exempt from MatricGate, reached from the QR on a transcript. Each
 * academic year's transcript has its own code, so a code resolves to one
 * resident and one year.
 *
 * SHOWS THE RECORD, NOT JUST "VALID". A bare tick would only prove the code
 * exists; a verifier has to compare the CCAs and roles against the copy in
 * their hand, or an edited printout with a genuine code would pass. So the
 * page renders the same document, from the same view model, as the one that
 * was issued.
 *
 * A SPECIMEN NEVER RENDERS AS A PLAIN "VERIFIED". Outsiders are the audience
 * here, and a green tick on a real domain for an invented person is exactly the
 * misleading result this page exists to prevent.
 */
export default function VerifyCodePage({
  params,
}: {
  params: { code: string };
}) {
  const code = normaliseVerificationCode(safeDecode(params.code));
  const found = getFixtureByCode(code);
  const transcript = found
    ? assembleTranscript(found.fixture.input, found.academicYear)
    : null;

  return (
    <div className="mx-auto max-w-[210mm] px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <Crest />
        <div>
          <p className="text-xs uppercase tracking-widest text-gray-500">
            Raffles Hall
          </p>
          <h1 className="text-xl font-semibold text-gray-900">
            Transcript Verification
          </h1>
        </div>
      </div>

      {!transcript ? (
        <div className="rounded-xl border border-red-200 bg-white p-6 shadow">
          <div className="flex items-start gap-3">
            <XCircle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                No transcript matches this code
              </h2>
              <p className="mt-1 text-sm text-gray-600">
                <span className="break-all font-mono">{code}</span> was not
                issued by Raffles Hall. Check the code for typing mistakes. If
                it is correct, treat the transcript as unverified.
              </p>
              <Link
                href="/verify"
                className="mt-4 inline-block text-sm font-medium text-emerald-800 underline"
              >
                Try another code
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <>
          {transcript.resident.isSpecimen ? (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-5">
              <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
              <div>
                <h2 className="font-semibold text-amber-900">
                  Specimen record. This is a demonstration.
                </h2>
                <p className="mt-1 text-sm text-amber-900">
                  This code belongs to a sample transcript with made-up details.
                  It shows how verification will work. It does not confirm
                  anyone&rsquo;s real CCA participation.
                </p>
              </div>
            </div>
          ) : (
            <div className="mb-4 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-700" />
              <div>
                <h2 className="font-semibold text-emerald-900">
                  Issued by Raffles Hall
                </h2>
                <p className="mt-1 text-sm text-emerald-900">
                  Compare the record below with the copy you were given. Any
                  difference means that copy has been altered.
                </p>
              </div>
            </div>
          )}

          <TranscriptDocument transcript={transcript} />
        </>
      )}
    </div>
  );
}

/** A stray `%` in a hand-typed link must be "no match", not a 500. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
