"use client";

import Link from "next/link";
import { Users } from "lucide-react";

import { api } from "~/trpc/react";

/**
 * The CCAs you head. Only reached when there is NOT exactly one — a single
 * headship is redirected straight through by the server component above.
 */
export default function CcaIndex() {
  const { data, isPending, error } = api.cca.listMine.useQuery(undefined, {
    retry: false,
  });

  if (isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-8 w-40 animate-pulse rounded bg-gray-200" />
        <div className="h-20 animate-pulse rounded-lg bg-gray-200" />
        <div className="h-20 animate-pulse rounded-lg bg-gray-200" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6">
        <p className="text-sm font-medium text-red-900">
          Your CCAs couldn&rsquo;t be loaded
        </p>
        <p className="mt-1 text-sm text-red-700">
          Reload the page. If it keeps happening, contact the JCRC.
        </p>
      </div>
    );
  }

  const { ccas, canManageAll } = data;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">Your CCAs</h1>
        <p className="mt-1 text-sm text-gray-500">
          The CCAs you&rsquo;re listed as a head of.
        </p>
      </header>

      {ccas.length === 0 ? (
        /* CALM, NOT AN ERROR. This is also where CH-1 drift comes to rest: a
           stale cca_head string with no CcaHead rows lands here, sees an empty
           list, and is refused every individual CCA. That is the intended
           failure direction — an empty page, never a leaked roster. */
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
          <p className="text-sm text-gray-700">
            You&rsquo;re not currently listed as the head of any CCA.
          </p>
          <p className="mt-1 text-sm text-gray-500">
            If that&rsquo;s wrong, contact the JCRC and they can add you.
          </p>
          {canManageAll && (
            <p className="mt-3 text-sm text-gray-500">
              Looking for a different CCA?{" "}
              <Link
                href="/admin/ccas"
                className="font-medium text-emerald-700 underline underline-offset-2"
              >
                Browse all CCAs
              </Link>
              .
            </p>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {ccas.map((c) => (
            <li key={c.ccaID}>
              <Link
                href={`/cca/${c.ccaID}`}
                className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors hover:border-emerald-300 hover:bg-emerald-50 ${
                  // The only place a bare ccaID reaches the UI — a headship
                  // pointing at a CCA that no longer exists is real drift and
                  // is worth seeing rather than hiding.
                  c.ccaName
                    ? "border-gray-200 bg-white"
                    : "border-amber-300 bg-amber-50"
                }`}
              >
                <span className="min-w-0">
                  <span
                    className={`block truncate text-sm font-medium ${
                      c.ccaName ? "text-gray-900" : "text-amber-900"
                    }`}
                  >
                    {c.ccaName ?? `Unknown CCA (#${c.ccaID})`}
                  </span>
                  <span className="block truncate text-xs text-gray-500">
                    {c.category ?? "Uncategorised"}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-gray-500">
                  <Users className="h-3.5 w-3.5" />
                  {c.headCount} {c.headCount === 1 ? "head" : "heads"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
