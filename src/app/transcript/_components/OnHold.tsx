import Header from "../../_components/header";
import { ON_HOLD_MESSAGE } from "~/lib/transcript/corrections";
import { Crest } from "./PageHeader";
import { type ReactNode } from "react";

/**
 * Shown instead of a transcript the hall office has put on hold for this
 * resident. It says nothing about why, and shows nothing of the document.
 */
export function OnHold({
  academicYear,
  switcher,
}: {
  academicYear: string;
  /** The year switcher, so another year can still be opened. */
  switcher?: ReactNode;
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
          <p className="mt-6 text-sm text-neutral-700">{academicYear}</p>
          <p role="status" className="mt-1 text-base font-semibold">
            {ON_HOLD_MESSAGE}
          </p>
        </div>
      </main>
    </>
  );
}
