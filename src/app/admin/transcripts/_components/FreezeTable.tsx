"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

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
import { Textarea } from "~/components/ui/textarea";
import {
  UNFREEZE_WARNING,
  UNFROZEN_BANNER,
  errorText,
  normaliseStatus,
} from "~/lib/transcript/adminView";
import { showUnfrozenWarning } from "~/lib/transcript/lifecycle";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine, FIELD_LABEL } from "./Bits";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface FreezeRowView {
  ccaID: number;
  ccaName: string;
  category: string;
  /** "Not frozen", "Frozen at handover", ... */
  state: string;
  frozen: boolean;
  frozenAt: Date | string | null;
  frozenByName: string | null;
  memberCount: number | null;
}

/** Rows to show: all, or only the ones not frozen. */
export function visibleFreezeRows(
  rows: readonly FreezeRowView[],
  onlyUnfrozen: boolean,
): FreezeRowView[] {
  return onlyUnfrozen ? rows.filter((r) => !r.frozen) : [...rows];
}

export const UNFREEZE_REASON_MAX = 500;

export interface FreezeTableViewProps {
  academicYear: string;
  /** The year's status; a published year cannot be unfrozen. */
  status: string | null;
  rows: FreezeRowView[];
  onlyUnfrozen: boolean;
  onOnlyUnfrozen: (value: boolean) => void;
  /** The 1 June warning, when it applies. */
  warning: string | null;
  loadError: string | null;
  /** The CCA whose Unfreeze is being confirmed. */
  unfreezing: { ccaID: number; ccaName: string } | null;
  onUnfreezing: (cca: { ccaID: number; ccaName: string } | null) => void;
  reason: string;
  onReason: (value: string) => void;
  onUnfreeze: () => void;
  pending: boolean;
  unfreezeError: string | null;
}

/**
 * "CCA member lists" for the selected year: each CCA's state, when and by whom
 * it was frozen, how many members it holds, and Unfreeze (with a required
 * reason) while the year is not published.
 */
