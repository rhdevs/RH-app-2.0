"use client";

import Link from "next/link";
import { Plus, CalendarDays, Users } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { formatDateTime, STATUS_META } from "~/app/events/_lib/format";

/**
 * The owner's list of their events. Every card links into the manage page, where
 * the flow depends on the event's status. NOT a guard — listForOwner carries the
 * object-scoped check.
 *
 * `ccaID` null means the HALL-WIDE events, owned by the JCRC and authored at
 * /admin/events/hall. One component serves both surfaces; the hrefs are passed
 * in rather than derived, because a hall event has no /cca/{id} route.
 *
 * A `draft` row is rendered as unfinished WORK, not as a neutral card: the badge
 * reads "Not submitted" (see STATUS_META) and the row carries a "Finish and
 * submit" affordance. A head is never parked in draft believing they are done.
 * A `submitted` row is deliberately NOT actionable from here — it links to the
 * manage page, where Withdraw lives.
 */
export default function EventsListPanel({
  ccaID,
  newHref,
  manageHref,
}: {
  ccaID: number | null;
  newHref: string;
  manageHref: (eventID: number) => string;
}) {
  const list = api.event.listForOwner.useQuery({ ccaID }, { retry: false });

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
            : msg === "CAPABILITY_REQUIRED:manageHallEvents"
              ? "You can’t manage hall events."
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
          <Link href={newHref}>
            <Plus className="mr-1.5 h-4 w-4" />
            New event
          </Link>
        </Button>
      </div>

      {events.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center">
          <CalendarDays className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-2 text-sm font-medium text-gray-900">
            Nothing here yet
          </p>
          {/* HALL-AWARE. §8.2 froze the review sentence for the CCA head's
              list, and that sentence became untrue the moment this component
              was reused for the JCRC's own hall events (ccaID null): those
              never enter the review queue — "Register and publish" submits and
              approves back to back. Promising a review that will not happen is
              the same copy-drift class the rest of this file guards against. */}
          <p className="mt-1 text-sm text-gray-500">
            {ccaID == null
              ? "Add the event’s details, a banner and a description, then register and publish it."
              : "Add your event’s details, a banner and a description, and JCRC will review it."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const meta = STATUS_META[e.status];
            return (
              <li key={e.eventID}>
                <Link
                  href={manageHref(e.eventID)}
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
                    {/* An unsubmitted event is unfinished WORK. Saying so here,
                        with a verb, is what stops a head leaving one parked. */}
                    {e.status === "draft" && (
                      <p className="mt-1 text-xs font-medium text-emerald-700">
                        Finish and submit
                      </p>
                    )}
                    {/* The rejection split: changes_requested is ACTIONABLE and
                        amber, declined is TERMINAL and grey. One word each,
                        because they are two different answers. */}
                    {e.status === "changes_requested" && e.decisionReason && (
                      <p className="mt-1 text-xs text-orange-700">
                        JCRC asked for changes: {e.decisionReason}
                      </p>
                    )}
                    {e.status === "declined" && e.decisionReason && (
                      <p className="mt-1 text-xs text-gray-500">
                        JCRC declined this: {e.decisionReason}
                      </p>
                    )}
                  </div>
                  {e.status === "published" && (
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
