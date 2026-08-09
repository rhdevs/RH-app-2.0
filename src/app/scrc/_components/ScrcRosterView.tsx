"use client";

import { Eye } from "lucide-react";

import { api } from "~/trpc/react";
import RosterTable from "~/app/_components/RosterTable";
import RosterDriftNote from "~/app/_components/RosterDriftNote";

import DisabledNotice, { disabledCopy } from "./DisabledNotice";

/**
 * ONE CCA'S ROSTER, READ-ONLY. Heads and members. Nothing else, ever.
 *
 * WHY THIS IS NOT RosterPanel.
 *
 * RosterPanel renders the same two tables, and reusing it would have been one
 * import. It also wires three things the hall office must not reach, and every
 * one of them is a prop default away from switching on:
 *
 *   - cca.removeMembers, behind `manageMembers`. Membership writes are
 *     head-scoped (assertHeadsCca); the hall office reads rosters and touches
 *     nothing.
 *   - cca.memberDirectory, behind `enableDirectory` — the roster PLUS every
 *     member's matric, block, telegram handle and bio, plus the Excel export of
 *     all of it. That is a different sensitivity class from "names and grant
 *     dates", it is head-only server-side, and there is no reason for the hall
 *     office to hold the hall's contact details.
 *   - a `via === "manageCcaHeads"` branch, which is a manager-tier label this
 *     surface has no business rendering.
 *
 * A future "just pass enableDirectory here too" is exactly the change this file
 * exists to make someone stop and argue for. If you find yourself importing
 * RosterPanel into src/app/scrc/, that is the signal.
 *
 * RosterTable and RosterDriftNote ARE reused, because they are display-only —
 * they hold no queries and no mutations, and with `selection` and `details`
 * omitted (as they are here, and must stay) they render a plain table. That is
 * the same read-only configuration /admin/ccas uses. Duplicating them would
 * fork the amber unresolved-row rendering, which is the one part of a roster
 * everybody needs to see the same way.
 */
export default function ScrcRosterView({ ccaID }: { ccaID: number }) {
  const { data, isPending, error } = api.cca.getRoster.useQuery(
    { ccaID },
    // A FORBIDDEN is a settled answer, not a transient failure. Retrying it
    // three times is log noise and a slow, ambiguous UI.
    { retry: false },
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
    if (disabledCopy(error.message)) {
      return <DisabledNotice message={error.message} />;
    }
    if (error.message === "NOT_A_HEAD_OF_THIS_CCA") {
      return (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
          <p className="text-sm font-medium text-gray-900">
            You can’t see this CCA’s roster
          </p>
          <p className="mt-1 text-sm text-gray-500">
            If that looks wrong, contact an admin.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6">
        <p className="text-sm font-medium text-red-900">
          This roster couldn’t be loaded
        </p>
        <p className="mt-1 text-sm text-red-700">
          Reload the page. If it keeps happening, contact an admin.
        </p>
      </div>
    );
  }

  const { cca, heads, members, drift } = data;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold text-gray-900">
            {cca.ccaName ?? `Unknown CCA (#${cca.ccaID})`}
          </h2>
          {/* Says what this view IS, and does NOT branch on `via`. getRoster
              reports via: "readOnly" for scrc and via: "manageCcaHeads" for an
              admin who wanders in here, but this surface draws no controls for
              either of them — so the label is a property of the page, not of
              the caller, and a branch would only invite one. */}
          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
            <Eye className="h-3 w-3" />
            Read-only
          </span>
        </div>
        <p className="mt-1 text-sm text-gray-500">
          {cca.category ?? "Uncategorised"}
        </p>
      </header>

      {/* The CCA record itself is missing — the CcaBadges amber idiom, applied
          to the whole roster rather than one row. */}
      {drift.ccaMissing && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          There is no CCA with this id any more, but these membership records
          still point at it.
        </div>
      )}

      <RosterDriftNote drift={drift} />

      {/* NO `selection` and NO `details` on either table, and there must never
          be one. `selection` draws removal checkboxes; `details` triggers the
          cca.memberDirectory fetch (matric/block/telegram/bio + Excel export)
          this surface is explicitly not entitled to. Omitting them is what
          makes RosterTable safe to share here. */}
      {/* showEmail={false} because the SERVER already nulled every address on
          this tier (cca.getRoster -> redactRosterForReadOnly). This is not the
          boundary and must never be mistaken for one — it only stops the table
          drawing an Email header over a column the server declined to fill,
          which reads as a bug rather than as a decision. Flipping it to true
          would show an empty column, not an address. */}
      <RosterTable
        title="Heads"
        entries={heads}
        emptyCopy="Nobody is currently listed as a head of this CCA."
        showEmail={false}
      />
      <RosterTable
        title="Members"
        entries={members}
        emptyCopy="No members are listed for this CCA yet."
        showEmail={false}
      />
    </div>
  );
}
