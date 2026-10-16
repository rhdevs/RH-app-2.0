"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { Range } from "~/lib/points/constants";
import { pointsErrorCopy } from "./errorCopy";
import WaiverDialog, { type Waiver } from "./WaiverDialog";

/** "14–17", or "default" when the waiver leaves that pair to the default. */
function rangeText(min: number | null, max: number | null): string {
  if (min === null && max === null) return "default";
  return `${min ?? "default"}–${max ?? "default"}`;
}

function when(at: Date | string | null): string {
  if (!at) return "—";
  return new Date(at).toLocaleString("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function WaiverActions({
  onEdit,
  onRemove,
}: {
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-red-600 hover:bg-red-50 hover:text-red-700"
        onClick={onRemove}
      >
        Remove
      </Button>
    </>
  );
}

/**
 * Per-CCA waivers. A waiver overrides individual fields of the default; blank
 * fields keep following it. Add and Edit share one dialog; Remove asks first.
 */
export default function WaiversPanel({
  overrides,
  effectiveDefault,
  onChanged,
}: {
  overrides: Waiver[];
  effectiveDefault: Range;
  onChanged: () => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Waiver | null>(null);
  const [removing, setRemoving] = useState<Waiver | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const clear = api.ccaPoints.clearOverride.useMutation({
    onSuccess: async () => {
      setSaved(`Removed the waiver for ${removing?.ccaName ?? "that CCA"}.`);
      setRemoving(null);
      await onChanged();
    },
  });

  const openDialog = (waiver: Waiver | null) => {
    setSaved(null);
    setEditing(waiver);
    setDialogOpen(true);
  };
  const askRemove = (waiver: Waiver) => {
    clear.reset();
    setSaved(null);
    setRemoving(waiver);
  };

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">Waivers</h3>
        <Button size="sm" onClick={() => openDialog(null)}>
          <Plus className="h-4 w-4" />
          Add waiver
        </Button>
      </div>
      <p className="mb-4 max-w-3xl text-xs text-gray-500">
        A CCA with a waiver is judged against its own ranges instead of the
        defaults. Fields left blank keep following the default.
      </p>

      {saved && (
        <p className="mb-3 text-sm text-emerald-700" role="status">
          {saved}
        </p>
      )}

      {overrides.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
          No waivers. Every CCA follows the default ranges.
        </p>
      ) : (
        <>
          {/* Phone: stacked cards, so Edit and Remove are never off-screen. */}
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 sm:hidden">
            {overrides.map((w) => (
              <li key={w.ccaID} className="space-y-1.5 px-3 py-3 text-sm">
                <p className="font-medium text-gray-900">
                  {w.ccaName}
                  <span className="ml-2 font-mono text-xs text-gray-400">
                    {w.ccaID}
                  </span>
                </p>
                <p className="tabular-nums text-gray-700">
                  Average {rangeText(w.meanMin, w.meanMax)} · Spread (SD){" "}
                  {rangeText(w.sdMin, w.sdMax)}
                </p>
                {w.note && <p className="text-gray-600">{w.note}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-gray-500">
                    Updated {when(w.updatedAt)}
                  </span>
                  <span>
                    <WaiverActions
                      onEdit={() => openDialog(w)}
                      onRemove={() => askRemove(w)}
                    />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>CCA</TableHead>
                  <TableHead>Average</TableHead>
                  <TableHead>Spread (SD)</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map((w) => (
                  <TableRow key={w.ccaID}>
                    <TableCell className="whitespace-nowrap font-medium">
                      {w.ccaName}
                      <span className="ml-2 font-mono text-xs text-gray-400">
                        {w.ccaID}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {rangeText(w.meanMin, w.meanMax)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {rangeText(w.sdMin, w.sdMax)}
                    </TableCell>
                    <TableCell className="min-w-48 max-w-xs text-sm text-gray-600">
                      {w.note ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-gray-500">
                      {when(w.updatedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <WaiverActions
                        onEdit={() => openDialog(w)}
                        onRemove={() => askRemove(w)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <WaiverDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        effectiveDefault={effectiveDefault}
        onSaved={async () => {
          setSaved("Saved the waiver.");
          await onChanged();
        }}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o && !clear.isPending) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove the waiver for {removing?.ccaName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This CCA will be judged against the default ranges again. Leaders
              who have already exported are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {clear.error && (
            <p className="text-sm text-red-700" role="alert">
              {pointsErrorCopy(clear.error.message, clear.error.data?.code)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clear.isPending}>
              Keep it
            </AlertDialogCancel>
            <button
              type="button"
              disabled={clear.isPending}
              onClick={() =>
                removing && clear.mutate({ ccaID: removing.ccaID })
              }
              className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:pointer-events-none disabled:opacity-50"
            >
              {clear.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Removing…
                </>
              ) : (
                "Yes, remove it"
              )}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
