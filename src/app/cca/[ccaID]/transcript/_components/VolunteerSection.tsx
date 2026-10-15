"use client";

import { Loader2 } from "lucide-react";
import { useSession } from "next-auth/react";
import { useState } from "react";

import {
  ErrorLine,
  FIELD_LABEL,
  SectionCard,
} from "~/app/admin/transcripts/_components/Bits";
import ResidentPicker, {
  DEFAULT_PLACEHOLDER,
  HEAD_PLACEHOLDER,
  type PickedResident,
} from "~/app/admin/transcripts/_components/ResidentPicker";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { errorText, fieldError } from "~/lib/transcript/adminView";
import { parseAcademicYear } from "~/lib/transcript/academicYear";
import {
  ACTIVITY_MAX,
  clearIfUnchanged,
  HOURS_MAX,
  HOURS_MIN,
  formatHours,
  hoursByResident,
  hoursProblem,
  parseHours,
} from "~/lib/transcript/headView";
import { api } from "~/trpc/react";

export interface VolunteerRecordView {
  id: string;
  userID: string;
  residentName: string;
  kind: string;
  activity: string;
  activityDate: string | null;
  hours: number;
  recordedBy: string | null;
}

export type VolunteerKind = "regular" | "oneoff";

export interface VolunteerSectionViewProps {
  academicYear: string;
  readOnly: boolean;
  picker: React.ReactNode;
  hasResident: boolean;
  kind: VolunteerKind;
  onKind: (k: VolunteerKind) => void;
  activity: string;
  onActivity: (v: string) => void;
  date: string;
  onDate: (v: string) => void;
  hours: string;
  onHours: (v: string) => void;
  onAdd: () => void;
  adding: boolean;
  addError: string | null;
  fieldErrors: { activity: string | null; date: string | null };
  records: VolunteerRecordView[];
  loading: boolean;
  listError: string | null;
  confirmVoidId: string | null;
  onConfirmVoid: (id: string | null) => void;
  onVoid: () => void;
  voiding: boolean;
  voidError: string | null;
}

const kindLabel = (kind: string) => (kind === "oneoff" ? "One-off" : "Regular");

