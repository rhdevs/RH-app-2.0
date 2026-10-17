"use client";

import { Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

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
import {
  OPEN_CONFIRMATION,
  OPEN_LABEL,
  OPEN_REMINDER,
  PREVIOUS_YEAR_WARNING,
  errorText,
  normaliseStatus,
  openSummary,
  statusLabel,
  yearOptions,
} from "~/lib/transcript/adminView";
import {
  isLater,
  previousYearNotOpen,
  showOpenReminder,
} from "~/lib/transcript/lifecycle";
import { formatSgDate, instantToSgDate } from "~/lib/transcript/sgDate";
import { useUnsavedChangesGuard } from "~/lib/transcript/useUnsavedChangesGuard";
import { api } from "~/trpc/react";
import {
  ErrorLine,
  FIELD_LABEL,
  SectionCard,
  StatusBadge,
  YearSelect,
} from "./Bits";
import FreezeTable from "./FreezeTable";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface PeriodPanelViewProps {
  years: string[];
  selected: string;
  onSelect: (year: string) => void;
  /** The stored status of the selected year; null when it has no period yet. */
  status: string | null;
  /** The selected year can be opened: still collecting and not a future year. */
  canOpen: boolean;
  /** "Opened on 15 Apr 2027 by ..." or null. */
  publishedLine: string | null;
  sem2Value: string;
  onSem2Change: (value: string) => void;
  /** True when the field differs from what is saved. */
  sem2Dirty: boolean;
  onSaveSem2: () => void;
  saving: boolean;
  saveError: string | null;
  /** The Open transcripts confirmation is showing. */
  confirming: boolean;
  onConfirming: (open: boolean) => void;
  /** Run Open transcripts. */
  onConfirm: () => void;
  /** Open transcripts is in flight. */
  acting: boolean;
  actionError: string | null;
  /** The last result, in words, shown in place after Open transcripts ran. */
  resultLine: string | null;
  /** The download-by date (a Singapore calendar date), "" when none. */
  downloadByValue: string;
  onDownloadByChange: (value: string) => void;
  downloadByDirty: boolean;
  onSaveDownloadBy: () => void;
  savingDownloadBy: boolean;
  downloadByError: string | null;
  /** The reminders at the top of the panel (1 April, 1 August), if any. */
  reminders?: { openReminder: string | null; previousYear: string | null };
  /** The member-list results for the selected year (shown once it is open). */
  freezeTable?: ReactNode;
}

/**
 * Section a: choose an academic year, set its dates, and open its
 * transcripts. ONE step per year: while it is collecting there is a single
 * "Open transcripts" button, which goes through a dialog that says in plain
 * words what will happen; once open, the button is gone. The server's own
 * refusal is shown inline.
 */
export function PeriodPanelView(p: PeriodPanelViewProps) {
  const returnFocus = useReturnFocus();
  const published = normaliseStatus(p.status) === "published";

  return (
    <AlertDialog
      open={p.confirming}
      onOpenChange={(o) => !o && !p.acting && p.onConfirming(false)}
    >
      <SectionCard
        title="Academic year"
        description="Heads and the JCRC fill in records while a year is collecting. At the end of the year (around April, before 1 August) open its transcripts: every CCA's member list is saved as it is, and residents can see and download their transcripts."
      >
        {p.reminders?.previousYear && (
          <p
            role="alert"
            className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm font-medium text-red-900"
          >
            {p.reminders.previousYear}
          </p>
        )}
        {p.reminders?.openReminder && (
          <p
            role="status"
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            {p.reminders.openReminder}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-6">
          <YearSelect
            id="transcripts-year"
            label="Academic year"
            value={p.selected}
            options={p.years}
            onChange={p.onSelect}
          />
          <div aria-live="polite">
            <p className={FIELD_LABEL}>Status</p>
            <StatusBadge label={statusLabel(p.status)} published={published} />
          </div>
        </div>

        {p.publishedLine && (
          <p className="mt-3 text-xs text-gray-500">{p.publishedLine}</p>
        )}

        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSaveSem2();
          }}
        >
          <div>
            <label htmlFor="transcripts-sem2" className={FIELD_LABEL}>
              Semester 2 start date
            </label>
            <Input
              id="transcripts-sem2"
              type="date"
              value={p.sem2Value}
              disabled={published || p.saving}
              onChange={(e) => p.onSem2Change(e.target.value)}
              className="w-44"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={published || p.saving || !p.sem2Dirty}
          >
            {p.saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
        </form>
        <p className="mt-2 max-w-2xl text-xs text-gray-500">
          Semester 2 starts at midnight Singapore time on this date. A member
          accepted on or after it defaults to semester 2.
        </p>
        <ErrorLine message={p.saveError} />

        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            p.onSaveDownloadBy();
          }}
        >
          <div>
            <label htmlFor="transcripts-download-by" className={FIELD_LABEL}>
              Download by
            </label>
            <Input
              id="transcripts-download-by"
              type="date"
              value={p.downloadByValue}
              disabled={p.savingDownloadBy}
              onChange={(e) => p.onDownloadByChange(e.target.value)}
              className="w-44"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={p.savingDownloadBy || !p.downloadByDirty}
          >
            {p.savingDownloadBy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
        </form>
        <p className="mt-2 max-w-2xl text-xs text-gray-500">
          Residents see a banner asking them to download before this date, until
          the end of the day in Singapore. Nothing is switched off after it. It
          can be changed after transcripts are open.
        </p>
        <ErrorLine message={p.downloadByError} />

        {p.canOpen && (
          <div className="mt-6 flex flex-wrap gap-3 border-t border-gray-100 pt-5">
            <Button
              type="button"
              onClick={() => p.onConfirming(true)}
              disabled={p.acting}
              className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
            >
              {OPEN_LABEL}
            </Button>
          </div>
        )}
        {p.resultLine && !p.confirming && (
          <p className="mt-3 text-sm text-gray-700" role="status">
            {p.resultLine}
          </p>
        )}
        {!p.confirming && <ErrorLine message={p.actionError} />}

        {published && p.freezeTable}
      </SectionCard>

      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{OPEN_LABEL}</AlertDialogTitle>
          <AlertDialogDescription>
            {OPEN_CONFIRMATION(p.selected)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={p.confirming ? p.actionError : null} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.acting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            onClick={p.onConfirm}
            disabled={p.acting}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {p.acting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Opening
              </>
            ) : (
              OPEN_LABEL
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The reminders at the top of the panel, for today: from 1 April, the current
 * year still to open; from 1 August, a previous year that was never opened.
 */
export function panelReminders(
  periods: ReadonlyArray<{ academicYear: string; status: string | null }>,
  currentAcademicYear: string,
  now: Date,
): { openReminder: string | null; previousYear: string | null } {
  const statusOf = (y: string) =>
    normaliseStatus(periods.find((p) => p.academicYear === y)?.status ?? null);
  const previous = previousYearNotOpen(now, statusOf);
  return {
    openReminder: showOpenReminder(
      currentAcademicYear,
      statusOf(currentAcademicYear),
      now,
    )
      ? OPEN_REMINDER(currentAcademicYear)
      : null,
    previousYear: previous ? PREVIOUS_YEAR_WARNING(previous) : null,
  };
}

const when = (d: Date | string | null | undefined) =>
  d ? formatSgDate(d) : null;

export default function PeriodPanel() {
  const utils = api.useUtils();
  const list = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [sem2, setSem2] = useState("");
  const [downloadBy, setDownloadBy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [resultLine, setResultLine] = useState<string | null>(null);

  const current = list.data?.currentAcademicYear ?? "";
  const year = selected ?? current;
  const period =
    list.data?.periods.find((x) => x.academicYear === year) ?? null;
  const saved = period?.sem2Start
    ? instantToSgDate(new Date(period.sem2Start))
    : "";
  const savedDownloadBy = period?.downloadBy
    ? instantToSgDate(new Date(period.downloadBy))
    : "";

  // Show what is saved whenever the year, or the saved value, changes.
  useEffect(() => {
    setSem2(saved);
  }, [year, saved]);
  useEffect(() => {
    setDownloadBy(savedDownloadBy);
  }, [year, savedDownloadBy]);

  // Unsaved dates: warned about on reload, and before the year changes.
  const confirmLeave = useUnsavedChangesGuard(
    sem2 !== saved || downloadBy !== savedDownloadBy,
  );

  const refresh = async () => {
    await Promise.all([
      utils.transcript.periods.list.invalidate(),
      utils.transcript.freezes.list.invalidate(),
    ]);
  };

  const setSem2Start = api.transcript.periods.setSem2Start.useMutation({
    onSuccess: async () => {
      setResultLine(null);
      await refresh();
    },
  });
  const saveDownloadBy = api.transcript.periods.setDownloadBy.useMutation({
    onSuccess: async () => {
      await refresh();
    },
  });
  const open = api.transcript.periods.open.useMutation({
    onSuccess: async (r) => {
      setConfirming(false);
      setResultLine(openSummary(year, r));
      await refresh();
    },
  });

  if (list.isPending) {
    return (
      <div
        className="h-48 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }
  if (list.error) {
    return (
      <SectionCard title="Academic year">
        <ErrorLine message={errorText(list.error.message)} />
      </SectionCard>
    );
  }

  const published = normaliseStatus(period?.status) === "published";

  return (
    <PeriodPanelView
      years={yearOptions(list.data.periods, current)}
      selected={year}
      onSelect={(y) => {
        if (y !== year && !confirmLeave()) return;
        setSelected(y);
        setResultLine(null);
        setSem2Start.reset();
        open.reset();
      }}
      status={period?.status ?? null}
      canOpen={!published && year !== "" && !isLater(year, current)}
      publishedLine={
        published && period?.publishedAt
          ? `Opened on ${when(period.publishedAt)}${period.publishedByName ? ` by ${period.publishedByName}` : ""}.`
          : null
      }
      sem2Value={sem2}
      onSem2Change={(v) => {
        setSem2(v);
        setSem2Start.reset();
      }}
      sem2Dirty={sem2 !== saved}
      onSaveSem2={() =>
        setSem2Start.mutate({
          academicYear: year,
          sem2Start: sem2 === "" ? null : sem2,
        })
      }
      saving={setSem2Start.isPending}
      saveError={
        setSem2Start.error ? errorText(setSem2Start.error.message) : null
      }
      confirming={confirming}
      onConfirming={(c) => {
        open.reset();
        setConfirming(c);
      }}
      onConfirm={() => open.mutate({ academicYear: year })}
      acting={open.isPending}
      actionError={open.error ? errorText(open.error.message) : null}
      resultLine={resultLine}
      downloadByValue={downloadBy}
      onDownloadByChange={(v) => {
        setDownloadBy(v);
        saveDownloadBy.reset();
      }}
      downloadByDirty={downloadBy !== savedDownloadBy}
      onSaveDownloadBy={() =>
        saveDownloadBy.mutate({
          academicYear: year,
          downloadBy: downloadBy === "" ? null : downloadBy,
        })
      }
      savingDownloadBy={saveDownloadBy.isPending}
      downloadByError={
        saveDownloadBy.error ? errorText(saveDownloadBy.error.message) : null
      }
      reminders={panelReminders(list.data.periods, current, new Date())}
      freezeTable={<FreezeTable academicYear={year} />}
    />
  );
}
