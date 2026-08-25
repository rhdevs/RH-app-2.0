"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Search } from "lucide-react";

import { api } from "~/trpc/react";
import { statusBadgeClass, residentStatusLabel } from "../_lib/status";

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

  // `!browse.data`, NOT `browse.error` — react-query keeps the last good data
  // across a failed BACKGROUND refetch, and tearing the whole grid down on a
  // transient blip is strictly worse than showing slightly stale cards. Same
  // reasoning and same fix as the other three consumers; the staleness strip
  // below is the compensating signal.
  if (!browse.data) {
    if (browse.error?.message === "CCA_APPLICATIONS_DISABLED") {
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
    <>
      {/* OUTSIDE the `space-y-4` container below. This region is always mounted
          (see below), so as a direct child of a `space-y-*` parent it would take
          a sibling slot and push the search box and the whole grid down by 16px
          even while empty — a phantom gap in the normal, recruitment-open case.

          CALM GREY, never red or amber, and that is the register DisabledNotice
          already establishes for this app: a configuration state is NOT a
          failure and must not be dressed as one. The resident has done nothing
          wrong and nothing is broken — a door is shut. The head's review screen
          gets AMBER instead, deliberately, because a head IS looking at a
          surface whose writes are switched off, which is a different fact.

          The banner carries its own `mb-4` (below) rather than leaning on a
          parent's `space-y-*`: this region sits OUTSIDE that container by
          design, and the page above it (src/app/ccas/page.tsx) is a plain
          <div> with no spacing utility at all, so nothing else would separate
          the banner from the search box.

          THE LIVE REGION IS THE ALWAYS-MOUNTED OUTER DIV, with the conditional
          inside it. A live region inserted into the DOM together with its own
          content is not reliably announced — the region has to already exist
          for the change to register as one. So this is silent on first load,
          which is right (the banner is part of the initial page and reading
          order covers it), and speaks only when a background refetch flips the
          flag under a resident already looking at the grid. */}
      <div role="status" aria-live="polite">
        {!browse.data.recruitmentOpen && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <p className="text-sm font-medium text-gray-900">
              CCA recruitment is closed
            </p>
            <p className="mt-1 text-sm text-gray-600">
              You can still browse every CCA and see who runs them. Until the
              JCRC reopens recruitment, new applications aren’t being taken and
              interviews can’t be booked.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {/* The compensating signal for the `!browse.data` reorder above:
            keeping a working grid on a failed background refetch is right,
            going silent about it is not. */}
        {browse.error && (
          <p
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            Couldn’t refresh just now, so this list may be out of date.{" "}
            <button
              type="button"
              onClick={() => void browse.refetch()}
              className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              Try again
            </button>
          </p>
        )}
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
                        {residentStatusLabel(c.applicationStatus)}
                      </span>
                    ) : !browse.data.recruitmentOpen ? (
                      <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-500/20">
                        Recruitment closed
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
    </>
  );
}
