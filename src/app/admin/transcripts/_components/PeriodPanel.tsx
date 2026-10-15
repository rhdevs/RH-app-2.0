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
  ACTION_LABEL,
  BACK_TO_COLLECTING_CONFIRMATION,
  CLOSE_CONFIRMATION,
  PUBLISH_CONFIRMATION,
  REOPEN_CONFIRMATION,
  closeSummary,
  errorText,
  normaliseStatus,
  statusLabel,
  yearOptions,
} from "~/lib/transcript/adminView";
import { validActions, type YearAction } from "~/lib/transcript/lifecycle";
import { formatSgDate, instantToSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import {
  ErrorLine,
  FIELD_LABEL,
  SectionCard,
  StatusBadge,
  YearSelect,
} from "./Bits";
import FreezeTable from "./FreezeTable";

export type Confirming = YearAction | null;

export interface PeriodPanelViewProps {
  years: string[];
  selected: string;
  onSelect: (year: string) => void;
  /** The stored status of the selected year; null when it has no period yet. */
  status: string | null;
  /** "Published on 15 Oct 2026 by ..." or null. */
  publishedLine: string | null;
  sem2Value: string;
  onSem2Change: (value: string) => void;
  /** True when the field differs from what is saved. */
  sem2Dirty: boolean;
  onSaveSem2: () => void;
  saving: boolean;
  saveError: string | null;
  confirming: Confirming;
  onConfirming: (c: Confirming) => void;
  /** Run the action being confirmed. */
  onConfirm: () => void;
  /** An action is in flight. */
  acting: boolean;
  actionError: string | null;
  /** The last result, in words, shown in place after an action succeeds. */
  resultLine: string | null;
  /** How many CCAs a Close year would freeze, for its confirmation. */
  unfrozenCount: number | null;
  /** The download-by date (a Singapore calendar date), "" when none. */
  downloadByValue: string;
  onDownloadByChange: (value: string) => void;
  downloadByDirty: boolean;
  onSaveDownloadBy: () => void;
  savingDownloadBy: boolean;
  downloadByError: string | null;
  /** The "CCA member lists" table for the selected year. */
  freezeTable?: ReactNode;
}

/** The title and wording of each action's confirmation. */
export function confirmationFor(
  action: YearAction,
  academicYear: string,
  unfrozenCount: number | null,
): { title: string; text: string } {
  switch (action) {
    case "close":
      return {
        title: `Close ${academicYear}?`,
        text: CLOSE_CONFIRMATION(academicYear, unfrozenCount ?? 0),
      };
    case "publish":
      return {
        title: `Publish ${academicYear}?`,
        text: PUBLISH_CONFIRMATION(academicYear),
      };
    case "reopen":
      return {
        title: `Reopen ${academicYear} for review?`,
        text: REOPEN_CONFIRMATION,
      };
    case "backToCollecting":
      return {
        title: `Put ${academicYear} back to collecting?`,
        text: BACK_TO_COLLECTING_CONFIRMATION,
      };
  }
}

/**
 * Section a: choose an academic year, set when semester 2 starts, and move the
 * year along: Close year, Publish, Reopen for review, Back to collecting. Only
 * the actions that are valid for the year's status are offered. Each goes
 * through a dialog that says what will happen in plain words. The server's own
 * refusal (for example no semester 2 date) is shown inline.
 */
export function PeriodPanelView(p: PeriodPanelViewProps) {
  const status = normaliseStatus(p.status);
  const published = status === "published";
  const dialogOpen = p.confirming !== null;
  const confirmation = p.confirming
    ? confirmationFor(p.confirming, p.selected, p.unfrozenCount)
    : null;

  return (
    <AlertDialog
      open={dialogOpen}
      onOpenChange={(o) => !o && !p.acting && p.onConfirming(null)}
    >
      <SectionCard
        title="Academic year"
        description="Heads and the JCRC edit while a year is collecting. Closing it freezes every CCA's member list and opens it for review, and publishing opens transcripts to residents."
      >
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
          accepted on or after it defaults to semester 2. It is needed before
          the year can be closed.
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
          can be changed while the year is published.
        </p>
        <ErrorLine message={p.downloadByError} />

        <div className="mt-6 flex flex-wrap gap-3 border-t border-gray-100 pt-5">
          {validActions(status).map((action) => (
            <Button
              key={action}
              type="button"
              variant={
                action === "publish" || action === "close"
                  ? "default"
                  : "outline"
              }
              onClick={() => p.onConfirming(action)}
              disabled={p.acting}
              className={
                action === "publish" || action === "close"
                  ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
                  : action === "reopen"
                    ? "border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                    : undefined
              }
            >
              {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
        {p.resultLine && !dialogOpen && (
          <p className="mt-3 text-sm text-gray-700" role="status">
            {p.resultLine}
          </p>
        )}
        {!dialogOpen && <ErrorLine message={p.actionError} />}

        {p.freezeTable}
      </SectionCard>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.title ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.text ?? ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={dialogOpen ? p.actionError : null} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.acting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            onClick={p.onConfirm}
            disabled={p.acting}
            className={
              p.confirming === "reopen"
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-emerald-600 text-white hover:bg-emerald-700"
            }
          >
            {p.acting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Working
              </>
            ) : p.confirming ? (
              ACTION_LABEL[p.confirming]
            ) : (
              "Confirm"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
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
  const [confirming, setConfirming] = useState<Confirming>(null);
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

  const unfrozen = api.transcript.periods.unfrozenCount.useQuery(
    { academicYear: year },
    { enabled: year !== "", retry: false },
  );

  const refresh = async () => {
    await Promise.all([
      utils.transcript.periods.list.invalidate(),
      utils.transcript.periods.unfrozenCount.invalidate(),
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
  const done = async (line: string) => {
    setConfirming(null);
    setResultLine(line);
    await refresh();
  };
  const close = api.transcript.periods.close.useMutation({
    onSuccess: (r) => done(closeSummary(year, r)),
  });
  const publish = api.transcript.periods.publish.useMutation({
    onSuccess: () => done(`${year} published.`),
  });
  const reopen = api.transcript.periods.reopen.useMutation({
    onSuccess: () => done(`${year} reopened for review.`),
  });
  const back = api.transcript.periods.backToCollecting.useMutation({
    onSuccess: () => done(`${year} is collecting again.`),
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

  const actionError =
    close.error ?? publish.error ?? reopen.error ?? back.error;
  const published = normaliseStatus(period?.status) === "published";
  const acting =
    close.isPending || publish.isPending || reopen.isPending || back.isPending;
  const resetActions = () => {
    close.reset();
    publish.reset();
    reopen.reset();
    back.reset();
  };

  return (
    <PeriodPanelView
      years={yearOptions(list.data.periods, current)}
      selected={year}
      onSelect={(y) => {
        setSelected(y);
        setResultLine(null);
        setSem2Start.reset();
        resetActions();
      }}
      status={period?.status ?? null}
      publishedLine={
        published && period?.publishedAt
          ? `Published on ${when(period.publishedAt)}${period.publishedByName ? ` by ${period.publishedByName}` : ""}.`
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
        resetActions();
        setConfirming(c);
      }}
      onConfirm={() => {
        if (confirming === "close") close.mutate({ academicYear: year });
        else if (confirming === "publish")
          publish.mutate({ academicYear: year });
        else if (confirming === "reopen") reopen.mutate({ academicYear: year });
        else if (confirming === "backToCollecting")
          back.mutate({ academicYear: year });
      }}
      acting={acting}
      actionError={actionError ? errorText(actionError.message) : null}
      resultLine={resultLine}
      unfrozenCount={unfrozen.data ?? null}
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
      freezeTable={
        <FreezeTable academicYear={year} status={period?.status ?? null} />
      }
    />
  );
}