export function FreezeTableView(p: FreezeTableViewProps) {
  const returnFocus = useReturnFocus();
  const status = normaliseStatus(p.status);
  const shown = visibleFreezeRows(p.rows, p.onlyUnfrozen);
  const canUnfreeze = status !== "published";
  const reasonOk = p.reason.trim().length >= 3;

  return (
    <AlertDialog
      open={p.unfreezing !== null}
      onOpenChange={(o) => !o && !p.pending && p.onUnfreezing(null)}
    >
      <div className="mt-8 border-t border-gray-100 pt-5">
        <h3 className="text-sm font-semibold text-gray-900">
          CCA member lists
        </h3>
        <p className="mt-1 max-w-2xl text-xs text-gray-500">
          A CCA&rsquo;s member list is frozen at its handover, so the transcript
          keeps the members of the year it is for.
        </p>
        {p.warning && (
          <p
            role="status"
            className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            {p.warning}
          </p>
        )}
        <ErrorLine message={p.loadError} />

        <label className="mt-3 inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={p.onlyUnfrozen}
            onChange={(e) => p.onOnlyUnfrozen(e.target.checked)}
          />
          Not frozen only
        </label>

        {shown.length === 0 ? (
          <p className="mt-3 text-sm text-gray-500">
            {p.onlyUnfrozen ? "Every CCA is frozen." : "No CCAs."}
          </p>
        ) : (
          <div className="relative mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] divide-y divide-gray-200 text-left text-sm">
              <thead>
                <tr className="text-xs font-medium text-gray-700">
                  <th scope="col" className="px-2 py-2">
                    CCA
                  </th>
                  <th scope="col" className="px-2 py-2">
                    State
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Date
                  </th>
                  <th scope="col" className="px-2 py-2">
                    By
                  </th>
                  <th scope="col" className="px-2 py-2">
                    Members
                  </th>
                  <th scope="col" className="px-2 py-2">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {shown.map((r) => (
                  <tr key={r.ccaID}>
                    <td className="px-2 py-2 font-medium text-gray-900">
                      {r.ccaName}
                    </td>
                    <td className="px-2 py-2">{r.state}</td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {r.frozenAt ? formatSgDate(r.frozenAt) : ""}
                    </td>
                    <td className="px-2 py-2">{r.frozenByName ?? ""}</td>
                    <td className="px-2 py-2">{r.memberCount ?? ""}</td>
                    <td className="px-2 py-2 text-right">
                      {r.frozen && canUnfreeze && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Unfreeze ${r.ccaName}`}
                          onClick={() =>
                            p.onUnfreezing({
                              ccaID: r.ccaID,
                              ccaName: r.ccaName,
                            })
                          }
                        >
                          Unfreeze
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {p.unfreezing
              ? `Unfreeze ${p.unfreezing.ccaName}?`
              : "Unfreeze this CCA?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {UNFREEZE_WARNING(p.academicYear)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div>
          <label htmlFor="unfreeze-reason" className={FIELD_LABEL}>
            Reason (required)
          </label>
          <Textarea
            id="unfreeze-reason"
            rows={3}
            value={p.reason}
            maxLength={UNFREEZE_REASON_MAX}
            onChange={(e) => p.onReason(e.target.value)}
            disabled={p.pending}
          />
        </div>
        <ErrorLine message={p.unfreezeError} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.pending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            onClick={p.onUnfreeze}
            disabled={p.pending || !reasonOk}
          >
            {p.pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Unfreezing
              </>
            ) : (
              "Unfreeze"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function FreezeTable({
  academicYear,
  status,
}: {
  academicYear: string;
  status: string | null;
}) {
  const utils = api.useUtils();
  const list = api.transcript.freezes.list.useQuery(
    { academicYear },
    { enabled: academicYear !== "", retry: false },
  );
  const [onlyUnfrozen, setOnlyUnfrozen] = useState(false);
  const [unfreezing, setUnfreezing] = useState<{
    ccaID: number;
    ccaName: string;
  } | null>(null);
  const [reason, setReason] = useState("");

  const unfreeze = api.transcript.freezes.unfreeze.useMutation({
    onSuccess: async () => {
      setUnfreezing(null);
      setReason("");
      await Promise.all([
        utils.transcript.freezes.list.invalidate(),
        utils.transcript.periods.unfrozenCount.invalidate(),
        utils.transcript.periods.unfrozenNames.invalidate(),
      ]);
    },
  });

  const rows: FreezeRowView[] = (list.data?.rows ?? []).map((r) => ({
    ccaID: r.ccaID,
    ccaName: r.ccaName,
    category: r.category,
    state: r.state,
    frozen: r.reason !== null,
    frozenAt: r.frozenAt,
    frozenByName: r.frozenByName,
    memberCount: r.memberCount,
  }));
  const unfrozenCount = list.data?.unfrozen ?? 0;
  const warn = showUnfrozenWarning(
    academicYear,
    normaliseStatus(status),
    new Date(),
    unfrozenCount,
  );

  return (
    <FreezeTableView
      academicYear={academicYear}
      status={status}
      rows={rows}
      onlyUnfrozen={onlyUnfrozen}
      onOnlyUnfrozen={setOnlyUnfrozen}
      warning={warn ? UNFROZEN_BANNER(unfrozenCount, academicYear) : null}
      loadError={list.error ? errorText(list.error.message) : null}
      unfreezing={unfreezing}
      onUnfreezing={(c) => {
        unfreeze.reset();
        setReason("");
        setUnfreezing(c);
      }}
      reason={reason}
      onReason={setReason}
      onUnfreeze={() =>
        unfreezing &&
        unfreeze.mutate({
          academicYear,
          ccaID: unfreezing.ccaID,
          reason: reason.trim(),
        })
      }
      pending={unfreeze.isPending}
      unfreezeError={unfreeze.error ? errorText(unfreeze.error.message) : null}
    />
  );
}
