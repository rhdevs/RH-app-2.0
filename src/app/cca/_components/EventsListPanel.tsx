"use client";

import Link from "next/link";
import { Plus, CalendarDays, Users } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { formatDateTime, STATUS_META } from "~/app/events/_lib/format";

/**
 * The head's list of their CCA's events. Every card links into the manage page,
 * where the flow depends on the event's status. NOT a guard — listMineForCca
 * carries the object-scoped check.
 */
export default function EventsListPanel({ ccaID }: { ccaID: number }) {
  const list = api.event.listMineForCca.useQuery({ ccaID }, { retry: false });

  if (list.isPending) {
    return <div className="h-48 animate-pulse rounded-lg bg-gray-200" />;
  }

  if (list.error) {
    const msg = list.error.message;
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
        <p className="text-sm font-medium text-gray-900">
          {msg === "NOT_A_HEAD_OF_THIS_CCA"
            ? "You don’t have access to this CCA’s events."
            : msg === "EVENTS_DISABLED"
              ? "Events aren’t switched on yet."
              : "These events couldn’t be loaded. Reload the page."}
        </p>
      </div>
    );
  }

  const events = list.data.events;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {events.length === 0
            ? "No events yet."
            : `${events.length} event${events.length === 1 ? "" : "s"}`}
        </p>
        <Button asChild size="sm">
          <Link href={`/cca/${ccaID}/events/new`}>
            <Plus className="mr-1.5 h-4 w-4" />
            New event
          </Link>
        </Button>
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
          <CalendarDays className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-2 text-sm font-medium text-gray-900">
            Propose your first event
          </p>
          <p className="mt-1 text-sm text-gray-500">
            Add the details and a proposal, and JCRC will review it.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const meta = STATUS_META[e.status];
            return (
              <li key={e.eventID}>
                <Link
                  href={`/cca/${ccaID}/events/${e.eventID}`}
                  className="flex items-center gap-4 rounded-lg border border-gray-200 bg-white p-4 transition-colors hover:border-emerald-300 hover:bg-emerald-50/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-gray-900">
                        {e.title?.trim() || "Untitled event"}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
                      >
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {formatDateTime(e.startTime)}
                      {e.location ? ` · ${e.location}` : ""}
                    </p>
                    {e.status === "rejected" && e.decisionReason && (
                      <p className="mt-1 text-xs text-red-600">
                        JCRC: {e.decisionReason}
                      </p>
                    )}
                  </div>
                  {(e.status === "published" || e.status === "approved") && (
                    <div className="flex shrink-0 items-center gap-1 text-sm text-gray-600">
                      <Users className="h-4 w-4 text-gray-400" />
                      {e.signupCount}
                      {e.capacity != null ? `/${e.capacity}` : ""}
                    </div>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
