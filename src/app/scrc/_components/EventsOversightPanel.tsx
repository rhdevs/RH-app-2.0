"use client";

import { useState } from "react";
import { CalendarClock, ChevronRight } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { EVENT_STATUSES, ownerLabel, type EventStatus } from "~/lib/schemas/event";
import {
  formatDateRange,
  formatDateTime,
  STATUS_META,
} from "~/app/events/_lib/format";

import DisabledNotice, { disabledCopy } from "./DisabledNotice";

/**
 * The hall office watching the events pipeline. READ-ONLY, ALL THE WAY DOWN.
 *
 * THERE ARE NO Approve / Reject / Publish / Cancel / Export CONTROLS HERE, AND
 * THERE MUST NOT BE. Every one of those is a decision with a named owner:
 * approve and reject belong to the JCRC (event.decide, reviewEvents); publish
 * and cancel belong to the CCA head who proposed the event; the attendee export
 * is head-scoped because it is a list of residents' contact details. The server
 * agrees — there is deliberately no getForOversight counterpart to `decide` —
 * so a button added here would only produce a FORBIDDEN and an audit row. The
 * point of oversight is to see what is happening, not to take part in it.
 *
 * The status label vocabulary is imported (EVENT_STATUSES + STATUS_META) rather
 * than retyped, so the filter cannot drift from normalizeStatus'. Note the
 * spelling: "canceled", one l.
 */

const ALL = "all" as const;

