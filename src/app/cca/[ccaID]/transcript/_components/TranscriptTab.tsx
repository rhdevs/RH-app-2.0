"use client";

import Link from "next/link";
import { useState } from "react";

import {
  ErrorLine,
  SectionCard,
  YearSelect,
} from "~/app/admin/transcripts/_components/Bits";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { errorText } from "~/lib/transcript/adminView";
import {
  DEFAULTS_NOTE,
  LOCK_CONFIRMATION,
  NO_DESCRIPTION_NOTE,
  ROSTER_HELPER,
  lockButtonLabel,
  rosterNotice,
} from "~/lib/transcript/headView";
import {
  academicYearsUpTo,
  nextAcademicYear,
} from "~/lib/transcript/lifecycle";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import ActivitiesSection from "./ActivitiesSection";
import { RosterRow, RosterTableView, type RosterRowData } from "./RosterEditor";
import VolunteerSection from "./VolunteerSection";

export interface TranscriptNotesProps {
  /** Why the roster is read-only or empty, or null. */
  stateNote: string | null;
  /** Default durations assume the full year: no semester 2 start date saved. */
  showDefaultsNote: boolean;
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
      {p.showDefaultsNote && (
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

/** "Lock member list for AY2026/27", with the confirmation the head must accept. */
export function LockRoster({
  academicYear,
  ccaID,
  onLocked,
}: {
  academicYear: string;
  ccaID: number;
  onLocked: () => void;
}) {
  const lock = api.transcriptManage.roster.lock.useMutation({
    onSuccess: () => onLocked(),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {lockButtonLabel(academicYear)}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{lockButtonLabel(academicYear)}?</AlertDialogTitle>
          <AlertDialogDescription>
            {LOCK_CONFIRMATION(academicYear)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine
          message={lock.error ? errorText(lock.error.message) : null}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={lock.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            disabled={lock.isPending}
            onClick={() => lock.mutate({ ccaID })}
          >
            {lock.isPending ? "Locking" : "Lock member list"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The Transcript tab of the CCA dashboard: a member roster editor and, for a
 * volunteering CCA only, the volunteer hours section. Every call is checked on
 * the server (head of THIS CCA, or a manager); this page only draws. The year
 * defaults to the one this CCA is working on (its oldest unfrozen year).
 */
export default function TranscriptTab({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const term = api.transcriptManage.roster.term.useQuery(
    { ccaID },
    { retry: false },
  );
  const [picked, setPicked] = useState<string | null>(null);
  const year = picked ?? term.data?.termAcademicYear ?? "";
  const years = [
    ...academicYearsUpTo(nextAcademicYear(currentAcademicYear(new Date()))),
  ].reverse();

  const roster = api.transcriptManage.roster.list.useQuery(
    { ccaID, academicYear: year },
    { enabled: year !== "", retry: false },
  );
  const profile = api.cca.getProfile.useQuery({ ccaID }, { retry: false });

  if (term.error || roster.error) {
    return (
      <SectionCard title="Transcript">
        <ErrorLine message={errorText((term.error ?? roster.error)?.message)} />
      </SectionCard>
    );
  }
  if (term.isPending || roster.isPending || !roster.data) {
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
  const stateNote = rosterNotice({
    academicYear: year,
    mode: data.mode,
    refusal: data.editRefusal,
    freezeReason: data.freeze?.reason ?? null,
    frozenOn: data.freeze ? formatSgDate(data.freeze.frozenAt) : null,
  });
  const canLock =
    data.mode === "live" && !readOnly && year === data.termAcademicYear;

  return (
    <div className="space-y-6">
      <ActivitiesSection
        ccaID={ccaID}
        academicYear={year}
        members={rows.map((r) => ({
          userID: r.userID,
          displayName: r.displayName,
        }))}
        readOnly={readOnly}
        readOnlyNote={readOnly ? stateNote : null}
      />

      <SectionCard
        title="Member roster"
        description={`${ROSTER_HELPER} Changes here shape the CCA line on each member's transcript.`}
      >
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <YearSelect
            id="transcript-year"
            label="Academic year"
            value={year}
            options={years}
            onChange={setPicked}
          />
          {canLock && (
            <LockRoster
              academicYear={year}
              ccaID={ccaID}
              onLocked={() => {
                void utils.transcriptManage.roster.list.invalidate();
                void utils.transcriptManage.roster.term.invalidate();
              }}
            />
          )}
        </div>
        <div className="mb-4">
          <TranscriptNotes
            stateNote={stateNote}
            showDefaultsNote={
              data.status !== "published" && data.sem2Start === null
            }
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
              readOnly={readOnly}
            />
          ))}
        />
      </SectionCard>

      {data.isVolunteering && (
        <VolunteerSection
          ccaID={ccaID}
          academicYear={year}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}
