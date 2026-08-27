"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { api } from "~/trpc/react";
import { ownerLabel } from "~/lib/schemas/event";

/**
 * The JCRC's hall-wide view.
 *
 * A DATE RANGE, NOT A TERM. The brief asked for "every event this term" and this
 * repository has no notion of a term — no term, semester or academic-year model
 * exists anywhere in the schema. Inventing one would be a second calendar to
 * maintain, wrong the year the academic calendar shifts, and needed by nothing
 * else. A range is honest about what it is, is always correct, and can be
 * pointed at a term by whoever knows when it started.
 *
 * TURNOUT IS "—", NEVER "0%", WHEN NOTHING WAS SCANNED. An event that ran before
 * the door layer was switched on, or one where the committee never opened the
 * door page, has NO DATA — a different fact from nobody coming. A 0% printed
 * next to a well-attended event's name is a defamatory number about a CCA, and
 * this page is read by the people who allocate things.
 */

const DAY = 86_400;
const RANGES = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "Last 180 days", days: 180 },
  { label: "Last year", days: 365 },
] as const;

function fmtDate(sec: number | null): string {
  if (sec == null) return "Date TBC";
  return new Date(sec * 1000).toLocaleDateString("en-SG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function HallInsights() {
  // 180 days by default — long enough to cover a semester of events without
  // pretending to know when one started.
  const [days, setDays] = useState<number>(180);

  const { fromSec, toSec } = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    return { fromSec: now - days * DAY, toSec: now + 365 * DAY };
  }, [days]);

  const stats = api.event.getHallStats.useQuery(
    { fromSec, toSec },
    { retry: false },
  );

  if (stats.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-100" />;
  }
  if (stats.error || !stats.data) {
    return (
      <p className="text-sm text-red-700">
        Couldn&rsquo;t load the hall figures.
      </p>
    );
  }

  const { events, byCca, byWeek } = stats.data;

  const turnoutData = events
    .filter((e) => e.checkedIn > 0)
    .map((e) => ({
      name: (e.title ?? `#${e.eventID}`).slice(0, 18),
      signedUp: e.signups,
      turnedUp: e.checkedIn - e.walkIns,
      walkedIn: e.walkIns,
    }));

  const ccaData = byCca.map((c) => ({
    name: ownerLabel(c.ccaID, c.ccaName),
    events: c.events,
  }));

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            onClick={() => setDays(r.days)}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              days === r.days
                ? "border-gray-900 bg-gray-900 text-white"
                : "border-gray-300 text-gray-700"
            }`}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-gray-500">
          {events.length} {events.length === 1 ? "event" : "events"}
        </span>
      </div>
      {/*
        SAYING WHAT THE RANGE ACTUALLY IS. The buttons choose how far BACK to
        look; the window always runs forward to a year ahead as well, so that
        what is already scheduled shows up next to what has happened. Without
        this line "Last 30 days" is a label on a set that contains next
        semester's events, and the event count beside it looks wrong.
      */}
      <p className="-mt-6 text-xs text-gray-400">
        Counting back {days} days, plus everything already scheduled up to a
        year ahead. Events still to come have no turnout yet.
      </p>

      {events.length === 0 ? (
        <p className="text-sm text-gray-500">
          No events in this range. Try a longer one.
        </p>
      ) : (
        <>
          {/* ------------------------------------------------------ turnout */}
          <section>
            <h2 className="mb-1 text-base font-semibold text-gray-900">
              Turnout
            </h2>
            <p className="mb-3 text-sm text-gray-500">
              Only events where somebody was actually scanned in appear here.
            </p>
            {turnoutData.length === 0 ? (
              <p className="text-sm text-gray-500">
                Nothing has been scanned in this range. That isn&rsquo;t the
                same as nobody attending — door check-in may simply not have
                been used.
              </p>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={turnoutData}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="name" fontSize={11} interval={0} angle={-20} textAnchor="end" height={60} />
                    <YAxis allowDecimals={false} fontSize={11} width={32} />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="signedUp" name="Signed up" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="turnedUp" name="Turned up" fill="#059669" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="walkedIn" name="Walked in" fill="#2563eb" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {/* -------------------------------------------- who is running things */}
          <section>
            <h2 className="mb-3 text-base font-semibold text-gray-900">
              Who&rsquo;s running things
            </h2>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ccaData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} fontSize={11} />
                  <YAxis type="category" dataKey="name" width={140} fontSize={11} />
                  <Tooltip />
                  <Bar dataKey="events" name="Events" fill="#7c3aed" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* --------------------------------------------- calendar density */}
          <section>
            <h2 className="mb-3 text-base font-semibold text-gray-900">
              How busy the hall is
            </h2>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={byWeek}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="weekStart" fontSize={11} />
                  <YAxis allowDecimals={false} fontSize={11} width={28} />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="events"
                    name="Events that week"
                    stroke="#0284c7"
                    fill="#bae6fd"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* ------------------------------------------------------- table */}
          <section>
            <h2 className="mb-3 text-base font-semibold text-gray-900">
              Every event
            </h2>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Owner</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Event</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Date</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Status</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-600">Signed up</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-600">Checked in</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-600">Turnout</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {events.map((e) => (
                    <tr key={e.eventID}>
                      {/* ownerLabel on the PAIR, never `{ccaName && …}` — that
                          guard is how a hall event's owner silently vanishes. */}
                      <td className="px-3 py-2 text-gray-700">
                        {ownerLabel(e.ccaID, e.ccaName)}
                      </td>
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/events/${e.eventID}`}
                          className="text-blue-700 underline"
                        >
                          {e.title ?? `Event #${e.eventID}`}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-gray-600">{fmtDate(e.startTime)}</td>
                      <td className="px-3 py-2 text-gray-600">
                        {e.status === "canceled" ? "Cancelled" : "Published"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{e.signups}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {e.checkedIn === 0 ? "—" : e.checkedIn}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {/* "—" when nothing was scanned OR nobody signed up.
                            No data is not zero attendance. */}
                        {/* Clamped at 100: `signups` is the list as it is NOW
                            and `checkedIn - walkIns` is what was recorded at
                            the door, and cancelSignup has no time gate, so a
                            late withdrawal shrinks the denominator alone and
                            the raw ratio can exceed 1. "700%" beside a CCA's
                            name is worse than the rounding. */}
                        {e.checkedIn === 0 || e.signups === 0
                          ? "—"
                          : `${Math.min(
                              100,
                              Math.round(
                                ((e.checkedIn - e.walkIns) / e.signups) * 100,
                              ),
                            )}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/*
        D-77. Stated on this screen as well as the head's, because this is the
        one read by people who allocate rooms, budgets and slots — which is
        exactly where a turnout number would acquire a consequence nobody ever
        decided to give it.
      */}
      <p className="border-t border-gray-100 pt-4 text-xs text-gray-400">
        These figures are for seeing what&rsquo;s happening in the hall. They
        don&rsquo;t feed any ranking, allocation or standing, and a dash means
        &ldquo;not counted&rdquo; rather than &ldquo;nobody came&rdquo;.
      </p>
    </div>
  );
}