/** Volunteer hours for a volunteering CCA: add a record, list them, void a mistake. */
export function VolunteerSectionView(p: VolunteerSectionViewProps) {
  const hoursIssue = hoursProblem(p.hours);
  const needsDate = p.kind === "oneoff";
  const canAdd =
    !p.readOnly &&
    p.hasResident &&
    p.activity.trim().length > 0 &&
    parseHours(p.hours) !== null &&
    (!needsDate || p.date !== "") &&
    !p.adding;
  const range = parseAcademicYear(p.academicYear);
  const minDate = range ? `${range.startYear}-08-01` : undefined;
  const maxDate = range ? `${range.startYear + 1}-07-31` : undefined;
  const totals = hoursByResident(
    p.records.map((r) => ({
      userID: r.userID,
      displayName: r.residentName,
      hours: r.hours,
    })),
  );

  return (
    <AlertDialog
      open={p.confirmVoidId !== null}
      onOpenChange={(o) => !o && !p.voiding && p.onConfirmVoid(null)}
    >
      <SectionCard
        title="Volunteer hours"
        description="Hours you record here appear in the Volunteer hours section of the resident's transcript. You can record hours for any resident, not only members of this CCA."
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) p.onAdd();
          }}
        >
          {p.picker}
          <fieldset className="flex gap-4 text-sm text-gray-900">
            <legend className={FIELD_LABEL}>Kind</legend>
            {(["regular", "oneoff"] as const).map((k) => (
              <label key={k} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="volunteer-kind"
                  value={k}
                  checked={p.kind === k}
                  disabled={p.readOnly}
                  onChange={() => p.onKind(k)}
                />
                {kindLabel(k)}
              </label>
            ))}
          </fieldset>
          <div className="max-w-md">
            <label htmlFor="volunteer-activity" className={FIELD_LABEL}>
              Activity
            </label>
            <Input
              id="volunteer-activity"
              value={p.activity}
              maxLength={ACTIVITY_MAX}
              disabled={p.readOnly}
              onChange={(e) => p.onActivity(e.target.value)}
              aria-invalid={p.fieldErrors.activity ? true : undefined}
            />
            <ErrorLine message={p.fieldErrors.activity} />
          </div>
          {needsDate && (
            <div>
              <label htmlFor="volunteer-date" className={FIELD_LABEL}>
                Date
              </label>
              <Input
                id="volunteer-date"
                type="date"
                value={p.date}
                min={minDate}
                max={maxDate}
                disabled={p.readOnly}
                onChange={(e) => p.onDate(e.target.value)}
                className="w-44"
                aria-invalid={p.fieldErrors.date ? true : undefined}
              />
              <p className="mt-1 text-xs text-gray-500">
                Within {p.academicYear}, 1 August to 31 July.
              </p>
              <ErrorLine message={p.fieldErrors.date} />
            </div>
          )}
          <div>
            <label htmlFor="volunteer-hours" className={FIELD_LABEL}>
              Hours
            </label>
            <Input
              id="volunteer-hours"
              type="number"
              inputMode="decimal"
              min={HOURS_MIN}
              max={HOURS_MAX}
              step={0.25}
              value={p.hours}
              disabled={p.readOnly}
              onChange={(e) => p.onHours(e.target.value)}
              className="w-32"
              aria-invalid={hoursIssue ? true : undefined}
            />
            <p className="mt-1 text-xs text-gray-500">
              {`From ${HOURS_MIN} to ${HOURS_MAX}, in steps of 0.25.`}
            </p>
            <ErrorLine message={hoursIssue} />
          </div>
          <Button type="submit" disabled={!canAdd}>
            {p.adding ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Adding
              </>
            ) : (
              "Add"
            )}
          </Button>
          <ErrorLine message={p.addError} />
        </form>

        <div className="mt-8">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">
            {`Records for ${p.academicYear}`}
          </h3>
          <ErrorLine message={p.listError} />
          {p.loading ? (
            <p className="text-sm text-gray-500">Loading records.</p>
          ) : p.records.length === 0 ? (
            <p className="text-sm text-gray-500">
              No volunteer hours recorded for this year.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
                {p.records.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
                  >
                    <div className="min-w-0 text-sm text-gray-900">
                      <p className="font-medium">{r.residentName}</p>
                      <p>
                        {kindLabel(r.kind)}. {r.activity}
                        {r.activityDate ? `, ${r.activityDate}` : ""}.{" "}
                        {formatHours(r.hours)}
                      </p>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {r.recordedBy
                          ? `Recorded by ${r.recordedBy}`
                          : "Recorder not known"}
                      </p>
                    </div>
                    {!p.readOnly && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => p.onConfirmVoid(r.id)}
                      >
                        Void
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              <h3 className="mb-2 mt-6 text-sm font-semibold text-gray-900">
                Total hours per resident
              </h3>
              <ul className="grid gap-x-8 gap-y-1 text-sm text-gray-900 sm:grid-cols-2">
                {totals.map((t) => (
                  <li key={t.userID} className="flex justify-between gap-3">
                    <span>{t.name}</span>
                    <span className="text-gray-600">
                      {formatHours(t.hours)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </SectionCard>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this record?</AlertDialogTitle>
          <AlertDialogDescription>
            The hours stop counting on the transcript. The record is kept, not
            deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={p.voidError} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.voiding}>Cancel</AlertDialogCancel>
          <Button type="button" onClick={p.onVoid} disabled={p.voiding}>
            {p.voiding ? "Voiding" : "Void record"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function VolunteerSection({
  ccaID,
  academicYear,
  readOnly,
}: {
  ccaID: number;
  academicYear: string;
  readOnly: boolean;
}) {
  const utils = api.useUtils();
  // Cosmetic only: managers can search by email or matric, heads by name. The
  // server decides what a search matches.
  const roles: readonly string[] = useSession().data?.user.roles ?? [];
  const isManager = roles.includes("admin") || roles.includes("jcrc");
  const [resident, setResident] = useState<PickedResident | null>(null);
  const [kind, setKind] = useState<VolunteerKind>("regular");
  const [activity, setActivity] = useState("");
  const [date, setDate] = useState("");
  const [hours, setHours] = useState("");
  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null);

  const list = api.transcriptManage.volunteer.list.useQuery(
    { ccaID, academicYear },
    { retry: false },
  );
  const create = api.transcriptManage.volunteer.create.useMutation({
    // Clear what was added, keep the kind, and leave alone anything typed
    // for the next entry while this one was being sent.
    onSuccess: async (_added, sent) => {
      setActivity((a) => clearIfUnchanged(a, sent.activity));
      setDate((d) => clearIfUnchanged(d, sent.activityDate ?? ""));
      setHours((h) => (parseHours(h) === sent.hours ? "" : h));
      setResident((r) => (r?.userID === sent.userID ? null : r));
      await utils.transcriptManage.volunteer.list.invalidate();
    },
  });
  const voidRecord = api.transcriptManage.volunteer.void.useMutation({
    onSuccess: async () => {
      setConfirmVoidId(null);
      await utils.transcriptManage.volunteer.list.invalidate();
    },
  });

  const zod = create.error?.data?.zodError ?? null;
  const activityError = fieldError(zod, "activity");
  const dateError = fieldError(zod, "activityDate");

  return (
    <VolunteerSectionView
      academicYear={academicYear}
      readOnly={readOnly}
      picker={
        <ResidentPicker
          idPrefix="volunteer"
          hideSelectedMatric
          placeholder={isManager ? DEFAULT_PLACEHOLDER : HEAD_PLACEHOLDER}
          selected={resident}
          onSelect={setResident}
          onClear={() => setResident(null)}
          disabled={readOnly}
        />
      }
      hasResident={resident !== null}
      kind={kind}
      onKind={(k) => {
        setKind(k);
        if (k === "regular") setDate("");
        create.reset();
      }}
      activity={activity}
      onActivity={(v) => {
        setActivity(v);
        create.reset();
      }}
      date={date}
      onDate={(v) => {
        setDate(v);
        create.reset();
      }}
      hours={hours}
      onHours={(v) => {
        setHours(v);
        create.reset();
      }}
      onAdd={() => {
        const parsed = parseHours(hours);
        if (!resident || parsed === null) return;
        create.mutate({
          ccaID,
          academicYear,
          userID: resident.userID,
          kind,
          activity,
          ...(kind === "oneoff" ? { activityDate: date } : {}),
          hours: parsed,
        });
      }}
      adding={create.isPending}
      addError={
        create.error && !activityError && !dateError
          ? errorText(create.error.message)
          : null
      }
      fieldErrors={{ activity: activityError, date: dateError }}
      records={(list.data ?? []).map((r) => ({
        id: r.id,
        userID: r.userID,
        residentName: r.displayName ?? r.userID,
        kind: r.kind ?? "regular",
        activity: r.activity ?? "",
        activityDate: r.activityDate,
        hours: r.hours ?? 0,
        recordedBy: r.recordedByName,
      }))}
      loading={list.isPending}
      listError={list.error ? errorText(list.error.message) : null}
      confirmVoidId={confirmVoidId}
      onConfirmVoid={(id) => {
        voidRecord.reset();
        setConfirmVoidId(id);
      }}
      onVoid={() => confirmVoidId && voidRecord.mutate({ id: confirmVoidId })}
      voiding={voidRecord.isPending}
      voidError={voidRecord.error ? errorText(voidRecord.error.message) : null}
    />
  );
}
