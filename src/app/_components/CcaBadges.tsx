import { Badge } from "~/components/ui/badge";
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
 * Visual vocabulary is borrowed wholesale from RoleBadges — same pill geometry
 * (`rounded-full border px-2.5 py-0.5 text-xs font-medium`), same indigo for
 * anything CCA-head-shaped, same amber for "this is odd, look at it". The
 * shared `Badge` primitive supplies the pill; the palette classes override its
 * token-based default so this row sits beside the role badges rather than
 * introducing a second look on the same page.
 */

const PILL = "rounded-full border px-2.5 py-0.5 text-xs font-medium";

/** Unknown ids sort last and group last; "￿" is above any real category. */
const UNCATEGORISED = "Other";

function CcaRow({ cca }: { cca: ProfileCCA }) {
  // The ONLY place a ccaID is shown. A membership pointing at a CCA that no
  // longer exists is real data drift and is worth seeing; rendering a blank
  // pill would hide it, and dropping the row would hide it completely.
  if (!cca.ccaName) {
    return (
      <li>
        <Badge
          className={`${PILL} border-amber-300 bg-amber-50 text-amber-800`}
          title="This CCA is no longer listed. Contact the JCRC if you think you should still be a member."
        >
          Unknown CCA (#{cca.ccaID})
        </Badge>
      </li>
    );
  }

  return (
    <li className="inline-flex items-center gap-1.5">
      <Badge className={`${PILL} border-slate-300 bg-slate-100 text-slate-700`}>
        {cca.ccaName}
      </Badge>
      {cca.isHead && (
        <Badge
          className={`${PILL} border-indigo-300 bg-indigo-100 text-indigo-800`}
          title="You are listed as a head of this CCA."
        >
          Head
        </Badge>
      )}
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

  // Grouped by category so a few memberships read as a short labelled list
  // rather than an undifferentiated pill soup. Order is already settled
  // server-side; this only walks it and cuts it at each change of category.
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
          <ul className="flex flex-wrap items-center gap-2">
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
