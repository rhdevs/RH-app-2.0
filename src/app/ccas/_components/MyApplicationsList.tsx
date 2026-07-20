"use client";

import Link from "next/link";
import { CalendarClock, MapPin } from "lucide-react";

import { api } from "~/trpc/react";
import { formatSlot, statusBadgeClass, statusLabel } from "../_lib/status";

export default function MyApplicationsList() {
  const q = api.ccaApplications.myApplications.useQuery(undefined, {
    retry: false,
  });

  if (q.isPending) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-200" />
        ))}
      </div>
    );
  }

  if (q.error) {
    if (q.error.message === "CCA_APPLICATIONS_DISABLED") {
      return (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
          CCA applications aren&rsquo;t open right now.
        </p>
      );
    }
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800">
        These couldn&rsquo;t be loaded. Reload the page.
      </p>
    );
  }

  if (q.data.applications.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">No applications yet</p>
        <Link
          href="/ccas"
          className="mt-2 inline-block text-sm font-medium text-emerald-700"
        >
          Browse CCAs →
        </Link>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {q.data.applications.map((a) => (
        <li key={a.applicationID}>
          <Link
            href={`/ccas/${a.ccaID}`}
            className="block rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="font-medium text-gray-900">
                {a.ccaName ?? `CCA #${a.ccaID}`}
              </p>
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
                  a.status,
                )}`}
              >
                {statusLabel(a.status)}
              </span>
            </div>

            {a.slot && a.status === "interview_scheduled" && (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
                <span className="inline-flex items-center gap-1.5">
                  <CalendarClock className="h-4 w-4 text-gray-400" />
                  {formatSlot(a.slot.startTime, a.slot.endTime)}
                </span>
                {a.slot.location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 text-gray-400" />
                    {a.slot.location}
                  </span>
                )}
              </p>
            )}

            {a.status === "rejected" && a.decisionReason && (
              <p className="mt-2 text-sm text-gray-600">{a.decisionReason}</p>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
