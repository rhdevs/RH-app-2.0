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
import { formatFlatPoints } from "~/lib/points/flat";
import { pointsErrorCopy } from "./errorCopy";
import FlatDialog, { type FlatCca } from "./FlatDialog";
import FlatExport from "./FlatExport";

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

function FlatActions({
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

/** Shown when a waiver exists on the same CCA: it is kept but not used. */
function WaiverNote({ cca }: { cca: FlatCca }) {
  if (!cca.hasWaiver) return null;
  return (
    <p className="mt-0.5 text-xs text-amber-700">
      Has a waiver, not used while flat
    </p>
  );
}

/**
 * CCAs where every member gets the same points, set here by JCRC. The sandbox
 * applies the maths; the CSV export below is how the memberships get there.
 */
export default function FlatCcasPanel({
  flatCcas,
  onChanged,
}: {
  flatCcas: FlatCca[];
  onChanged: () => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FlatCca | null>(null);
  const [removing, setRemoving] = useState<FlatCca | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const clear = api.ccaPoints.clearFlat.useMutation({
    onSuccess: async () => {
      setSaved(
        `${removing?.ccaName ?? "That CCA"} is no longer a flat-points CCA.`,
      );
      setRemoving(null);
      await onChanged();
    },
  });

  const openDialog = (cca: FlatCca | null) => {
    setSaved(null);
    setEditing(cca);
    setDialogOpen(true);
  };
  const askRemove = (cca: FlatCca) => {
    clear.reset();
    setSaved(null);
    setRemoving(cca);
  };

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-900">
          Flat-points CCAs
        </h3>
        <div className="flex flex-wrap items-start gap-2">
          <FlatExport flatCount={flatCcas.length} />
          <Button size="sm" onClick={() => openDialog(null)}>
            <Plus className="h-4 w-4" />
            Add flat CCA
          </Button>
        </div>
      </div>
      <p className="mb-4 max-w-3xl text-xs text-gray-500">
        In a flat-points CCA every member gets the same points for the whole
        CCA, with no placement bonus, multipliers or halving. Its leaders have
        nothing to enter. Export the file below and give it to whoever runs the
        points sandbox.
      </p>

      {saved && (
        <p className="mb-3 text-sm text-emerald-700" role="status">
          {saved}
        </p>
      )}

      {flatCcas.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-6 text-sm text-gray-500">
          No flat-points CCAs.
        </p>
      ) : (
        <>
          {/* Phone: stacked cards, so Edit and Remove are never off-screen. */}
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 sm:hidden">
            {flatCcas.map((c) => (
              <li key={c.ccaID} className="space-y-1.5 px-3 py-3 text-sm">
                <p className="font-medium text-gray-900">
                  {c.ccaName}
                  <span className="ml-2 font-mono text-xs text-gray-400">
                    {c.ccaID}
                  </span>
                </p>
                <p className="tabular-nums text-gray-700">
                  {formatFlatPoints(c.flatPoints)} points each · {c.memberCount}{" "}
                  {c.memberCount === 1 ? "member" : "members"}
                </p>
                <WaiverNote cca={c} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-gray-500">
                    Updated {when(c.updatedAt)}
                  </span>
                  <span>
                    <FlatActions
                      onEdit={() => openDialog(c)}
                      onRemove={() => askRemove(c)}
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
                  <TableHead>Points each</TableHead>
                  <TableHead>Members</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flatCcas.map((c) => (
                  <TableRow key={c.ccaID}>
                    <TableCell className="font-medium">
                      <span className="whitespace-nowrap">
                        {c.ccaName}
                        <span className="ml-2 font-mono text-xs text-gray-400">
                          {c.ccaID}
                        </span>
                      </span>
                      <WaiverNote cca={c} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatFlatPoints(c.flatPoints)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {c.memberCount}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-gray-500">
                      {when(c.updatedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <FlatActions
                        onEdit={() => openDialog(c)}
                        onRemove={() => askRemove(c)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <FlatDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={async () => {
          setSaved("Saved the flat points.");
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
              Make {removing?.ccaName} a normal CCA again?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its leaders will be asked to allocate points as usual. A flat file
              you already exported is not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {clear.error && (
            <p className="text-sm text-red-700" role="alert">
              {pointsErrorCopy(clear.error.message, clear.error.data?.code)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clear.isPending}>
              Keep it flat
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
