import { type ReactNode } from "react";
import Header from "../../_components/header";
import { type YearChoice } from "~/lib/transcript/pageState";
import { type TranscriptViewModel } from "~/lib/transcript/types";
import { PrintButton } from "./PrintButton";
import { TranscriptDocument } from "./TranscriptDocument";
import { YearSwitcher } from "./YearSwitcher";

/**
 * Everything around one transcript on screen: app header, an optional notice,
 * the academic-year switch, the Save-as-PDF button and the document. On paper
 * only the document prints. Shared by the real /transcript page and the
 * dev-only specimen preview, so both look and print the same.
 */
export function TranscriptFrame({
  transcript,
  years,
  basePath,
  notice,
  footerNav,
}: {
  transcript: TranscriptViewModel;
  /** The years to offer in the switch; none, no switch. */
  years: YearChoice[];
  /** The route the year links point at. */
  basePath: string;
  notice?: ReactNode;
  /** Extra navigation under the buttons (the specimen list, in development). */
  footerNav?: ReactNode;
}) {
  return (
    <>
      <div className="print:hidden">
        <Header currentPage="profile" />
      </div>

      <div className="mx-auto max-w-[210mm] px-4 pb-4 pt-24 print:hidden">
        {notice}

        <YearSwitcher
          choices={years}
          active={transcript.academicYear}
          basePath={basePath}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrintButton />
        </div>
        <p className="mt-2 text-xs text-gray-500 print:hidden">
          On a phone, use Share, then Print, then save as PDF.
        </p>
        {footerNav}
      </div>

      <div className="px-2 pb-16 sm:px-4 print:p-0">
        <TranscriptDocument transcript={transcript} />
      </div>
    </>
  );
}
