"use client";

import { api } from "~/trpc/react";
import RosterTable from "./RosterTable";
import RosterDriftNote from "./RosterDriftNote";

/**
 * The roster for one CCA. Rendered by /cca/[ccaID] and by /admin/ccas.
 *
 * NEITHER PAGE PRE-GUARDS. cca.getRoster is the one policy site — a client can
 * call it from the console on any page in the app, so a duplicate check in the
 * page would be a second place to keep in step while buying no protection
 * (I-7). This component renders the denial the procedure returns.
 */
export default function RosterPanel({ ccaID }: { ccaID: number }) {
  const { data, isPending, error } = api.cca.getRoster.useQuery(
    { ccaID },
    {
      // A FORBIDDEN is a settled answer, not a transient failure. Retrying it
      // three times is log noise and a slow, ambiguous UI.
      retry: false,
    },
  );

  if (isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
        <div className="h-32 animate-pulse rounded-lg bg-gray-200" />
      </div>
    );
  }

  if (error) {
    if (error.message === "NOT_A_HEAD_OF_THIS_CCA") {
      return (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
          <p className="text-sm font-medium text-gray-900">
            You don&rsquo;t have access to this CCA
          </p>
          <p className="mt-1 text-sm text-gray-500">
            You can only view CCAs you&rsquo;re listed as a head of. If that
            should include this one, contact the JCRC.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6">
        <p className="text-sm font-medium text-red-900">
          This roster couldn&rsquo;t be loaded
        </p>
        <p className="mt-1 text-sm text-red-700">
          Reload the page. If it keeps happening, contact the JCRC.
        </p>
      </div>
    );
  }

  const { cca, heads, members, drift, via } = data;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">
          {cca.ccaName ?? `Unknown CCA (#${cca.ccaID})`}
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          {cca.category ?? "Uncategorised"}
          {via === "manageCcaHeads" && (
            <span className="ml-2 text-gray-400">· viewing as JCRC</span>
          )}
        </p>
      </header>

      {/* The CCA record itself is missing — the CcaBadges amber idiom, applied
          to the whole page rather than one row. */}
      {drift.ccaMissing && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          There is no CCA with this id any more, but these membership records
          still point at it.
        </div>
      )}

      <RosterDriftNote drift={drift} />

      <RosterTable
        title="Heads"
        entries={heads}
        emptyCopy="Nobody is currently listed as a head of this CCA."
      />
      <RosterTable
        title="Members"
        entries={members}
        emptyCopy="No members are listed for this CCA yet."
      />
    </div>
  );
}
