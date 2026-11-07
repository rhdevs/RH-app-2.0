"use client";

import Link from "next/link";
import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { broadcastHref } from "~/lib/reminders/links";
import { reminderErrorMessage } from "~/lib/reminders/errors";
import {
  REMINDER_MESSAGE_MAX,
  REMINDER_TITLE_MAX,
} from "~/lib/schemas/reminder";

const fieldClass =
  "rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600";

/**
 * Deadline broadcasts on the director's home: a send form and the list of
 * broadcasts this person's CCAs are on. NOT a guard: every procedure checks the
 * switch and who may act. A person who directs no CCA (or while reminders are
 * off) sees nothing here, apart from a one-line note while the switch is off.
 */
export default function BroadcastsSection() {
  const enabled = api.reminder.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const choices = api.reminder.ccaChoices.useQuery(undefined, {
    retry: false,
    enabled: on,
  });
  const box = api.reminder.outbox.useQuery(undefined, {
    retry: false,
    enabled: on && choices.isSuccess,
  });

  if (enabled.isLoading || !enabled.data) return null;
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Deadline reminders are not switched on yet.
      </p>
    );
  }
  if (!choices.data) return null;

  return (
    <section aria-labelledby="director-broadcasts" className="space-y-4">
      <h2
        id="director-broadcasts"
        className="text-sm font-semibold text-gray-900"
      >
        Deadline reminders
      </h2>
      <SendForm choices={choices.data} />
      {box.isError ? (
        <p role="alert" className="text-sm text-red-600">
          Could not load your reminders. Try again shortly.
        </p>
      ) : box.data ? (
        box.data.items.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
            You have not sent any reminders.
          </p>
        ) : (
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
            {box.data.items.map((b) => (
              <li key={b.id}>
                <Link
                  href={broadcastHref(b.id)}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 focus-visible:bg-gray-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900">
                      {b.title}
                    </span>
                    <span className="block text-xs text-gray-500">
                      Due {b.deadline}
                      {b.status === "cancelled" ? " · Cancelled" : ""}
                    </span>
                  </span>
                  <span className="text-xs text-gray-700">
                    {b.done} of {b.total} CCAs done
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function SendForm({ choices }: { choices: { ccaID: number; name: string }[] }) {
  const utils = api.useUtils();
  const [picked, setPicked] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [deadline, setDeadline] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const send = api.reminder.send.useMutation({
    onSuccess: (res) => {
      setError(null);
      setSent(
        `Sent to ${res.targets} ${res.targets === 1 ? "CCA" : "CCAs"}; ${res.notified} ${res.notified === 1 ? "head was" : "heads were"} told.`,
      );
      setTitle("");
      setMessage("");
      setDeadline("");
      setPicked([]);
      void utils.reminder.outbox.invalidate();
    },
    onError: (e) => {
      setSent(null);
      setError(reminderErrorMessage(e.message));
    },
  });
  const toggle = (id: number) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const ready = picked.length > 0 && title.trim() !== "" && deadline !== "";

  return (
    <form
      className="space-y-3 rounded-lg border border-gray-200 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSent(null);
        send.mutate({ ccaIDs: picked, title, message, deadline });
      }}
    >
      <fieldset>
        <legend className="mb-1 text-xs text-gray-600">
          Send to the heads of
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {choices.map((c) => (
            <label key={c.ccaID} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(c.ccaID)}
                onChange={() => toggle(c.ccaID)}
              />
              {c.name}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block text-xs text-gray-600">
        Title
        <input
          className={`${fieldClass} mt-1 block w-full`}
          maxLength={REMINDER_TITLE_MAX}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block text-xs text-gray-600">
        Message (optional)
        <textarea
          className={`${fieldClass} mt-1 block w-full`}
          rows={3}
          maxLength={REMINDER_MESSAGE_MAX}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <label className="block text-xs text-gray-600">
        Deadline
        <input
          type="date"
          className={`${fieldClass} mt-1 block`}
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!ready || send.isPending}>
          {send.isPending ? "Sending…" : "Send reminder"}
        </Button>
        <p className="text-xs text-gray-500">
          Heads get a notice now, and again 3 days and 1 day before the deadline
          until they mark it done.
        </p>
      </div>
      {sent && (
        <p role="status" className="text-xs text-gray-700">
          {sent}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </form>
  );
}
