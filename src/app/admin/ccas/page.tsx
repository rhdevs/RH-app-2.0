"use client";

import { useState } from "react";

import CcaPicker, {
  type CcaOption,
} from "~/app/admin/_components/bulk/CcaPicker";
import RosterPanel from "~/app/_components/RosterPanel";

/**
 * Browse any CCA's roster. READ-ONLY.
 *
 * Reuses CcaPicker (built for the bulk head wizard) and RosterPanel (built for
 * /cca/[ccaID]) verbatim, and calls the SAME cca.getRoster procedure — the
 * object-scope guard simply passes on the manageCcaHeads capability here rather
 * than on a headship row.
 *
 * No new query, no new table, no new guard. If this page ever needs its own,
 * that is a signal something upstream was designed wrong.
 */
export default function AdminCcasPage() {
  const [selected, setSelected] = useState<CcaOption | null>(null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-gray-900">CCAs</h1>
        <p className="mt-1 text-sm text-gray-500">
          Pick a CCA to see its heads and members.
        </p>
      </header>

      <CcaPicker
        value={selected?.ccaID ?? null}
        onChange={(cca) => setSelected(cca)}
      />

      {selected ? (
        <RosterPanel ccaID={selected.ccaID} />
      ) : (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
          Choose a CCA above to see who&rsquo;s in it.
        </p>
      )}
    </div>
  );
}
