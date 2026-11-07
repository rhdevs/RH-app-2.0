"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  dayKeyOfEpoch,
  formatSgtClock,
  monthOfDayKey,
  monthTitle,
  shiftMonth,
  todayKey,
} from "~/lib/calendar/month";
import {
  isProposalStatus,
  PROPOSAL_STATUS_LABELS,
} from "~/lib/proposals/status";
import { directorProposalHref, headProposalHref } from "~/lib/proposals/links";

type Month = RouterOutputs["calendar"]["month"];
type EventItem = Extract<Month["events"], { state: "ok" }>["items"][number];
type ProposalItem = Extract<
  Month["proposals"],
  { state: "ok" }
>["items"][number];

type Entry =
  | { kind: "event"; at: number; item: EventItem }
  | { kind: "proposal"; at: number; item: ProposalItem };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const entryKey = (e: Entry) =>
  e.kind === "event" ? `event-${e.item.eventID}` : `proposal-${e.item.id}`;

function EntryChip({ entry }: { entry: Entry }) {
  const time = formatSgtClock(entry.at);
  if (entry.kind === "event") {
    return (
      <Link
        href={`/events/${entry.item.eventID}`}
        className="block rounded border border-emerald-200 bg-emerald-50 px-1.5 py-1 text-xs text-emerald-900 hover:bg-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600"
      >
        <span className="font-medium">{time}</span> {entry.item.title}
        <span className="block text-[11px] text-emerald-700">
          {entry.item.owner}
        </span>
      </Link>
    );
  }
  const p = entry.item;
  const href =
    p.viewer === "director"
      ? directorProposalHref(p.id)
      : headProposalHref(p.ccaID, p.id);
  const label = isProposalStatus(p.status)
    ? PROPOSAL_STATUS_LABELS[p.status]
    : p.status;
  return (
    <Link
      href={href}
      className="block rounded border border-dashed border-amber-400 bg-white px-1.5 py-1 text-xs text-amber-900 hover:bg-amber-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-600"
    >
      <span className="font-medium">{time}</span> {p.title}
      <span className="block text-[11px] text-amber-700">
        Proposal, {label} · {p.owner}
      </span>
    </Link>
  );
}

function LayerNotice({ name, state }: { name: string; state: string }) {
  if (state !== "error") return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      Could not load {name}. What is shown below may be missing some. Try again
      shortly.
    </p>
  );
}

/**
 * A month of published Events, and, for heads and directors while proposals
 * are on, a dashed layer of proposals that have planned dates. Days are
 * Singapore days and times are Singapore time. "Today" comes from the same
 * helper the server uses (`sgtDayKey`). A layer that failed to load says so;
 * it is never drawn as an empty layer.
 */
export default function CalendarView() {
  const today = todayKey();
  const [shown, setShown] = useState(() => monthOfDayKey(today));
  const query = api.calendar.month.useQuery(shown, {
    retry: false,
    placeholderData: (prev) => prev,
  });

  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    const add = (entry: Entry) => {
      const key = dayKeyOfEpoch(entry.at);
      map.set(key, [...(map.get(key) ?? []), entry]);
    };
    const data = query.data;
    if (data?.events.state === "ok") {
      for (const item of data.events.items) {
        add({ kind: "event", at: item.startTime, item });
      }
    }
    if (data?.proposals.state === "ok") {
      for (const item of data.proposals.items) {
        add({ kind: "proposal", at: item.plannedStart, item });
      }
    }
    for (const list of map.values()) list.sort((a, b) => a.at - b.at);
    return map;
  }, [query.data]);

  const move = (by: 1 | -1) => setShown((s) => shiftMonth(s.year, s.month, by));
  const days = query.data?.days ?? [];
  const agendaDays = days.filter((d) => byDay.has(d));

  return (
    <section aria-labelledby="calendar-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1
          id="calendar-heading"
          className="text-2xl font-semibold text-gray-900"
        >
          Calendar
        </h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => move(-1)}
            aria-label="Previous month"
          >
            Prev
          </Button>
          <span
            className="min-w-36 text-center text-sm font-medium text-gray-900"
            aria-live="polite"
          >
            {monthTitle(shown.year, shown.month)}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => move(1)}
            aria-label="Next month"
          >
            Next
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShown(monthOfDayKey(todayKey()))}
          >
            Today
          </Button>
        </div>
      </div>

      {query.isError ? (
        <p role="alert" className="text-sm text-red-600">
          Could not load the calendar. Try again shortly.
        </p>
      ) : !query.data ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <>
          <LayerNotice name="the events" state={query.data.events.state} />
          <LayerNotice
            name="your proposals"
            state={query.data.proposals.state}
          />
          {query.data.events.state === "off" ? (
            <p className="text-sm text-gray-600">
              Events are not switched on yet, so there is nothing to show here.
            </p>
          ) : null}

          {/* Narrow screens: only the days that have something. */}
          <ol className="space-y-3 sm:hidden">
            {agendaDays.length === 0 ? (
              <li className="text-sm text-gray-500">Nothing this month.</li>
            ) : (
              agendaDays.map((d) => (
                <li key={d}>
                  <h2
                    className={`mb-1 text-sm font-semibold ${
                      d === today ? "text-emerald-700" : "text-gray-900"
                    }`}
                  >
                    {d}
                    {d === today ? " (today)" : ""}
                  </h2>
                  <div className="space-y-1">
                    {(byDay.get(d) ?? []).map((e) => (
                      <EntryChip key={entryKey(e)} entry={e} />
                    ))}
                  </div>
                </li>
              ))
            )}
          </ol>

          {/* Wider screens: the month as weeks, Monday first. */}
          <div
            className="hidden overflow-hidden rounded-lg border border-gray-200 bg-white sm:block"
            role="grid"
            aria-label={monthTitle(shown.year, shown.month)}
          >
            <div className="grid grid-cols-7 border-b border-gray-200 bg-gray-50 text-xs font-medium text-gray-600">
              {WEEKDAYS.map((w) => (
                <div key={w} className="px-2 py-1" role="columnheader">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const inMonth = Number(d.slice(5, 7)) === shown.month;
                const isToday = d === today;
                return (
                  <div
                    key={d}
                    role="gridcell"
                    aria-current={isToday ? "date" : undefined}
                    className={`min-h-24 space-y-1 border-b border-r border-gray-100 p-1 ${
                      inMonth ? "bg-white" : "bg-gray-50"
                    }`}
                  >
                    <div
                      className={`text-xs ${
                        isToday
                          ? "inline-block rounded-full bg-emerald-600 px-1.5 font-semibold text-white"
                          : inMonth
                            ? "text-gray-700"
                            : "text-gray-400"
                      }`}
                    >
                      {Number(d.slice(8, 10))}
                    </div>
                    {(byDay.get(d) ?? []).map((e) => (
                      <EntryChip key={entryKey(e)} entry={e} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-gray-500">
            All times are Singapore time.
            {query.data.proposals.state === "ok"
              ? " Dashed entries are proposals that are not yet published events; only people who can read the proposal see them."
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
