"use client";

import { useCallback, useState } from "react";

import { errorText, yearOptions } from "~/lib/transcript/adminView";
import { NO_RESIDENT_NOTE } from "~/lib/transcript/residentView";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import { ErrorLine, SectionCard, YearSelect } from "../../_components/Bits";
import ResidentPicker, {
  type PickedResident,
} from "../../_components/ResidentPicker";
import ResidentPanel from "./ResidentPanel";

/**
 * /admin/transcripts/residents: pick a year and a resident, then see and
 * correct that resident's year. The year, the resident and the section can only
 * change after unsaved typing is confirmed away (and a reload asks too).
 */
export default function ResidentsAdmin() {
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [resident, setResident] = useState<PickedResident | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const isDirty = Object.values(dirty).some(Boolean);
  const confirmLeave = useUnsavedChangesGuard(isDirty);

  const mark = useCallback(
    (name: string, value: boolean) =>
      setDirty((d) => (!!d[name] === value ? d : { ...d, [name]: value })),
    [],
  );
  const leave = useCallback(() => {
    if (!confirmLeave()) return false;
    setDirty({});
    return true;
  }, [confirmLeave]);

  if (periods.isPending) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }
  if (periods.error) {
    return (
      <SectionCard title="Resident corrections">
        <ErrorLine message={errorText(periods.error.message)} />
      </SectionCard>
    );
  }

  const current = periods.data.currentAcademicYear;
  const year = picked ?? current;

  return (
    <div className="space-y-6">
      <SectionCard
        title="Find a resident"
        description="Correct one resident's records, hold back their transcript, or add a CCA the membership data misses."
      >
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <YearSelect
            id="residents-year"
            label="Academic year"
            value={year}
            options={yearOptions(periods.data.periods, current)}
            onChange={(y) => {
              if (y !== year && leave()) setPicked(y);
            }}
          />
          <div className="min-w-[16rem] flex-1">
            <ResidentPicker
              idPrefix="resident-panel"
              selected={resident}
              onSelect={(r) => {
                if (r.userID === resident?.userID || leave()) setResident(r);
              }}
              onClear={() => {
                if (leave()) setResident(null);
              }}
              hideSelectedMatric
            />
          </div>
        </div>
      </SectionCard>

      {resident ? (
        <SectionCard title="Resident">
          <ResidentPanel
            key={`${resident.userID}:${year}`}
            userID={resident.userID}
            academicYear={year}
            onDirty={mark}
            leave={leave}
          />
        </SectionCard>
      ) : (
        <p className="text-sm text-gray-500">{NO_RESIDENT_NOTE}</p>
      )}
    </div>
  );
}
