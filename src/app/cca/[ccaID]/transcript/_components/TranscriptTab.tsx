"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import {
  ErrorLine,
  SectionCard,
  YearSelect,
} from "~/app/admin/transcripts/_components/Bits";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { errorText } from "~/lib/transcript/adminView";
import {
  NO_DESCRIPTION_NOTE,
  REFRESH_FAILED_NOTE,
  ROSTER_HELPER,
  rosterNotice,
} from "~/lib/transcript/headView";
import {
  academicYearsUpTo,
  nextAcademicYear,
} from "~/lib/transcript/lifecycle";
import {
  totalUnsaved,
  useUnsavedChangesGuard,
} from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import ActivitiesSection from "./ActivitiesSection";
import { RosterEditor, type RosterRowData } from "./RosterEditor";
import VolunteerSection from "./VolunteerSection";

export interface TranscriptNotesProps {
  /** Why the roster is read-only or empty, or null. */
  stateNote: string | null;
  /** Null while the profile is still loading or could not be read. */
  descriptionEmpty: boolean | null;
  detailsHref: string;
}

/** The calm notes above the roster. Plain text, no colour alarms. */
export function TranscriptNotes(p: TranscriptNotesProps) {
  return (
    <div className="space-y-2 text-sm">
      {p.stateNote && (
        <p className="text-amber-800" role="status">
          {p.stateNote}
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

/** The deadline line on the tab: heads finish the year before it opens. */
export const OPEN_DEADLINE_NOTE =
  "Finish this year's records before the JCRC opens transcripts at the end of the year.";

/**
 * The Transcript tab of the CCA dashboard: a member roster editor and, for a
 * volunteering CCA only, the volunteer hours section. Every call is checked on
 * the server (head of THIS CCA, or a manager); this page only draws. The year
 * defaults to the current academic year; other years are read-only for heads.
 */
export default function TranscriptTab({ ccaID }: { ccaID: number }) {
  const [picked, setPicked] = useState<string | null>(null);
  // Unsaved work anywhere on the tab (roster rows, attendance ticks, an open
  // editor): warned about on reload, and before the year changes.
  const [unsaved, setUnsaved] = useState<Record<string, number>>({});
  const reportUnsaved = useCallback(
    (part: string) => (count: number) =>
      setUnsaved((u) => (u[part] === count ? u : { ...u, [part]: count })),
    [],
  );
  const onRosterUnsaved = useMemo(
    () => reportUnsaved("roster"),
    [reportUnsaved],
  );
  const onActivitiesUnsaved = useMemo(
    () => reportUnsaved("activities"),
    [reportUnsaved],
  );
  const onVolunteerUnsaved = useMemo(
    () => reportUnsaved("volunteer"),
    [reportUnsaved],
  );
  const confirmLeave = useUnsavedChangesGuard(totalUnsaved(unsaved) > 0);
  // The current academic year by default: the one heads can edit. Other
  // years can be picked and are read-only for heads.
  const year = picked ?? currentAcademicYear(new Date());
  const years = [
    ...academicYearsUpTo(nextAcademicYear(currentAcademicYear(new Date()))),
  ].reverse();

  const roster = api.transcriptManage.roster.list.useQuery(
    { ccaID, academicYear: year },
    { enabled: year !== "", retry: false },
  );
  const profile = api.cca.getProfile.useQuery({ ccaID }, { retry: false });

  // The blocking error is only for when there is no data to show: a failed
  // refresh behind data already on screen must not throw unsaved edits away.
  if (roster.error && !roster.data) {
    return (
      <SectionCard title="Transcript">
        <ErrorLine message={errorText(roster.error.message)} />
      </SectionCard>
    );
  }
  if (roster.isPending || !roster.data) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }

  const data = roster.data;
  const readOnly = data.editRefusal !== null;
  const rows: RosterRowData[] = data.rows;
  const members = rows.map((r) => ({
    userID: r.userID,
    displayName: r.displayName,
  }));
  const stateNote = rosterNotice({
    academicYear: year,
    mode: data.mode,
    refusal: data.editRefusal,
  });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Transcript year"
        description="Activities and the member roster below are for this academic year."
      >
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <YearSelect
            id="transcript-year"
            label="Academic year"
            value={year}
            options={years}
            onChange={(next) => {
              if (next !== year && confirmLeave()) setPicked(next);
            }}
          />
        </div>
        <p className="mb-2 text-sm text-gray-700">{OPEN_DEADLINE_NOTE}</p>
        {roster.error && (
          <p className="mb-2 text-sm text-amber-800" role="status">
            {REFRESH_FAILED_NOTE}
          </p>
        )}
        <TranscriptNotes
          stateNote={stateNote}
          descriptionEmpty={
            profile.data ? profile.data.description.trim() === "" : null
          }
          detailsHref={`/cca/${ccaID}/details`}
        />
      </SectionCard>

      <ActivitiesSection
        ccaID={ccaID}
        academicYear={year}
        members={members}
        readOnly={readOnly}
        readOnlyNote={readOnly ? stateNote : null}
        onUnsavedChange={onActivitiesUnsaved}
      />

      <SectionCard
        title="Member roster"
        description={`${ROSTER_HELPER} Changes here shape the CCA line on each member's transcript.`}
      >
        <RosterEditor
          key={year}
          ccaID={ccaID}
          academicYear={year}
          rows={rows}
          readOnly={readOnly}
          onUnsavedChange={onRosterUnsaved}
        />
      </SectionCard>

      {data.isVolunteering && (
        <VolunteerSection
          ccaID={ccaID}
          academicYear={year}
          members={members}
          readOnly={readOnly}
          readOnlyNote={readOnly ? stateNote : null}
          onUnsavedChange={onVolunteerUnsaved}
        />
      )}
    </div>
  );
}
