"use client";

import { Loader2 } from "lucide-react";
import { useState, type ReactNode } from "react";

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
  WRITES_LOCKED_NOTE,
  errorText,
  fieldError,
  isWritable,
  yearOptions,
} from "~/lib/transcript/adminView";
import { clearIfUnchanged } from "~/lib/transcript/headView";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL, SectionCard, YearSelect } from "./Bits";
import ResidentPicker, { type PickedResident } from "./ResidentPicker";

export const TITLE_MAX = 120;
export const CITATION_MAX = 300;

export interface AwardRowView {
  id: string;
  residentName: string;
  title: string | null;
  citation: string | null;
  recordedBy: string | null;
  voided: boolean;
}

export interface AwardsPanelViewProps {
  years: string[];
  year: string;
  onYear: (year: string) => void;
  /** The year's status; writes are disabled unless it is collecting. */
  status: string | null;
  /** The resident picker, as a slot (it owns its own search state). */
  picker: ReactNode;
  hasResident: boolean;
  title: string;
  onTitle: (v: string) => void;
  citation: string;
  onCitation: (v: string) => void;
  onAdd: () => void;
  adding: boolean;
  addError: string | null;
  titleError: string | null;
  citationError: string | null;
  awards: AwardRowView[];
  loadingAwards: boolean;
  listError: string | null;
  showVoided: boolean;
  onShowVoided: (v: boolean) => void;
  confirmVoidId: string | null;
  onConfirmVoid: (id: string | null) => void;
  onVoid: () => void;
  voiding: boolean;
  voidError: string | null;
}

/**
 * Section c: Colours Awards. Add one for a resident, and void a mistaken one
 * (it stays on record but no longer appears on transcripts). Everything is
 * disabled, with a note, while the academic year is published. Field limits
 * match the server (title 120, citation 300) and the server's own message is
 * shown if either is exceeded.
 */
