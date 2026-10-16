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
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { pointsErrorCopy } from "./errorCopy";

/**
 * THE HALL-WIDE POINTS ENTRY SWITCH.
 *
 * CLOSED BY DEFAULT: until JCRC opens it, no leader can export. The card never
 * renders the new state optimistically — it states what the server stored and
 * only changes after the write has landed and been re-read, because a card that
 * says OPEN before it is, is the one lie that matters on a switch.
 *
 * Both directions go through a confirmation with an optional reason (saved to
 * the audit log). The gate on rendering this is cosmetic; setEntryOpen
 * re-checks `manageCcaPointsRanges` against a live role read. No toasts — the
 * Toaster is not mounted, so the result is stated inline.
 */
export default function EntrySwitchPanel({
  entryOpen,
  onChanged,
}: {
  entryOpen: boolean;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState<string | null>(null);

  const setOpen = api.ccaPoints.setEntryOpen.useMutation({
    onSuccess: async (result) => {
      setConfirming(false);
      setReason("");
      setSaved(
        result.entryOpen
          ? "Saved. Points entry is now open."
          : "Saved. Points entry is now closed.",
      );
      await onChanged();
    },
  });

  const target = !entryOpen;
  const close = () => {
    if (setOpen.isPending) return;
    setConfirming(false);
    setReason("");
    setOpen.reset();
  };

  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <section className="rounded-xl bg-white p-6 shadow-lg">
        <h3 className="mb-1 text-sm font-semibold text-gray-900">
          Points entry
        </h3>
        <p className="mb-5 max-w-3xl text-xs text-gray-500">
          One switch for the whole hall. While it is closed, CCA heads cannot
          export their points file. It starts closed. Points themselves never
          reach the server — this only controls whether the export is allowed.
        </p>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div aria-live="polite">
            <p className="flex items-center gap-2 text-2xl font-semibold text-gray-900">
              <span
                aria-hidden="true"
                className={`inline-flex h-3 w-3 rounded-full ${
                  entryOpen ? "bg-emerald-500" : "bg-gray-400"
                }`}
              />
              {entryOpen ? "OPEN" : "CLOSED"}
            </p>
            <p className="mt-1 max-w-lg text-sm text-gray-600">
              {entryOpen
                ? "Heads can export once their scores are complete and in range."
                : "Heads can look at their page but cannot export yet."}
            </p>
          </div>

          <AlertDialogTrigger asChild>
            <Button
              variant={entryOpen ? "outline" : "default"}
              onClick={() => {
                setOpen.reset();
                setSaved(null);
                setConfirming(true);
              }}
              className={
                entryOpen
                  ? "border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
                  : "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
              }
            >
              {entryOpen ? "Close points entry" : "Open points entry"}
            </Button>
          </AlertDialogTrigger>
        </div>

        {saved && !confirming && (
          <p className="mt-4 text-sm text-emerald-700" role="status">
            {saved}
          </p>
        )}

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {target
                ? "Open points entry for the whole hall?"
                : "Close points entry for the whole hall?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-gray-600">
                <p>
                  {target
                    ? "CCA heads will be able to export their points files as soon as their scores are complete and inside the allowed ranges."
                    : "CCA heads will no longer be able to export. Scores they have already typed stay in their own browser."}
                </p>
                <p>You can change this again at any time from this page.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-1.5">
            <label
              htmlFor="points-entry-reason"
              className="block text-sm font-medium text-gray-700"
            >
              Why (optional)
            </label>
            <textarea
              id="points-entry-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={setOpen.isPending}
              maxLength={500}
              rows={2}
              placeholder="e.g. Points window opens for AY26/27"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
            <p className="text-xs text-gray-500">
              Saved to the audit log with your name.
            </p>
          </div>

          {setOpen.error && (
            <p className="text-sm text-red-700" role="alert">
              {pointsErrorCopy(setOpen.error.message, setOpen.error.data?.code)}
            </p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={setOpen.isPending}>
              Cancel
            </AlertDialogCancel>
            {/* A plain <button>, not AlertDialogAction: Action closes the dialog
                the instant it is clicked, before the write resolves, which would
                throw away the error on failure. */}
            <button
              type="button"
              disabled={setOpen.isPending}
              onClick={() =>
                setOpen.mutate({
                  open: target,
                  reason: reason.trim() || undefined,
                })
              }
              className={`inline-flex h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 ${
                target
                  ? "bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500"
                  : "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
              }`}
            >
              {setOpen.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : target ? (
                "Yes, open it"
              ) : (
                "Yes, close it"
              )}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </section>
    </AlertDialog>
  );
}
