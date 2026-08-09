"use client";

import { useState } from "react";

import ScrcCcaPicker, { type ScrcCcaOption } from "./ScrcCcaPicker";
import ScrcRosterView from "./ScrcRosterView";

/**
 * Look in on any CCA's roster. Pick a CCA, read who is in it, done.
 *
 * Structurally /admin/ccas' page minus everything that writes: no
 * CcaHeadsManager (grant/revoke headship is manager-tier), no RosterPanel (see
 * the long note in ScrcRosterView for why), no export. If a control ever needs
 * adding here, the question to answer first is which server procedure would
 * back it — every write in this area is guarded by assertHeadsCca or
 * manageCcaHeads, and the hall office holds neither.
 */
export default function CcaBrowsePanel() {
  const [selected, setSelected] = useState<ScrcCcaOption | null>(null);

  return (
    <div className="space-y-6">
      <section className="rounded-xl bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">CCA rosters</h2>
        <p className="mb-4 mt-1 text-sm text-gray-500">
          Pick a CCA to see its heads and members.
        </p>
        <ScrcCcaPicker
          value={selected?.ccaID ?? null}
          onChange={(cca) => setSelected(cca)}
        />
      </section>

      {selected ? (
        <ScrcRosterView ccaID={selected.ccaID} />
      ) : (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
          Choose a CCA above to see who’s in it.
        </p>
      )}
    </div>
  );
}
