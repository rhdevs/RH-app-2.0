"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
 * `manageHrefBase` is a STRING, not a builder function, and must stay one: the
 * CCA caller is a server component, and React refuses to serialise a function
 * across the server/client boundary ("Functions cannot be passed directly to
 * Client Components"). That throw happens at RENDER, so tsc, lint and
 * `next build` all pass while the route 500s. Every manage URL is
 * `base/{eventID}`, so a base path carries all the information a closure did.
 *
 * "NEW EVENT" IS A MUTATION, NOT A LINK (D-29). There is no /new route and no
 * create screen any more: the head keys EVERYTHING in on the manage page, which
 * already collects every field. The button creates the row and routes straight
 * to it.
 *
 * NOT a `useEffect` on a /new route, which is the shape this replaced (T-22):
 * React 18 StrictMode double-invokes effects in development, so a mount-time
 * `create.mutate` makes TWO events every time a developer opens the page, then
 * behaves correctly in production and ships; and the browser Back button
 * re-enters the route and makes a third in production too. A click has a pending
 * state, a place to render an error, and fires exactly once per press.
 *
 * A `draft` row is rendered as unfinished WORK, not as a neutral card: the badge
 * reads "Not submitted" (see STATUS_META) and the row carries a verb — "Finish
 * and submit", or "Start filling this in" when nothing has been typed yet
 * (D-31). A head is never parked in draft believing they are done. A `submitted`
 * row is deliberately NOT actionable from here — it links to the manage page,
 * where Withdraw lives.
 */
export default function EventsListPanel({
  ccaID,
  manageHrefBase,
}: {
  ccaID: number | null;
  manageHrefBase: string;
}) {
  const router = useRouter();
  const list = api.event.listForOwner.useQuery({ ccaID }, { retry: false });

  // A BARE create — no fields at all. The server reuses this caller's existing
  // blank draft for this scope rather than making a second one (D-30), so
  // pressing this ten times lands on the same row ten times.
  //
  // `ccaID` null is passed EXPLICITLY and means HALL-WIDE: createEventInput
  // declares it `.nullable().optional()`, and the server branches on
  // `input.ccaID == null` to require `manageHallEvents` instead of a headship.
  const create = api.event.create.useMutation({
    onSuccess: (res) => {
      router.push(`${manageHrefBase}/${res.eventID}`);
    },
  });

  // Moved from EventCreateForm, which this button replaces. All four codes are
  // reachable from `create`: the CCA can be deleted, the headship can be
  // revoked, the hall capability can be removed, and the kill switch can be
  // flipped — each between the page loading and the button being pressed.
  const createError = create.error
    ? create.error.message === "NO_SUCH_CCA"
      ? "This CCA no longer exists."
      : create.error.message === "NOT_A_HEAD_OF_THIS_CCA"
        ? "You’re no longer a head of this CCA."
        : create.error.message === "CAPABILITY_REQUIRED:manageHallEvents"
          ? "You can’t manage hall events."
          : create.error.message === "EVENTS_DISABLED"
            ? "Events aren’t switched on yet."
            : "That didn’t work. Try again."
    : null;

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
        {/* Stays "Creating…" through the router.push as well as the mutation:
            isPending goes false the moment onSuccess fires, and flipping the
            label back to "New event" while the browser is still navigating
            reads as a button that did nothing. A second press during that
            window is harmless either way — D-30 hands back the same row. */}
        <Button
          type="button"
          size="sm"
          disabled={create.isPending || create.isSuccess}
          onClick={() => create.mutate({ ccaID })}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          {create.isPending || create.isSuccess ? "Creating…" : "New event"}
        </Button>
      </div>

      {createError && <p className="text-sm text-red-600">{createError}</p>}

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
                  href={`${manageHrefBase}/${e.eventID}`}
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
                    {/* A row created by the "New event" button and then
                        abandoned has nothing on it, and "Date TBC" is a poor
                        thing to lead with. D-31 says such a row is rendered
                        HONESTLY rather than hidden — hiding it is how work gets
                        lost, since this is the only list that can reach it.

                        The sub-line swaps only when the row genuinely has
                        NOTHING to show. Keying it on the missing title alone
                        would print "Nothing filled in yet" directly above a date
                        and a location the head had already saved, which is the
                        copy-drift class the rest of this file guards against. */}
                    {e.status === "draft" &&
                    !e.title?.trim() &&
                    e.startTime == null &&
                    !e.location ? (
                      <p className="mt-0.5 text-xs text-gray-500">
                        Nothing filled in yet
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-gray-500">
                        {formatDateTime(e.startTime)}
                        {e.location ? ` · ${e.location}` : ""}
                      </p>
                    )}
                    {/* An unsubmitted event is unfinished WORK. Saying so here,
                        with a verb, is what stops a head leaving one parked —
                        and the verb differs, because "Finish and submit" is a
                        lie about a row with nothing in it. */}
                    {e.status === "draft" && (
                      <p className="mt-1 text-xs font-medium text-emerald-700">
                        {e.title?.trim()
                          ? "Finish and submit"
                          : "Start filling this in"}
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
