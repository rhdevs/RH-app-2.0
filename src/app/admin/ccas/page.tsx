"use client";

import { useState } from "react";

import CcaPicker, {
  type CcaOption,
} from "~/app/admin/_components/bulk/CcaPicker";
import RosterPanel from "~/app/_components/RosterPanel";
import CcaHeadsManager from "./_components/CcaHeadsManager";

/**
 * Browse any CCA's roster, and assign/unassign its heads.
 *
 * The roster reuses RosterPanel + cca.getRoster (the object-scope guard passes
 * on manageCcaHeads here). Head management uses the shipped admin.grantCcaHead /
 * revokeCcaHead, which are NOT behind the cca.management.enabled kill switch —
 * that switch gates the separate /admin/manage-ccas CRUD surface.
 *
 * `enableDirectory` — the SAME expandable rows and "Export to Excel" a head has
 * on /cca/[ccaID]/members. cca.memberDirectory guards with assertHeadsCca, which
 * returns `via: "manageCcaHeads"` for admin and jcrc, so this page was always
 * authorized for it; only the prop was missing. NOT extended to `manageMembers`:
 * removal stays a head affordance, and admins prune from /admin/manage-ccas.
 *
 * NOTE what this hands over. memberDirectory carries matric, telegram and bio —
 * PII that cca.getRoster's `via: "readOnly"` branch deliberately redacts. That
 * branch is the HALL OFFICE (scrc) path and is untouched here; admin and jcrc
 * already read this CCA's roster unredacted through manageCcaHeads, so the
 * export widens no one's reach — it only saves them reading it off the screen.
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
        <>
          <CcaHeadsManager ccaID={selected.ccaID} />
          <RosterPanel ccaID={selected.ccaID} enableDirectory />
        </>
      ) : (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
          Choose a CCA above to see who&rsquo;s in it.
        </p>
      )}
    </div>
  );
}
