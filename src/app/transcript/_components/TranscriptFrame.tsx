import Link from "next/link";
import { type ReactNode } from "react";
import Header from "../../_components/header";
import { yearToParam } from "~/lib/transcript/assemble";
import { type TranscriptViewModel } from "~/lib/transcript/types";
import { PrintButton } from "./PrintButton";
import { TranscriptDocument } from "./TranscriptDocument";

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
  /** Years to offer in the switch; hidden when there is only one. */
  years: string[];
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

        {years.length > 1 && (
          <nav aria-label="Academic year" className="mb-3 flex flex-wrap gap-2">
            {years.map((year) => {
              const active = year === transcript.academicYear;
              return (
                <Link
                  key={year}
                  href={`${basePath}?ay=${yearToParam(year)}`}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full border px-3 py-1 text-sm font-medium ${
                    active
                      ? "border-emerald-800 bg-emerald-800 text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-emerald-700"
                  }`}
                >
                  {year}
                </Link>
              );
            })}
          </nav>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <PrintButton />
        </div>
        {footerNav}
      </div>

      <div className="px-2 pb-16 sm:px-4 print:p-0">
        <TranscriptDocument transcript={transcript} />
      </div>
    </>
  );
}
