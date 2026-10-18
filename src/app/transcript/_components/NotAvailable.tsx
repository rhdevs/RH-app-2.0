import Header from "../../_components/header";
import { NOT_AVAILABLE_NOTES } from "~/lib/transcript/pageState";
import { Crest } from "./PageHeader";
import { type ReactNode } from "react";

/**
 * Shown while no academic year is published. Calm and formal, and it promises
 * no date: nobody can say when the hall will publish.
 */
export function NotAvailable({
  academicYear,
  switcher,
  notes,
}: {
  academicYear: string;
  /** The year switcher, when the resident has other years to look at. */
  switcher?: ReactNode;
  /** Other words: transcripts are switched off altogether. */
  notes?: { headline: string; detail: string };
}) {
  return (
    <>
      <Header currentPage="profile" />
      <main className="mx-auto max-w-[210mm] px-4 pb-16 pt-28">
        {switcher}
        <div className="border border-black bg-white p-8 font-[Arial,Helvetica,sans-serif] text-black">
          <div className="flex items-center gap-3 border-b-2 border-black pb-3">
            <Crest />
            <h1 className="text-[19px] font-bold uppercase tracking-[0.06em]">
              Transcript
            </h1>
          </div>
          <p role="status" className="mt-6 text-base font-semibold">
            {notes?.headline ?? NOT_AVAILABLE_NOTES.headline(academicYear)}
          </p>
          <p className="mt-1 text-sm text-neutral-700">
            {notes?.detail ?? NOT_AVAILABLE_NOTES.detail}
          </p>
        </div>
      </main>
    </>
  );
}
