"use client";

import Link from "next/link";

import { errorText } from "~/lib/transcript/adminView";
import { api } from "~/trpc/react";
import { ErrorLine, SectionCard } from "./Bits";

export interface AwardsSummaryViewProps {
  academicYear: string;
  /** Awards that are not removed; null while loading. */
  count: number | null;
  error: string | null;
}

/** A short summary of the year's awards, with the way to the awards screens. */
export function AwardsSummaryView(p: AwardsSummaryViewProps) {
  return (
    <SectionCard
      title="Awards"
      description="Awards from the end-of-year Colours Awards. They appear in the Awards section of the resident's transcript."
    >
      <ErrorLine message={p.error} />
      <p className="text-sm text-gray-700" role="status">
        {p.count === null
          ? "Loading."
          : `${p.count} ${p.count === 1 ? "award" : "awards"} for ${p.academicYear}.`}
      </p>
      <p className="mt-3 text-sm">
        <Link
          href="/admin/transcripts/awards"
          className="font-medium text-emerald-800 underline underline-offset-2"
        >
          Manage awards
        </Link>
        <span className="text-gray-500">
          {" "}
          to assign, edit, group, remove and restore awards, keep the catalogue,
          and undo an upload.
        </span>
      </p>
    </SectionCard>
  );
}

export default function AwardsPanel() {
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const year = periods.data?.currentAcademicYear ?? "";
  const awards = api.transcriptManage.awards.list.useQuery(
    { academicYear: year },
    { enabled: year !== "", retry: false },
  );
  return (
    <AwardsSummaryView
      academicYear={year}
      count={awards.data ? awards.data.length : null}
      error={
        periods.error
          ? errorText(periods.error.message)
          : awards.error
            ? errorText(awards.error.message)
            : null
      }
    />
  );
}
