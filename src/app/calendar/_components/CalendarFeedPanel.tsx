"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";

const NOTICES: Record<string, string> = {
  CALENDAR_FEED_DISABLED: "Calendar links are switched off right now.",
  FEED_TOKEN_EXISTS: "You already have a link. Rotate it to get a new one.",
  FEED_TOKEN_MISSING: "You have no link to rotate. Make one first.",
};

function describeFailure(message: string | undefined): string {
  if (message?.startsWith("RATE_LIMITED")) {
    return "Too many changes just now. Try again in a while.";
  }
  return (message && NOTICES[message]) ?? "Something went wrong. Try again.";
}

const feedUrl = (token: string) =>
  `${window.location.origin}/api/calendar/feed/${token}.ics`;

/**
 * Subscribe settings. Hidden while `calendar.feed.enabled` is off, and if the
 * status cannot be read (fail closed). The link is shown ONCE, right after it
 * is made or rotated, and exists nowhere else: the server keeps only a hash.
 */
export default function CalendarFeedPanel() {
  const utils = api.useUtils();
  const status = api.calendar.feedStatus.useQuery(undefined, { retry: false });
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const done = (token?: string) => {
    setMessage(null);
    setCopied(false);
    setSecret(token ?? null);
    void utils.calendar.feedStatus.invalidate();
  };
  const failed = (e: { message: string }) =>
    setMessage(describeFailure(e.message));
  const create = api.calendar.feedCreate.useMutation({
    onSuccess: (r) => done(r.token),
    onError: failed,
  });
  const rotate = api.calendar.feedRotate.useMutation({
    onSuccess: (r) => done(r.token),
    onError: failed,
  });
  const revoke = api.calendar.feedRevoke.useMutation({
    onSuccess: () => done(),
    onError: failed,
  });
  const busy = create.isPending || rotate.isPending || revoke.isPending;

  if (!status.data?.enabled) return null;
  const { hasToken } = status.data;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
      setMessage("Could not copy. Select the link and copy it by hand.");
    }
  };

  return (
    <section
      aria-labelledby="calendar-feed-heading"
      className="rounded-lg border border-gray-200 bg-white p-4"
    >
      <h2
        id="calendar-feed-heading"
        className="text-base font-semibold text-gray-900"
      >
        Subscribe in your calendar app
      </h2>
      <p className="mt-1 text-sm text-gray-600">
        A personal link that Google Calendar, Apple Calendar or Outlook can
        subscribe to. It shows the same events as this page and, if you head or
        direct a CCA, that CCA&apos;s proposals.
      </p>
      <p
        role="note"
        className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        Anyone who has this link can read this calendar, with no sign-in. Do not
        share it or post it anywhere. If it leaks, rotate it or revoke it.
      </p>

      {secret ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium text-gray-900">
            Your link. It is shown only now; copy it before you leave.
          </p>
          <input
            readOnly
            value={feedUrl(secret)}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Your calendar link"
            className="w-full rounded-md border border-gray-300 px-2 py-1 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void copy(feedUrl(secret))}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => done()}>
              I have copied it
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hasToken ? (
          <>
            <p className="mr-2 text-sm text-gray-600">
              You have a link. It cannot be shown again.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Rotate the link? The old link stops working at once, and you will need to subscribe again with the new one.",
                  )
                ) {
                  rotate.mutate();
                }
              }}
            >
              Rotate link
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Revoke the link? Calendars subscribed with it stop updating.",
                  )
                ) {
                  revoke.mutate();
                }
              }}
            >
              Revoke link
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => create.mutate()}>
            Make my link
          </Button>
        )}
      </div>

      {message ? (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {message}
        </p>
      ) : null}
    </section>
  );
}
