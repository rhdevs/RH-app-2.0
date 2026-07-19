import type { ProfileCCA } from "~/server/api/routers/user";

/**
 * DISPLAY ONLY, and read-only — the same rule RoleBadges states. Nothing here
 * is the basis of a permission decision: `isHead` marks a CcaHead row for the
 * reader's benefit, while every capability it implies is enforced server-side.
 *
 * The list this renders is the UNION of two incomplete sources (see the long
 * note on `user.getMyCCAs`). It is therefore normal for it to show a CCA that
 * only one of the two knows about; that is the point, not a bug to reconcile
 * in the UI.
 *
 * LAYOUT: full-width rows, name left, role right.
 *
 * The first version pilled the name and hung a separate "Head" pill beside it,
 * which read as a SECOND CCA called "Head" — two pills of equal weight sitting
 * side by side carry no hint about which qualifies which, and at two
 * memberships the line became "ComMotion (IT) · Head · RH Developers · Head".
 * Pinning the role to the opposite edge of a full-width row fixes that
 * structurally rather than by restyling: the role occupies a column, so it can
 * only be read as a property of the line it sits on.
 */

/** Matches the server's ordering, which sorts a null category last. */
const UNCATEGORISED = "Other";

function RoleLabel({ isHead }: { isHead: boolean }) {
  // Both states are labelled. If only heads got a badge, the ABSENCE of one
  // would be carrying the meaning — and an absent thing is indistinguishable
  // from a thing that failed to render.
  return isHead ? (
    <span
      className="shrink-0 rounded-full border border-indigo-300 bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-800"
      title="You are listed as a head of this CCA."
    >
      Head
    </span>
  ) : (
    <span className="shrink-0 text-xs text-gray-400">Member</span>
  );
}

function CcaRow({ cca }: { cca: ProfileCCA }) {
  // The ONLY place a ccaID is shown. A membership pointing at a CCA that no
  // longer exists is real data drift and is worth seeing; a blank row would
  // hide it and dropping the row would hide it completely.
  const unknown = !cca.ccaName;

  return (
    <li
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
        unknown ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-white"
      }`}
    >
      <span
        className={`min-w-0 truncate text-sm ${
          unknown ? "text-amber-800" : "text-gray-900"
        }`}
        title={
          unknown
            ? "This CCA is no longer listed. Contact the JCRC if you think you should still be a member."
            : (cca.ccaName ?? undefined)
        }
      >
        {unknown ? `Unknown CCA (#${cca.ccaID})` : cca.ccaName}
      </span>
      <RoleLabel isHead={cca.isHead} />
    </li>
  );
}

export function CcaBadges({ ccas }: { ccas: ProfileCCA[] }) {
  if (ccas.length === 0) {
    // Calm, not an error. Being in no CCA is an ordinary state, so this gets
    // plain grey body text rather than the amber warning treatment RoleBadges
    // uses for zero roles — that one really is a lockout.
    return (
      <p className="text-sm text-gray-500">
        You are not listed in any CCA yet.
      </p>
    );
  }

  // Grouped by category so a few memberships read as a short labelled list.
  // Order is already settled server-side; this only walks it and cuts it at
  // each change of category.
  const groups: { category: string; items: ProfileCCA[] }[] = [];
  for (const cca of ccas) {
    const category = cca.category ?? UNCATEGORISED;
    const last = groups[groups.length - 1];
    if (last && last.category === category) last.items.push(cca);
    else groups.push({ category, items: [cca] });
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.category}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
            {group.category}
          </p>
          <ul className="space-y-2">
            {group.items.map((cca) => (
              <CcaRow key={cca.ccaID} cca={cca} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default CcaBadges;
