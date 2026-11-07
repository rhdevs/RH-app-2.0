"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { api } from "~/trpc/react";
import {
  ALL_EVENTS_FILTERS,
  ownerLabel,
  type AllEventsFilter,
} from "~/lib/schemas/event";
import { STATUS_META, formatDateRange } from "~/app/events/_lib/format";
import { PositionViewToggle, usePositionScope } from "../PositionView";

const FILTER_LABELS: Record<AllEventsFilter, string> = {
  published: "Upcoming",
  draft: "Drafts",
  past: "Past",
  canceled: "Cancelled",
};

/**
 * Every CCA's events, for the JCRC. Heads publish directly now, so this is
 * how the JCRC sees what is going on without a queue: a status filter
 * (server-side), the My positions switch (client-side, views only), and a
 * "New" badge on events no JCRC member has opened yet.
 *
 * Hall events are always shown: they belong to no CCA, so no position hides
 * them.
 */
export default function AllEventsPanel() {
  const [filter, setFilter] = useState<AllEventsFilter>("published");
  const list = api.event.listAll.useQuery({ filter }, { retry: false });
  const scope = usePositionScope("events");

  const events = list.data?.events ?? [];
  const shown = events.filter((e) => e.ccaID == null || scope.shows(e.ccaID));
  const hiddenCcas = new Set(
    events
      .filter((e) => e.ccaID != null && !scope.shows(e.ccaID))
      .map((e) => e.ccaID),
  ).size;

  return (
    <section aria-labelledby="all-events-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="all-events-heading"
            className="text-2xl font-semibold text-gray-900"
          >
            All events
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Every CCA&rsquo;s events. Open one to see it as its heads do.
          </p>
        </div>
        <PositionViewToggle state={scope} hiddenCount={hiddenCcas} />
      </div>

      <div
        role="group"
        aria-label="Event status"
        className="flex flex-wrap gap-1 border-b border-gray-200"
      >
        {ALL_EVENTS_FILTERS.map((f) => {
          const active = f === filter;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(f)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                active
                  ? "border-emerald-600 font-medium text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          );
        })}
      </div>

      {list.isPending ? (
        <div className="h-40 animate-pulse rounded-xl bg-gray-200" />
      ) : list.error ? (
        <p className="rounded-xl bg-white p-6 text-sm text-gray-900 shadow-sm">
          {list.error.message === "EVENTS_DISABLED"
            ? "Events aren’t switched on yet."
            : "Events couldn’t load."}
        </p>
      ) : shown.length === 0 ? (
        <p className="rounded-xl bg-white p-8 text-center text-sm text-gray-500 shadow-sm">
          {events.length > 0
            ? "None for your positions. Switch to All CCAs to see the rest."
            : `No ${FILTER_LABELS[filter].toLowerCase()} events.`}
        </p>
      ) : (
        <ul className="space-y-2">
          {shown.map((e) => {
            const meta = STATUS_META[e.status];
            const href =
              e.ccaID == null
                ? `/admin/events/hall/${e.eventID}`
                : `/cca/${e.ccaID}/events/${e.eventID}`;
            return (
              <li key={e.eventID}>
                <Link
                  href={href}
                  className="flex items-center gap-4 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100 transition hover:ring-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-gray-900">
                        {e.title?.trim() || "Untitled event"}
                      </p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.className}`}
                      >
                        {meta.label}
                      </span>
                      {e.isAux && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-800">
                          AUX
                        </span>
                      )}
                      {e.isNew && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                          New
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {ownerLabel(e.ccaID, e.ccaName)} ·{" "}
                      {formatDateRange(e.startTime, e.endTime)}
                      {e.location ? ` · ${e.location}` : ""}
                      {e.status === "published"
                        ? ` · ${e.signupCount} signed up`
                        : ""}
                    </p>
                    {e.cancelReason && (
                      <p className="mt-1 text-xs text-gray-600">
                        Cancelled: {e.cancelReason}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-gray-300" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
