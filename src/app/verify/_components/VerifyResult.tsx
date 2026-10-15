import Link from "next/link";
import { VERIFY_NOTES } from "~/lib/transcript/pageState";
import type { TranscriptViewModel } from "~/lib/transcript/types";
import type { VerifyResult as ServiceResult } from "~/server/api/services/transcript/issue";
import { Crest } from "../../transcript/_components/PageHeader";
import { TranscriptDocument } from "../../transcript/_components/TranscriptDocument";

/**
 * Everything /verify/<code> can say. The server's four answers, plus two this
 * page adds: the caller was rate limited, and (development only) a code that
 * belongs to a made-up specimen.
 */
export type VerifyOutcome =
  | ServiceResult
  | { status: "rate_limited" }
  | {
      status: "specimen";
      transcript: TranscriptViewModel;
    };

const NOTE_STYLE =
  "mb-4 border border-black bg-white px-3 py-2 text-sm font-bold";

/**
 * A plain, public verification result. A valid or superseded record is shown as
 * the SAME document that was issued (from its stored snapshot, matric masked by
 * the server), so a verifier can compare it with the copy in their hand. A
 * revoked or unknown code shows a note and nothing else: no resident, no year,
 * no hint of a near match.
 */
export function VerifyResult({
  outcome,
  verifyUrl,
}: {
  outcome: VerifyOutcome;
  verifyUrl?: string;
}) {
  const record =
    outcome.status === "valid" ||
    outcome.status === "superseded" ||
    outcome.status === "specimen"
      ? outcome.transcript
      : null;

  return (
    <div className="mx-auto max-w-[210mm] px-4 py-10 font-[Arial,Helvetica,sans-serif] text-black">
      <div className="mb-5 flex items-center gap-3">
        <Crest />
        <div>
          <p className="text-xs uppercase tracking-widest text-neutral-600">
            Raffles Hall
          </p>
          <h1 className="text-xl font-bold">Transcript verification</h1>
        </div>
      </div>

      <p
        role="status"
        className={
          outcome.status === "superseded"
            ? `${NOTE_STYLE} border-2 py-3 text-base`
            : NOTE_STYLE
        }
      >
        {outcome.status === "specimen"
          ? VERIFY_NOTES.specimen
          : VERIFY_NOTES[outcome.status]}
      </p>

      {record && (
        <TranscriptDocument transcript={record} verifyUrl={verifyUrl} />
      )}

      {!record && (
        <Link href="/verify" className="text-sm font-bold underline">
          Verify another code
        </Link>
      )}
    </div>
  );
}
