"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { CalendarDays, MapPin, Users, Check } from "lucide-react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import {
  formatDateTime,
  formatDayHeading,
  dayKey,
  nowSec,
} from "~/app/events/_lib/format";
import { ownerLabel } from "~/lib/schemas/event";

type PublicEvent = RouterOutputs["event"]["listPublished"]["events"][number];

type Tab = "upcoming" | "mine" | "past";

/**
 * The resident timeline — a Luma-style vertical list grouped by day, with a
 * left date rail. Three views: what's coming up, the events you're going to, and
 * a past archive. All published events come from one query; the tabs filter
 * client-side.
 */
export default function EventsTimeline() {
  const list = api.event.listPublished.useQuery(undefined, { retry: false });
  const [tab, setTab] = useState<Tab>("upcoming");

  const now = nowSec();

  const groups = useMemo(() => {
    const events = list.data?.events ?? [];
    const filtered = events.filter((e) => {
      const upcoming = e.startTime == null || e.startTime >= now;
      if (tab === "upcoming") return upcoming;
      if (tab === "past") return !upcoming;
      return e.mySignup; // "mine"
    });

    // Past reads newest-first; everything else soonest-first.
    const ordered = [...filtered].sort((a, b) => {
      const av = a.startTime ?? Number.MAX_SAFE_INTEGER;
      const bv = b.startTime ?? Number.MAX_SAFE_INTEGER;
      return tab === "past" ? bv - av : av - bv;
    });

    const byDay = new Map<string, { heading: string; events: PublicEvent[] }>();
    for (const e of ordered) {
      const key = e.startTime == null ? "tbc" : dayKey(e.startTime);
      const heading =
        e.startTime == null ? "Date to be confirmed" : formatDayHeading(e.startTime);
      if (!byDay.has(key)) byDay.set(key, { heading, events: [] });
      byDay.get(key)!.events.push(e);
    }
    return [...byDay.values()];
  }, [list.data, tab, now]);

  const TABS: { key: Tab; label: string }[] = [
    { key: "upcoming", label: "Upcoming" },
    { key: "mine", label: "My events" },
    { key: "past", label: "Past" },
  ];

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">
          Events
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          What&rsquo;s happening around Raffles Hall.
        </p>
      </div>

      <div className="mb-6 inline-flex rounded-lg bg-gray-100 p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-white text-emerald-700 shadow-sm"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {list.isPending ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-gray-200" />
          ))}
        </div>
      ) : list.error ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-600">
          {list.error.message === "EVENTS_DISABLED"
            ? "Events aren’t available yet — check back soon."
            : "Events couldn’t load. Reload the page."}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center">
          <CalendarDays className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm font-medium text-gray-900">
            {tab === "mine"
              ? "You haven’t signed up for anything yet"
              : tab === "past"
                ? "No past events"
                : "No upcoming events"}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            {tab === "mine"
              ? "Browse Upcoming and sign up for something."
              : "New events show up here once they’re published."}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((g, gi) => (
            <div key={gi} className="flex gap-4">
              {/* Date rail */}
              <div className="w-20 shrink-0 pt-1 sm:w-28">
                <p className="sticky top-20 text-sm font-semibold text-gray-900">
                  {g.heading}
                </p>
              </div>
              {/* Cards */}
              <div className="min-w-0 flex-1 space-y-3 border-l border-gray-200 pl-4">
                {g.events.map((e) => (
                  <EventCard key={e.eventID} event={e} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EventCard({ event: e }: { event: PublicEvent }) {
  // Past events are genuinely done → a muted filled dot. Upcoming events are
  // open, not "completed" → a hollow ring, so the rail never reads as a
  // finished stepper.
  const isPast = e.startTime != null && e.startTime < nowSec();
  return (
    <Link
      href={`/events/${e.eventID}`}
      className="group relative -ml-[1.05rem] block"
    >
      {/* Timeline node — hollow ring = upcoming/open, filled grey = past.
          bg masks the rail line behind it; never a solid green "completed" dot. */}
      <span
        className={`absolute left-0 top-[1.6rem] h-3 w-3 -translate-x-1/2 rounded-full border-2 ${
          isPast
            ? "border-gray-300 bg-gray-300"
            : "border-emerald-500 bg-white"
        }`}
      />
      <div className="ml-4 overflow-hidden rounded-xl border border-gray-200 bg-white transition-all group-hover:border-emerald-300 group-hover:shadow-md">
        <div className="flex">
          {e.bannerUrl && (
            <div className="relative hidden h-auto w-40 shrink-0 sm:block">
              <Image
                src={e.bannerUrl}
                alt=""
                fill
                className="object-cover"
                sizes="160px"
                unoptimized
              />
            </div>
          )}
          <div className="min-w-0 flex-1 p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="truncate text-base font-semibold text-gray-900">
                {e.title?.trim() || "Untitled event"}
              </h3>
              {e.mySignup && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                  <Check className="h-3 w-3" /> Going
                </span>
              )}
            </div>
            {/* Unconditional: a hall-wide event has ccaName null, and the old
                `{e.ccaName && (...)}` guard made the owner line silently
                vanish instead of falling back to "Hall". ownerLabel always
                returns a non-empty string. */}
            <p className="mt-0.5 text-xs font-medium text-emerald-700">
              {ownerLabel(e.ccaID, e.ccaName)}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="h-3.5 w-3.5" />
                {formatDateTime(e.startTime)}
              </span>
              {e.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {e.location}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {e.signupCount}
                {e.capacity != null ? `/${e.capacity} going` : " going"}
              </span>
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
