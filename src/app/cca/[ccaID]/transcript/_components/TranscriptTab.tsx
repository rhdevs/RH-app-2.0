"use client";

import Link from "next/link";
import { useState } from "react";

import {
  ErrorLine,
  SectionCard,
  YearSelect,
} from "~/app/admin/transcripts/_components/Bits";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { errorText, normaliseStatus } from "~/lib/transcript/adminView";
import {
  DEFAULTS_NOTE,
  NO_DESCRIPTION_NOTE,
  PUBLISHED_NOTE,
  ROSTER_HELPER,
  headYearOptions,
} from "~/lib/transcript/headView";
import { api } from "~/trpc/react";
import { RosterRow, RosterTableView, type RosterRowData } from "./RosterEditor";
import VolunteerSection from "./VolunteerSection";

export interface TranscriptNotesProps {
  academicYear: string;
  published: boolean;
  /** Collecting with no semester 2 start date saved (or no period yet). */
  sem2Unset: boolean;
  /** Null while the profile is still loading or could not be read. */
  descriptionEmpty: boolean | null;
  detailsHref: string;
}

/** The calm notes above the roster. Plain text, no colour alarms. */
export function TranscriptNotes(p: TranscriptNotesProps) {
  return (
    <div className="space-y-2 text-sm">
      {p.published && (
        <p className="text-amber-800" role="status">
          {PUBLISHED_NOTE(p.academicYear)}
        </p>
      )}
      {!p.published && p.sem2Unset && (
        <p className="text-gray-600" role="status">
          {DEFAULTS_NOTE}
        </p>
      )}
      {p.descriptionEmpty === true && (
        <p className="text-gray-600">
          {NO_DESCRIPTION_NOTE}{" "}
          <Link
            href={p.detailsHref}
            className="font-medium text-emerald-700 underline underline-offset-2"
          >
            Open CCA details
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * The Transcript tab of the CCA dashboard: a member roster editor and, for a
 * volunteering CCA only, the volunteer hours section. Every call is checked on
 * the server (head of THIS CCA, or a manager); this page only draws.
 */
export default function TranscriptTab({ ccaID }: { ccaID: number }) {
  const current = currentAcademicYear(new Date());
  const years = headYearOptions(Number(current.slice(2, 6)));
  const [year, setYear] = useState(current);

  const roster = api.transcriptManage.roster.list.useQuery(
    { ccaID, academicYear: year },
    { retry: false },
  );
  const profile = api.cca.getProfile.useQuery({ ccaID }, { retry: false });

  if (roster.isPending) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }
  if (roster.error) {
    return (
      <SectionCard title="Transcript">
        <ErrorLine message={errorText(roster.error.message)} />
      </SectionCard>
    );
  }

  const data = roster.data;
  const published = normaliseStatus(data.status) === "published";
  const rows: RosterRowData[] = data.rows;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Member roster"
        description={`${ROSTER_HELPER} Changes here shape the CCA line on each member's transcript.`}
      >
        {years.length > 1 && (
          <div className="mb-4">
            <YearSelect
              id="transcript-year"
              label="Academic year"
              value={year}
              options={years}
              onChange={setYear}
            />
          </div>
        )}
        <div className="mb-4">
          <TranscriptNotes
            academicYear={year}
            published={published}
            sem2Unset={data.sem2Start === null}
            descriptionEmpty={
              profile.data ? profile.data.description.trim() === "" : null
            }
            detailsHref={`/cca/${ccaID}/details`}
          />
        </div>
        <RosterTableView
          count={rows.length}
          rows={rows.map((row) => (
            <RosterRow
              key={`${year}:${row.userID}`}
              ccaID={ccaID}
              academicYear={year}
              row={row}
              readOnly={published}
            />
          ))}
        />
      </SectionCard>

      {data.isVolunteering && (
        <VolunteerSection
          ccaID={ccaID}
          academicYear={year}
          readOnly={published}
        />
      )}
    </div>
  );
}
