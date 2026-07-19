"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";

import { api } from "~/trpc/react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import { useCapabilities } from "../AdminCapabilityContext";
import EmptyState from "../EmptyState";

export default function BulkImportHistory() {
  const cap = useCapabilities();
  const utils = api.useUtils();
  const { data, isLoading } = api.admin.listBulkImports.useQuery({ limit: 25 });
  const [detailId, setDetailId] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<string | null>(null);

  const undo = api.admin.undoBulkImport.useMutation({
    onSuccess: async () => {
      setUndoId(null);
      await utils.admin.listBulkImports.invalidate();
      await utils.admin.listUsers.invalidate();
    },
  });

  const detail = api.admin.getBulkImport.useQuery(
    { batchId: detailId! },
    { enabled: detailId !== null },
  );

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold text-gray-900">Import history</h2>
      <div className="overflow-hidden rounded-xl bg-white shadow-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>By</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!isLoading && (data?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <EmptyState title="No bulk imports yet." />
                </TableCell>
              </TableRow>
            )}
            {data?.map((b) => (
              <TableRow
                key={b.batchId}
                className="cursor-pointer"
                onClick={() => setDetailId(b.batchId)}
              >
                <TableCell className="text-sm text-gray-600">
                  {formatDistanceToNow(new Date(b.startedAt), {
                    addSuffix: true,
                  })}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {b.actorUserID}
                </TableCell>
                <TableCell className="text-sm">{b.mode}</TableCell>
                <TableCell className="max-w-xs truncate text-sm text-gray-500">
                  {b.note ?? "—"}
                </TableCell>
                <TableCell>
                  {b.undoneBy ? (
                    <Badge
                      variant="outline"
                      className="border-gray-300 bg-gray-100 text-gray-600"
                    >
                      Undone
                    </Badge>
                  ) : b.finishedAt ? (
                    <Badge
                      variant="outline"
                      className="border-emerald-300 bg-emerald-100 text-emerald-800"
                    >
                      Complete
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-amber-300 bg-amber-100 text-amber-800"
                    >
                      Incomplete
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {cap.undoBulkImport && !b.undoneBy && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setUndoId(b.batchId);
                      }}
                    >
                      Undo
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {undoId && (
        <AlertDialog open onOpenChange={(o) => !o && setUndoId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reverse this import?</AlertDialogTitle>
              {/* Undo is a NORMAL guarded role change per row, not a privileged
                  rollback: it gets its own batchId and its own audit rows, the
                  log stays append-only, and a jcrc cannot reverse an admin's
                  admin-granting import. */}
              <AlertDialogDescription>
                Users whose roles changed since the import will be left alone
                (reported as DIVERGED_SINCE_IMPORT) rather than reverted. Each
                row runs the same guards as a single role change, so some may be
                refused. The Resident baseline survives the reversal — the write
                cannot express its removal.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={undo.isPending}
                onClick={() => undo.mutate({ batchId: undoId })}
              >
                {undo.isPending ? "Undoing…" : "Reverse import"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {detailId && (
        <Dialog open onOpenChange={(o) => !o && setDetailId(null)}>
          <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Import detail</DialogTitle>
            </DialogHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Before → After</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.data?.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.targetUserID ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{r.action}</TableCell>
                    <TableCell className="text-xs text-gray-500">
                      {(r.rolesBefore ?? []).join(", ") || "—"} →{" "}
                      {(r.rolesAfter ?? []).join(", ") || "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.ok ? (
                        <span className="text-emerald-700">ok</span>
                      ) : (
                        <span className="text-red-600">{r.denyReason}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
