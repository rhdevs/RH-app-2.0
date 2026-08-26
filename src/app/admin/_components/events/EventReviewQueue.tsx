"use client";

import Link from "next/link";
import { CalendarClock, ChevronRight } from "lucide-react";

import { api } from "~/trpc/react";
import { formatDateTime } from "~/app/events/_lib/format";
import { ownerLabel } from "~/lib/schemas/event";

/**
 * The JCRC review queue: events awaiting a decision, oldest first. Rows link to
 * the detail page where the full event is reviewed and approved, sent back for
 * changes, or declined. NOT a guard — listForReview is roleManagerProcedure.
 */
export default function EventReviewQueue() {
  const list = api.event.listForReview.useQuery(undefined, { retry: false });

  if (list.isPending) {
    return <div className="h-48 animate-pulse rounded-xl bg-gray-200" />;
  }
  if (list.error) {
    return (
      <div className="rounded-xl bg-white p-6 shadow-lg">
        <p className="text-sm text-gray-900">
          {list.error.message === "EVENTS_DISABLED"
            ? "Events aren’t switched on yet."
            : "The review queue couldn’t load."}
        </p>
      </div>
    );
  }

  const events = list.data.events;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Event review</h2>
        <p className="mt-1 text-sm text-gray-500">
          {events.length === 0
            ? "Nothing waiting for review."
            : `${events.length} event${events.length === 1 ? "" : "s"} awaiting a decision.`}
        </p>
      </div>

      {events.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center shadow-lg">
          <CalendarClock className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-2 text-sm font-medium text-gray-900">
            The queue is empty
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Submitted events appear here for approval.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.eventID}>
              <Link
                href={`/admin/events/${e.eventID}`}
                className="flex items-center gap-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 transition hover:ring-emerald-200"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    {e.title?.trim() || "Untitled event"}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {ownerLabel(e.ccaID, e.ccaName)} · {formatDateTime(e.startTime)}
                    {e.location ? ` · ${e.location}` : ""}
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-gray-300" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