function StatusPill({ status }: { status: EventStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* One event                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * TWO LAYERS, AND BOTH ARE MEANT TO HOLD.
 *
 * The SERVER is the boundary: `event.getForOversight` nulls five fields for the
 * hall-office tier — `description`, `decisionReason`, `createdBy`, `decidedBy`,
 * `updatedBy` (SCRC_HIDDEN_EVENT_FIELDS in routers/event.ts). The first two are
 * the head's internal write-up and the reviewer's private feedback; the last
 * three each hold a canonical E-format userID, which is an email address one
 * derivation later. An admin viewing this same page is a manager and receives
 * them unredacted.
 *
 * This component is the SECOND layer, and it names every field it renders rather
 * than spreading the record, so a field that is un-redacted server-side later —
 * or that arrives in full because the viewer is an admin — still does not reach
 * the DOM by accident. NOTHING IS SPREAD. Do not reach for `{...event}`.
 *
 * Deliberately not rendered, beyond the six the server already blanks:
 *
 *   bookingID /      facility-booking plumbing, meaningless outside the head's
 *   autoBookFailed   own dashboard where it is actionable
 *
 * If one of those is genuinely needed later, add it deliberately with a reason,
 * one field at a time — and if it is one of the six, un-redact it on the server
 * first, because rendering it here would otherwise just print null.
 */
function EventOversightDetail({
  eventID,
  onBack,
}: {
  eventID: number;
  onBack: () => void;
}) {
  const { data, isPending, error } = api.event.getForOversight.useQuery(
    { eventID },
    { retry: false },
  );

  const back = (
    <button
      type="button"
      onClick={onBack}
      className="text-sm text-emerald-700 hover:underline"
    >
      ← Back to all events
    </button>
  );

  if (isPending) {
    return (
      <div className="space-y-3">
        {back}
        <div className="h-64 animate-pulse rounded-xl bg-gray-200" />
      </div>
    );
  }

  if (error || !data) {
    if (error && disabledCopy(error.message)) {
      return <DisabledNotice message={error.message} />;
    }
    return (
      <div className="space-y-3">
        {back}
        <div className="rounded-xl bg-white p-6 shadow-lg">
          <p className="text-sm text-gray-900">
            {error?.message === "NO_SUCH_EVENT"
              ? "This event no longer exists."
              : "This event couldn’t be loaded."}
          </p>
        </div>
      </div>
    );
  }

  const { event, ccaName } = data;

  return (
    <div className="max-w-3xl space-y-5">
      {back}

      <div className="rounded-xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold text-gray-900">
            {event.title?.trim() || "Untitled event"}
          </h2>
          <StatusPill status={event.status} />
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {ownerLabel(event.ccaID, ccaName)}
        </p>

        <dl className="mt-4 grid gap-3 border-t border-gray-100 pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-gray-500">When</dt>
            {/* startTime/endTime are UNIX epoch SECONDS, not Dates — formatDateRange
                multiplies by 1000. Handing them straight to new Date() would put
                every event in January 1970. */}
            <dd className="text-gray-900">
              {formatDateRange(event.startTime, event.endTime)}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Where</dt>
            <dd className="text-gray-900">{event.location ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Capacity</dt>
            <dd className="text-gray-900">
              {event.capacity != null ? event.capacity : "Unlimited"}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Last updated</dt>
            {/* updatedAt IS a Date (a Prisma DateTime), unlike startTime. The two
                conventions sit side by side in one row; do not "tidy" them into
                one helper. */}
            <dd className="text-gray-900">
              {event.updatedAt
                ? event.updatedAt.toLocaleString("en-SG", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                    hour12: true,
                  })
                : "—"}
            </dd>
          </div>
        </dl>

        {/* The RESIDENT-FACING blurb (publicDescription), never the head's
            internal `description`. Only exists once a head has published. */}
        {event.publicDescription?.trim() && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <p className="text-sm text-gray-500">What residents see</p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">
              {event.publicDescription}
            </p>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400">
        This is a read-only view. Approving, requesting changes, declining and
        cancelling stay with the JCRC and the CCA head.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The list                                                                    */
/* -------------------------------------------------------------------------- */

export default function EventsOversightPanel() {
  const [status, setStatus] = useState<EventStatus | typeof ALL>(ALL);
  const [openEvent, setOpenEvent] = useState<number | null>(null);

  // PAGED. listForOversight is cursor-paged over the whole Event collection, so
  // a plain useQuery would silently show only the first page and quietly hide
  // every older event — the failure mode that looks exactly like "there aren't
  // any". Paging follows nextCursor and nothing else.
  const {
    data,
    isPending,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = api.event.listForOversight.useInfiniteQuery(
    { status: status === ALL ? undefined : status },
    {
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      retry: false,
    },
  );

  if (openEvent !== null) {
    return (
      <EventOversightDetail
        eventID={openEvent}
        onBack={() => setOpenEvent(null)}
      />
    );
  }

  // Both kill switches land here — `events.enabled` is checked before
  // `scrc.enabled`, so either can be the reason, and each has its own copy.
  if (error && disabledCopy(error.message)) {
    return <DisabledNotice message={error.message} />;
  }

  const events = data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Events</h2>
          <p className="mt-1 text-sm text-gray-500">
            Every event in the hall, most recently touched first.
          </p>
        </div>
        <Select
          value={status}
          onValueChange={(v) => setStatus(v as EventStatus | typeof ALL)}
        >
          <SelectTrigger className="w-full bg-white sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {EVENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* KNOWN, and the server documents it: listForOversight filters the RAW
          `status` column, while the status it returns is normalizeStatus'd.
          Event.status is a nullable String, and normalizeStatus maps null to
          "draft" — so a row stored as null reads "Not submitted" in this list
          (STATUS_META relabelled draft; the word "Draft" is no longer shown
          anywhere) but will NOT appear under that filter. Left alone deliberately upstream;
          said out loud here so the next person does not file it as a bug. */}
      {status === "draft" && (
        <p className="text-xs text-gray-400">
          Older events with no status recorded show as “Not submitted” in the
          full list, but don’t match this filter. Choose “All statuses” to see
          them.
        </p>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="flex items-center justify-between gap-4 text-sm text-red-800">
            <span>The events list couldn’t be loaded.</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </p>
        </div>
      )}

      {isPending && <div className="h-48 animate-pulse rounded-xl bg-gray-200" />}

      {!isPending && !error && events.length === 0 && (
        <div className="rounded-xl bg-white p-10 text-center shadow-lg">
          <CalendarClock className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-2 text-sm font-medium text-gray-900">
            Nothing to show
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {/* The label is a STATE NAME, not an adjective — "Not submitted",
                "Changes needed", "In review" — so the old "No events are
                {label} right now" produced "No events are not submitted right
                now", a double negative that reads as its own opposite. Quote
                the label instead of trying to inflect it. */}
            {status === ALL
              ? "No events have been created yet."
              : `No events are in the “${STATUS_META[status].label}” state right now.`}
          </p>
        </div>
      )}

      {events.length > 0 && (
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.eventID}>
              <button
                type="button"
                onClick={() => setOpenEvent(e.eventID)}
                className="flex w-full items-center gap-4 rounded-xl bg-white p-4 text-left shadow-sm ring-1 ring-gray-100 transition hover:ring-emerald-200"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold text-gray-900">
                    <span className="truncate">
                      {e.title?.trim() || "Untitled event"}
                    </span>
                    <StatusPill status={e.status} />
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {ownerLabel(e.ccaID, e.ccaName)} ·{" "}
                    {/* epoch SECONDS — formatDateTime does the ×1000. */}
                    {formatDateTime(e.startTime)}
                    {e.location ? ` · ${e.location}` : ""}
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-gray-300" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {hasNextPage && (
        <div className="pt-2 text-center">
          <Button
            variant="outline"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
