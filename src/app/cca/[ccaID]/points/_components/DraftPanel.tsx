"use client";

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
import type { PointsState } from "./usePointsEntries";

const time = (d: Date): string =>
  d.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit" });

/**
 * Draft status, the dropped-members notice, and "Clear draft". The draft only
 * ever lives in this browser's storage.
 */
export default function DraftPanel({ state }: { state: PointsState }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-2 text-sm">
      {state.droppedCount > 0 && (
        <p
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
          role="status"
        >
          {state.droppedCount}{" "}
          {state.droppedCount === 1
            ? "member in your saved draft is"
            : "members in your saved draft are"}{" "}
          no longer on the roster and{" "}
          {state.droppedCount === 1 ? "was" : "were"} removed.
          <button
            type="button"
            onClick={state.dismissDropped}
            className="font-medium underline underline-offset-2"
          >
            OK
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-gray-600" aria-live="polite">
          {!state.draftsEnabled
            ? "Drafts can't be saved for this account."
            : state.saveFailed
              ? "Couldn't save the draft on this device. Keep this tab open until you export."
              : state.savedAt
                ? `Draft saved on this device · ${time(state.savedAt)}`
                : "Nothing saved yet."}
        </p>
        {state.draftsEnabled && state.savedAt && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded font-medium text-red-600 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Clear draft
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500">
        Drafts stay only in this browser. Clear it if you&rsquo;re on a shared
        computer.
      </p>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the draft on this device?</AlertDialogTitle>
            <AlertDialogDescription>
              Every score and role you have entered here will be removed from
              this browser. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <button
              type="button"
              onClick={() => {
                state.clearDraft();
                setConfirming(false);
              }}
              className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              Yes, clear it
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
