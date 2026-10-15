"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

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
  PUBLISH_CONFIRMATION,
  REOPEN_CONFIRMATION,
  errorText,
  normaliseStatus,
  publishSummary,
  statusLabel,
  yearOptions,
} from "~/lib/transcript/adminView";
import { formatSgDate, instantToSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import {
  ErrorLine,
  FIELD_LABEL,
  SectionCard,
  StatusBadge,
  YearSelect,
} from "./Bits";

export type Confirming = "publish" | "reopen" | null;

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
  onPublish: () => void;
  onReopen: () => void;
  publishing: boolean;
  reopening: boolean;
  actionError: string | null;
  /** The last result, in words, shown in place after an action succeeds. */
  resultLine: string | null;
}

/**
 * Section a: choose an academic year, set when semester 2 starts, and publish or
 * reopen it. Publishing and reopening are the two hard-to-reverse actions, so
 * each goes through a dialog that says what will happen in plain words. The
 * server's own refusal (for example no semester 2 date) is shown inline.
 */
export function PeriodPanelView(p: PeriodPanelViewProps) {
  const published = normaliseStatus(p.status) === "published";
  const dialogOpen = p.confirming !== null;

  return (
    <AlertDialog
      open={dialogOpen}
      onOpenChange={(o) =>
        !o && !p.publishing && !p.reopening && p.onConfirming(null)
      }
    >
      <SectionCard
        title="Academic year"
        description="Heads and the JCRC edit while a year is collecting. Publishing freezes the member list and opens transcripts to residents."
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
          accepted on or after it defaults to semester 2.
        </p>
        <ErrorLine message={p.saveError} />

        <div className="mt-6 border-t border-gray-100 pt-5">
          {published ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => p.onConfirming("reopen")}
              disabled={p.reopening}
              className="border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
            >
              Reopen {p.selected}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => p.onConfirming("publish")}
              disabled={p.publishing}
              className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
            >
              Publish {p.selected}
            </Button>
          )}
          {p.resultLine && !dialogOpen && (
            <p className="mt-3 text-sm text-gray-700" role="status">
              {p.resultLine}
            </p>
          )}
          {!dialogOpen && <ErrorLine message={p.actionError} />}
        </div>
      </SectionCard>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {p.confirming === "reopen"
              ? `Reopen ${p.selected}?`
              : `Publish ${p.selected}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {p.confirming === "reopen"
              ? REOPEN_CONFIRMATION
              : PUBLISH_CONFIRMATION(p.selected)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={dialogOpen ? p.actionError : null} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.publishing || p.reopening}>
            Cancel
          </AlertDialogCancel>
          {p.confirming === "reopen" ? (
            <Button
              type="button"
              onClick={p.onReopen}
              disabled={p.reopening}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {p.reopening ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Reopening
                </>
              ) : (
                "Reopen"
              )}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={p.onPublish}
              disabled={p.publishing}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {p.publishing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Publishing
                </>
              ) : (
                "Publish"
              )}
            </Button>
          )}
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
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [resultLine, setResultLine] = useState<string | null>(null);

  const current = list.data?.currentAcademicYear ?? "";
  const year = selected ?? current;
  const period =
    list.data?.periods.find((x) => x.academicYear === year) ?? null;
  const saved = period?.sem2Start
    ? instantToSgDate(new Date(period.sem2Start))
    : "";

  // Show what is saved whenever the year, or the saved value, changes.
  useEffect(() => {
    setSem2(saved);
  }, [year, saved]);

  const refresh = () => utils.transcript.periods.list.invalidate();

  const setSem2Start = api.transcript.periods.setSem2Start.useMutation({
    onSuccess: async () => {
      setResultLine(null);
      await refresh();
    },
  });
  const publish = api.transcript.periods.publish.useMutation({
    onSuccess: async (result) => {
      setConfirming(null);
      setResultLine(`${year} published. ${publishSummary(result)}.`);
      await refresh();
    },
  });
  const reopen = api.transcript.periods.reopen.useMutation({
    onSuccess: async () => {
      setConfirming(null);
      setResultLine(`${year} reopened.`);
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

  const actionError = publish.error ?? reopen.error;
  const published = normaliseStatus(period?.status) === "published";

  return (
    <PeriodPanelView
      years={yearOptions(list.data.periods, current)}
      selected={year}
      onSelect={(y) => {
        setSelected(y);
        setResultLine(null);
        setSem2Start.reset();
        publish.reset();
        reopen.reset();
      }}
      status={period?.status ?? null}
      publishedLine={
        published && period?.publishedAt
          ? `Published on ${when(period.publishedAt)}${period.publishedBy ? ` by ${period.publishedBy}` : ""}.`
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
        publish.reset();
        reopen.reset();
        setConfirming(c);
      }}
      onPublish={() => publish.mutate({ academicYear: year })}
      onReopen={() => reopen.mutate({ academicYear: year })}
      publishing={publish.isPending}
      reopening={reopen.isPending}
      actionError={actionError ? errorText(actionError.message) : null}
      resultLine={resultLine}
    />
  );
}
