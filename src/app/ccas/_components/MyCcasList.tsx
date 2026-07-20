"use client";

import Link from "next/link";
import Image from "next/image";
import { ChevronRight, Settings } from "lucide-react";

import { api } from "~/trpc/react";

/**
 * The resident's "My CCAs" dashboard — the CCAs they belong to, VIEW ONLY. No
 * edit or management affordance appears here; those live on the head dashboard
 * (/cca), which a plain member can't reach. A CCA the caller also heads shows a
 * "Manage" shortcut across to it.
 */
export default function MyCcasList() {
  const q = api.ccaApplications.myMemberships.useQuery(undefined, {
    retry: false,
  });

  if (q.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-36 animate-pulse rounded-lg bg-gray-200" />
        ))}
      </div>
    );
  }

  if (q.error) {
    if (q.error.message === "CCA_APPLICATIONS_DISABLED") {
      return (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
          CCAs aren&rsquo;t available right now.
        </p>
      );
    }
    return (
      <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800">
        These couldn&rsquo;t be loaded. Reload the page.
      </p>
    );
  }

  if (q.data.ccas.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">
          You&rsquo;re not in any CCA yet
        </p>
        <Link
          href="/ccas"
          className="mt-2 inline-block text-sm font-medium text-emerald-700"
        >
          Browse CCAs to join →
        </Link>
      </div>
    );
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {q.data.ccas.map((c) => (
        <li key={c.ccaID} className="flex flex-col rounded-lg border border-gray-200 bg-white">
          <Link
            href={`/ccas/${c.ccaID}`}
            className="flex flex-1 flex-col p-4 transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
                <div className="flex items-center gap-1.5">
                  <p className="truncate font-medium text-gray-900">
                    {c.ccaName}
                  </p>
                  {c.isHead && (
                    <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
                      You lead this
                    </span>
                  )}
                </div>
                {c.category && (
                  <p className="truncate text-xs text-gray-500">{c.category}</p>
                )}
              </div>
              <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-gray-300" />
            </div>
            {c.description && (
              <p className="mt-3 line-clamp-2 text-sm text-gray-600">
                {c.description}
              </p>
            )}
          </Link>
          {c.isHead && (
            <Link
              href={`/cca/${c.ccaID}`}
              className="flex items-center gap-1.5 border-t border-gray-100 px-4 py-2 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-emerald-700"
            >
              <Settings className="h-3.5 w-3.5" />
              Manage this CCA
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
