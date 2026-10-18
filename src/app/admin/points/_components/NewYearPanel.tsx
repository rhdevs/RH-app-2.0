"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

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
import { pointsErrorCopy } from "./errorCopy";
import { saveStatus, statusClass, type SaveStatus } from "./saveStatus";

/**
 * "Start new points year": blanks every sport's IHG result and closes points
 * entry. Types, caps, waivers, flat values and the default range are kept.
 * Confirmed first; the result is stated inline once the settings are re-read.
 */
export default function NewYearPanel({
  ihgResultCount,
  entryOpen,
  onChanged,
}: {
  ihgResultCount: number;
  entryOpen: boolean;
  onChanged: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState<SaveStatus | null>(null);

  const start = api.ccaPoints.startNewPointsYear.useMutation({
    onSuccess: async (result) => {
      setConfirming(false);
      const reloaded = await onChanged();
      setSaved(
        saveStatus(
          `Cleared ${result.cleared} IHG results. Points entry is now closed.`,
          reloaded,
        ),
      );
    },
  });

  const nothingToDo = ihgResultCount === 0 && !entryOpen;

  return (
    <section className="rounded-xl bg-white p-6 shadow-lg">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">
        New points year
      </h3>
      <p className="mb-4 max-w-3xl text-xs text-gray-500">
        At the start of a new points year, clear last year&rsquo;s IHG results
        and close points entry. Types, IHG caps, waivers, flat values and the
        default range are kept. Heads&rsquo; unsaved drafts stay in their own
        browsers.
      </p>

      <Button
        variant="outline"
        disabled={nothingToDo}
        onClick={() => {
          start.reset();
          setSaved(null);
          setConfirming(true);
        }}
      >
        Start new points year
      </Button>

      {saved && (
        <p className={`mt-3 text-sm ${statusClass(saved)}`} role="status">
          {saved.text}
        </p>
      )}

      <AlertDialog
        open={confirming}
        onOpenChange={(o) => {
          if (!o && !start.isPending) setConfirming(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new points year?</AlertDialogTitle>
            <AlertDialogDescription>
              This blanks the IHG result of every sports CCA ({ihgResultCount}{" "}
              set today) and closes points entry. Types, caps, waivers, flat
              values and the default range are not touched. Saved to the audit
              log with your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {start.error && (
            <p className="text-sm text-red-700" role="alert">
              {pointsErrorCopy(start.error.message, start.error.data?.code)}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={start.isPending}>
              Cancel
            </AlertDialogCancel>
            <button
              type="button"
              disabled={start.isPending}
              onClick={() => start.mutate()}
              className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:pointer-events-none disabled:opacity-50"
            >
              {start.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Yes, start it"
              )}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
