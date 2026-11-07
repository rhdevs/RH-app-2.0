"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { reminderErrorMessage } from "~/lib/reminders/errors";

type Item = {
  broadcastID: string;
  ccaID: number;
  ccaName: string | null;
  title: string;
  message: string;
  deadline: string;
  daysLeft: number;
  done: boolean;
};

const dueText = (daysLeft: number) =>
  daysLeft < 0
    ? "Past the deadline"
    : daysLeft === 0
      ? "Due today"
      : daysLeft === 1
        ? "Due tomorrow"
        : `Due in ${daysLeft} days`;

/**
 * The heads' view: deadline reminders for the CCAs this person heads, with a
 * button to mark each done. NOT a guard: `reminder.mine` and `markDone` check
 * the switch and the stored head rows, and a head of another CCA is refused.
 * Server text is rendered as React text.
 */
export default function RemindersScreen() {
  const enabled = api.reminder.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const mine = api.reminder.mine.useQuery(undefined, {
    retry: false,
    enabled: on,
  });

  if (enabled.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Deadline reminders are not switched on yet.
      </p>
    );
  }
  if (mine.isLoading) {
    return <p className="text-sm text-gray-500">Loading reminders…</p>;
  }
  if (mine.isError || !mine.data) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not load your reminders. Try again shortly.
      </p>
    );
  }
  const { items, skipped, isHead } = mine.data;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-gray-900">Reminders</h1>
      {!isHead ? (
        <p className="text-sm text-gray-600">
          Reminders go to the heads of a CCA. You are not a head of one right
          now.
        </p>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
          Nothing is due.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
          {items.map((i) => (
            <Row key={`${i.broadcastID}:${i.ccaID}`} item={i} />
          ))}
        </ul>
      )}
      {skipped > 0 && (
        <p className="text-xs text-gray-500">{skipped} could not be shown.</p>
      )}
    </div>
  );
}

function Row({ item }: { item: Item }) {
  const utils = api.useUtils();
  const [error, setError] = useState<string | null>(null);
  const markDone = api.reminder.markDone.useMutation({
    onSuccess: () => {
      setError(null);
      void utils.reminder.mine.invalidate();
      void utils.reminder.entry.invalidate();
    },
    onError: (e) => setError(reminderErrorMessage(e.message)),
  });
  const urgent = !item.done && item.daysLeft <= 1;

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900">{item.title}</p>
          <p className="text-xs text-gray-500">
            {item.ccaName ?? `CCA ${item.ccaID}`} · Deadline {item.deadline}
          </p>
          {item.message && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-gray-700">
              {item.message}
            </p>
          )}
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            item.done
              ? "bg-emerald-100 text-emerald-800"
              : urgent
                ? "bg-red-100 text-red-800"
                : "bg-gray-100 text-gray-700"
          }`}
        >
          {item.done ? "Done" : dueText(item.daysLeft)}
        </span>
      </div>
      {!item.done && (
        <Button
          size="sm"
          disabled={markDone.isPending}
          onClick={() =>
            markDone.mutate({
              broadcastID: item.broadcastID,
              ccaID: item.ccaID,
            })
          }
        >
          Mark done
        </Button>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}