export function AwardsPanelView(p: AwardsPanelViewProps) {
  const writable = isWritable(p.status);
  const canAdd =
    writable && p.hasResident && p.title.trim().length > 0 && !p.adding;

  return (
    <AlertDialog
      open={p.confirmVoidId !== null}
      onOpenChange={(o) => !o && !p.voiding && p.onConfirmVoid(null)}
    >
      <SectionCard
        title="Awards"
        description="Awards from the end-of-year Colours Awards. They appear in the Awards section of the resident's transcript."
      >
        <YearSelect
          id="awards-year"
          label="Academic year"
          value={p.year}
          options={p.years}
          onChange={p.onYear}
        />
        {!writable && (
          <p className="mt-3 text-sm text-amber-800" role="status">
            {WRITES_LOCKED_NOTE}
          </p>
        )}

        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) p.onAdd();
          }}
        >
          {p.picker}
          <div className="max-w-md">
            <label htmlFor="award-title" className={FIELD_LABEL}>
              Award title
            </label>
            <Input
              id="award-title"
              value={p.title}
              maxLength={TITLE_MAX}
              disabled={!writable}
              onChange={(e) => p.onTitle(e.target.value)}
              aria-invalid={p.titleError ? true : undefined}
            />
            <ErrorLine message={p.titleError} />
          </div>
          <div className="max-w-md">
            <label htmlFor="award-citation" className={FIELD_LABEL}>
              Citation (optional)
            </label>
            <Input
              id="award-citation"
              value={p.citation}
              maxLength={CITATION_MAX}
              disabled={!writable}
              onChange={(e) => p.onCitation(e.target.value)}
              aria-invalid={p.citationError ? true : undefined}
            />
            <ErrorLine message={p.citationError} />
          </div>
          <Button
            type="submit"
            disabled={!canAdd}
            className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
          >
            {p.adding ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Adding
              </>
            ) : (
              "Add award"
            )}
          </Button>
          <ErrorLine message={p.addError} />
        </form>

        <div className="mt-8 border-t border-gray-100 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-900">
              Awards for {p.year}
            </h3>
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={p.showVoided}
                onChange={(e) => p.onShowVoided(e.target.checked)}
              />
              Show voided
            </label>
          </div>
          <ErrorLine message={p.listError} />
          {p.loadingAwards ? (
            <p className="mt-3 text-sm text-gray-500" aria-busy="true">
              Loading awards.
            </p>
          ) : p.awards.length === 0 ? (
            <p className="mt-3 text-sm text-gray-500">
              No awards recorded for {p.year}.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-gray-100 rounded-md border border-gray-200">
              {p.awards.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
                >
                  <div
                    className={`min-w-0 ${a.voided ? "text-gray-400 line-through" : "text-gray-900"}`}
                  >
                    <p className="text-sm font-medium">
                      {a.title ?? "Untitled award"}
                    </p>
                    <p className="text-sm">{a.residentName}</p>
                    {a.citation && (
                      <p className="mt-0.5 text-xs">{a.citation}</p>
                    )}
                    <p className="mt-0.5 text-xs text-gray-500 no-underline">
                      {a.recordedBy
                        ? `Recorded by ${a.recordedBy}`
                        : "Recorder not known"}
                      {a.voided ? ". Voided" : ""}
                    </p>
                  </div>
                  {!a.voided && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!writable}
                      onClick={() => p.onConfirmVoid(a.id)}
                    >
                      Void
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </SectionCard>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this award?</AlertDialogTitle>
          <AlertDialogDescription>
            The award stays on record but no longer appears on the
            resident&rsquo;s transcript.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={p.voidError} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.voiding}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            onClick={p.onVoid}
            disabled={p.voiding}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {p.voiding ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Voiding
              </>
            ) : (
              "Void award"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function AwardsPanel() {
  const utils = api.useUtils();
  const periods = api.transcript.periods.list.useQuery(undefined, {
    retry: false,
  });
  const [year, setYear] = useState<string | null>(null);
  const [resident, setResident] = useState<PickedResident | null>(null);
  const [title, setTitle] = useState("");
  const [citation, setCitation] = useState("");
  const [showVoided, setShowVoided] = useState(false);
  const [confirmVoidId, setConfirmVoidId] = useState<string | null>(null);

  const current = periods.data?.currentAcademicYear ?? "";
  const selected = year ?? current;
  const status =
    periods.data?.periods.find((x) => x.academicYear === selected)?.status ??
    null;

  const awards = api.transcriptManage.awards.list.useQuery(
    { academicYear: selected, includeVoided: showVoided },
    { enabled: selected !== "", retry: false },
  );

  const create = api.transcriptManage.awards.create.useMutation({
    // Clear what was added; the year stays, and anything typed for the next
    // award while this one was being sent is left alone.
    onSuccess: async (_added, sent) => {
      setTitle((t) => clearIfUnchanged(t, sent.title));
      setCitation((c) => clearIfUnchanged(c, sent.citation ?? ""));
      setResident((r) => (r?.userID === sent.userID ? null : r));
      await utils.transcriptManage.awards.list.invalidate();
    },
  });
  const voidAward = api.transcriptManage.awards.void.useMutation({
    onSuccess: async () => {
      setConfirmVoidId(null);
      await utils.transcriptManage.awards.list.invalidate();
    },
  });

  if (periods.isPending) {
    return (
      <div
        className="h-64 animate-pulse rounded-xl bg-gray-200"
        aria-busy="true"
      />
    );
  }

  const zod = create.error?.data?.zodError ?? null;
  const titleError = fieldError(zod, "title");
  const citationError = fieldError(zod, "citation");

  return (
    <AwardsPanelView
      years={yearOptions(periods.data?.periods ?? [], current)}
      year={selected}
      onYear={(y) => {
        setYear(y);
        create.reset();
      }}
      status={status}
      picker={
        <ResidentPicker
          idPrefix="award"
          selected={resident}
          onSelect={setResident}
          onClear={() => setResident(null)}
          disabled={!isWritable(status)}
        />
      }
      hasResident={resident !== null}
      title={title}
      onTitle={(v) => {
        setTitle(v);
        create.reset();
      }}
      citation={citation}
      onCitation={(v) => {
        setCitation(v);
        create.reset();
      }}
      onAdd={() =>
        resident &&
        create.mutate({
          academicYear: selected,
          userID: resident.userID,
          title,
          citation: citation.trim() === "" ? null : citation,
        })
      }
      adding={create.isPending}
      addError={
        create.error && !titleError && !citationError
          ? errorText(create.error.message)
          : null
      }
      titleError={titleError}
      citationError={citationError}
      awards={(awards.data ?? []).map((a) => ({
        id: a.id,
        residentName: a.displayName ?? a.userID,
        title: a.title,
        citation: a.citation,
        recordedBy: a.recordedByName ?? a.recordedBy,
        voided: a.voidedAt != null,
      }))}
      loadingAwards={awards.isPending && awards.fetchStatus !== "idle"}
      listError={awards.error ? errorText(awards.error.message) : null}
      showVoided={showVoided}
      onShowVoided={setShowVoided}
      confirmVoidId={confirmVoidId}
      onConfirmVoid={(id) => {
        voidAward.reset();
        setConfirmVoidId(id);
      }}
      onVoid={() => confirmVoidId && voidAward.mutate({ id: confirmVoidId })}
      voiding={voidAward.isPending}
      voidError={voidAward.error ? errorText(voidAward.error.message) : null}
    />
  );
}
