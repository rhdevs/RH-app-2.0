import { redirect } from "next/navigation";
import { type Metadata } from "next";
import { normaliseVerificationCode } from "~/lib/transcript/assemble";
import { Crest } from "../transcript/_components/PageHeader";

export const metadata: Metadata = {
  title: "Verify a CCA Transcript · Raffles Hall",
};

/**
 * PUBLIC — exempt from MatricGate. The entry point for someone outside the
 * hall holding a paper copy: type the code, land on /verify/<code>. A plain
 * GET form, so it works without JavaScript and `form-action 'self'` holds.
 */
export default function VerifyIndexPage({
  searchParams,
}: {
  searchParams: { code?: string | string[] };
}) {
  const raw = Array.isArray(searchParams.code)
    ? searchParams.code[0]
    : searchParams.code;
  if (raw?.trim()) {
    redirect(`/verify/${encodeURIComponent(normaliseVerificationCode(raw))}`);
  }

  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center">
      <Crest />
      <h1 className="mt-4 text-2xl font-semibold text-gray-900">
        Verify a CCA Transcript
      </h1>
      <p className="mt-2 text-sm text-gray-600">
        Enter the verification code printed on the first page of a Raffles Hall
        transcript.
      </p>
      <form action="/verify" method="get" className="mt-6 flex w-full gap-2">
        <input
          name="code"
          required
          placeholder="RH-CCT-XXXX-XXXX"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 font-mono uppercase focus:border-emerald-700 focus:outline-none focus:ring-1 focus:ring-emerald-700"
        />
        <button
          type="submit"
          className="rounded-lg bg-emerald-800 px-4 py-2 font-medium text-white hover:bg-emerald-700"
        >
          Verify
        </button>
      </form>
    </div>
  );
}
