"use client";

import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";

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
import { errorText } from "~/lib/transcript/adminView";
import { UNDO_BATCH_CONFIRMATION } from "~/lib/transcript/awards";
import { formatSgDate } from "~/lib/transcript/sgDate";
import { api } from "~/trpc/react";
import { ErrorLine } from "../../_components/Bits";
import { useReturnFocus } from "~/lib/transcript/useReturnFocus";

export interface BatchItem {
  id: string;
  fileName: string;
  rowCount: number;
  importedCount: number;
  skippedCount: number;
  createdByName: string | null;
  createdAt: Date | string | null;
  undone: boolean;
  undoneAt: Date | string | null;
  undoneByName: string | null;
  activeCount: number;
}

export interface AwardHistoryViewProps {
  items: BatchItem[];
  loading: boolean;
  loadError: string | null;
  readOnly: boolean;
  /** The batch whose undo is being confirmed. */
  undoing: BatchItem | null;
  onUndoing: (item: BatchItem | null) => void;
  onUndo: () => void;
  busy: boolean;
  actionError: string | null;
  doneLine: string | null;
}

/** Uploads of awards for the year, each with Undo while it still has awards. */
export function AwardHistoryView(p: AwardHistoryViewProps) {
  const returnFocus = useReturnFocus();
  // The dialog keeps its words while it fades out, after `undoing` is cleared.
  const last = useRef<BatchItem | null>(null);
  if (p.undoing) last.current = p.undoing;
  const shown = p.undoing ?? last.current;
  return (
    <AlertDialog
      open={p.undoing !== null}
      onOpenChange={(o) => !o && !p.busy && p.onUndoing(null)}
    >
      <div>
        <ErrorLine message={p.loadError} />
        {p.doneLine && (
          <p className="mb-3 text-sm text-emerald-800" role="status">
            {p.doneLine}
          </p>
        )}
        {p.loading ? (
          <div
            className="h-24 animate-pulse rounded-md bg-gray-100"
            aria-busy="true"
          />
        ) : p.items.length === 0 ? (
          <p className="text-sm text-gray-500">No uploads for this year yet.</p>
        ) : (
          <div className="relative overflow-x-auto rounded-md border border-gray-200">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs font-medium text-gray-700">
                  <th scope="col" className="px-3 py-2">
                    File
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Uploaded
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Imported
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Skipped
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {p.items.map((b) => (
                  <tr key={b.id} className="align-top">
                    <td className="px-3 py-2 font-medium text-gray-900">
                      {b.fileName || "Pasted rows"}
                    </td>
                    <td className="px-3 py-2 text-gray-700">
                      {b.createdByName ?? ""}
                      {b.createdAt ? `, ${formatSgDate(b.createdAt)}` : ""}
                    </td>
                    <td className="px-3 py-2">{b.importedCount}</td>
                    <td className="px-3 py-2">{b.skippedCount}</td>
                    <td className="px-3 py-2 text-gray-700">
                      {b.undone
                        ? `Undone${b.undoneByName ? ` by ${b.undoneByName}` : ""}${b.undoneAt ? ` on ${formatSgDate(b.undoneAt)}` : ""}`
                        : `${b.activeCount} active`}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!b.undone && !p.readOnly && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          aria-label={`Undo ${b.fileName || "pasted rows"}`}
                          onClick={() => p.onUndoing(b)}
                        >
                          Undo
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
          <AlertDialogTitle>Undo this upload?</AlertDialogTitle>
          <AlertDialogDescription>
            {UNDO_BATCH_CONFIRMATION(shown?.activeCount ?? 0)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ErrorLine message={p.actionError} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.busy}>Cancel</AlertDialogCancel>
          <Button type="button" disabled={p.busy} onClick={p.onUndo}>
            {p.busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Undoing
              </>
            ) : (
              "Undo upload"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function AwardHistory({
  academicYear,
  readOnly,
}: {
  academicYear: string;
  readOnly: boolean;
}) {
  const utils = api.useUtils();
  const [undoing, setUndoing] = useState<BatchItem | null>(null);
  const [doneLine, setDoneLine] = useState<string | null>(null);
  const list = api.transcriptManage.awardBatches.list.useQuery(
    { academicYear },
    { enabled: academicYear !== "", retry: false },
  );
  const undo = api.transcriptManage.awardBatches.undo.useMutation({
    onSuccess: async (r) => {
      setUndoing(null);
      setDoneLine(
        `${r.removed} ${r.removed === 1 ? "award" : "awards"} removed.`,
      );
      await Promise.all([
        utils.transcriptManage.awardBatches.list.invalidate(),
        utils.transcriptManage.awards.list.invalidate(),
        utils.transcriptManage.awardTypes.list.invalidate(),
      ]);
    },
  });

  return (
    <AwardHistoryView
      items={list.data ?? []}
      loading={list.isPending && list.fetchStatus !== "idle"}
      loadError={list.error ? errorText(list.error.message) : null}
      readOnly={readOnly}
      undoing={undoing}
      onUndoing={(b) => {
        undo.reset();
        setUndoing(b);
      }}
      onUndo={() => undoing && undo.mutate({ batchId: undoing.id })}
      busy={undo.isPending}
      actionError={undo.error ? errorText(undo.error.message) : null}
      doneLine={doneLine}
    />
  );
}
