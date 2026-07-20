"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Search } from "lucide-react";

import { api } from "~/trpc/react";
import { statusBadgeClass, statusLabel } from "../_lib/status";

/**
 * The /ccas grid. Each card shows the caller's own standing against that CCA —
 * member, application in flight, or open to apply — so the whole page answers
 * "what can I do here" at a glance.
 *
 * useState for the client-side filter only; all data is the single browse query
 * (which enforces cca.applications.enabled server-side).
 */
export default function CcaBrowseGrid() {
  const browse = api.ccaApplications.browse.useQuery(undefined, {
    retry: false,
  });
  const [q, setQ] = useState("");

  if (browse.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-lg bg-gray-200" />
        ))}
      </div>
    );
  }

  if (browse.error) {
    if (browse.error.message === "CCA_APPLICATIONS_DISABLED") {
      return (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
          <p className="text-sm font-medium text-gray-900">
            CCA applications aren&rsquo;t open right now
          </p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-gray-500">
            Check back later — this is where you&rsquo;ll browse CCAs and apply
            to join once applications open.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800">
        These couldn&rsquo;t be loaded. Reload the page.
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const ccas = browse.data.ccas.filter(
    (c) =>
      needle === "" ||
      c.ccaName.toLowerCase().includes(needle) ||
      (c.category ?? "").toLowerCase().includes(needle),
  );

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search CCAs…"
          aria-label="Search CCAs"
          className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
        />
      </div>

      {ccas.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">
          No CCAs match &ldquo;{q}&rdquo;.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ccas.map((c) => (
            <li key={c.ccaID}>
              <Link
                href={`/ccas/${c.ccaID}`}
                className="flex h-full flex-col rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <div className="flex items-start gap-3">
                  {c.logoUrl ? (
                    <Image
                      src={c.logoUrl}
                      alt=""
                      width={44}
                      height={44}
                      className="h-11 w-11 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-sm font-semibold text-emerald-700">
                      {c.ccaName.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="truncate font-medium text-gray-900">
                      {c.ccaName}
                    </p>
                    {c.category && (
                      <p className="truncate text-xs text-gray-500">
                        {c.category}
                      </p>
                    )}
                  </div>
                </div>

                {c.description && (
                  <p className="mt-3 line-clamp-2 text-sm text-gray-600">
                    {c.description}
                  </p>
                )}

                <div className="mt-auto pt-3">
                  {c.isMember ? (
                    <span className="inline-flex items-center rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">
                      Member
                    </span>
                  ) : c.applicationStatus ? (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
                        c.applicationStatus,
                      )}`}
                    >
                      {statusLabel(c.applicationStatus)}
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-emerald-700">
                      Apply →
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
