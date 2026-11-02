"use client";

import Link from "next/link";
import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { DIRECTOR_HOME_PATH } from "~/lib/reminders/links";
import { reminderErrorMessage } from "~/lib/reminders/errors";

/**
 * One broadcast with progress by CCA, for the CCAs this person directs. NOT a
 * guard: `reminder.get` answers a stranger and a missing id the same way, and
 * `canCancel` is the server's word (cancel is checked again when pressed).
 */
export default function BroadcastDetail({ id }: { id: string }) {
  const utils = api.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = api.reminder.get.useQuery({ id }, { retry: false });
  const cancel = api.reminder.cancel.useMutation({
    onSuccess: () => {
      setConfirming(false);
      setError(null);
      void utils.reminder.get.invalidate({ id });
      void utils.reminder.outbox.invalidate();
    },
    onError: (e) => setError(reminderErrorMessage(e.message)),
  });

  const back = (
    <Link href={DIRECTOR_HOME_PATH} className="text-sm underline">
      Back to the director&apos;s home
    </Link>
  );

  if (detail.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-red-600">
          {reminderErrorMessage(detail.error?.message ?? "")}
        </p>
        {back}
      </div>
    );
  }
  const b = detail.data;

  return (
    <div className="space-y-6">
      {back}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{b.title}</h1>
        <p className="text-sm text-gray-600">
          Due {b.deadline}
          {b.status === "cancelled" ? " · Cancelled" : ""}
        </p>
        {b.message && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-800">
            {b.message}
          </p>
        )}
      </div>

      <section aria-labelledby="broadcast-progress">
        <h2
          id="broadcast-progress"
          className="mb-2 text-sm font-semibold text-gray-900"
        >
          Progress by CCA
        </h2>
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
          {b.progress.map((p) => (
            <li
              key={p.ccaID}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <span className="text-sm text-gray-900">
                {p.ccaName ?? `CCA ${p.ccaID}`}
                <span className="block text-xs text-gray-500">
                  {p.heads === 0
                    ? "No heads on record"
                    : `${p.heads} ${p.heads === 1 ? "head" : "heads"}`}
                </span>
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  p.doneAt
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {p.doneAt
                  ? `Done${p.doneBy ? ` by ${p.doneBy}` : ""}`
                  : "Not done yet"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {b.canCancel &&
        (confirming ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-700">
              Cancel this reminder? Heads will stop getting nudges.
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ id })}
            >
              Yes, cancel it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(true)}
          >
            Cancel reminder
          </Button>
        ))}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
