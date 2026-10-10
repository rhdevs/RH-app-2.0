import Image from "next/image";
import Link from "next/link";
import { type Metadata } from "next";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import {
  formatIssuedOn,
  getTranscriptByCode,
  groupByYear,
  normaliseVerificationCode,
} from "~/lib/transcript/demoData";

export const metadata: Metadata = {
  title: "Transcript Verification · Raffles Hall",
  // A verification result is for the person holding the code, not for search.
  robots: { index: false, follow: false },
};

/**
 * PUBLIC — exempt from MatricGate, reached from the QR on a transcript.
 *
 * SHOWS THE RECORD, NOT JUST "VALID". A bare tick would only prove the code
 * exists; a verifier has to compare the CCAs and positions against the copy in
 * their hand, or an edited printout with a genuine code would pass.
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
  const transcript = getTranscriptByCode(code);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="mb-6 flex items-center gap-3">
        <Image
          src="/raffles-hall-logo.svg"
          alt="Raffles Hall crest"
          width={48}
          height={48}
        />
        <div>
          <p className="text-xs uppercase tracking-widest text-gray-500">
            Raffles Hall
          </p>
          <h1 className="text-xl font-semibold text-gray-900">
            CCA Transcript Verification
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
        <div className="rounded-xl bg-white shadow">
          {transcript.isSpecimen ? (
            <div className="flex items-start gap-3 rounded-t-xl border-b border-amber-200 bg-amber-50 p-5">
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
            <div className="flex items-start gap-3 rounded-t-xl border-b border-emerald-200 bg-emerald-50 p-5">
              <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-700" />
              <div>
                <h2 className="font-semibold text-emerald-900">
                  Issued by Raffles Hall
                </h2>
                <p className="mt-1 text-sm text-emerald-900">
                  Compare the details below with the copy you were given. Any
                  difference means that copy has been altered.
                </p>
              </div>
            </div>
          )}

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 border-b border-gray-100 p-5 text-sm sm:grid-cols-2">
            <Field label="Resident" value={transcript.resident.name} />
            <Field label="Matriculation no." value={transcript.resident.matric} />
            <Field label="Period of residence" value={transcript.residencyPeriod} />
            <Field label="Date of issue" value={formatIssuedOn(transcript.issuedOn)} />
            <Field label="Verification code" value={transcript.verificationCode} />
            <Field
              label="Endorsed by"
              value={`${transcript.jcrcPresident.name} (JCRC President), ${transcript.master.name} (Master)`}
            />
          </dl>

          <div className="space-y-5 p-5">
            {groupByYear(transcript.entries).map(({ academicYear, entries }) => (
              <div key={academicYear}>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-emerald-900">
                  {academicYear}
                </h3>
                <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {entries.map((e) => (
                    <li
                      key={`${e.academicYear}-${e.ccaName}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
                    >
                      <span>
                        <span className="font-medium text-gray-900">
                          {e.ccaName}
                        </span>
                        <span className="text-gray-600"> · {e.position}</span>
                      </span>
                      <span className="text-xs text-gray-500">
                        {e.commitment.level} · ~{e.commitment.hoursPerWeek} h/wk ·
                        certified by {e.certifiedBy.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-gray-500">{label}</dt>
      <dd className="font-medium text-gray-900">{value}</dd>
    </div>
  );
}
