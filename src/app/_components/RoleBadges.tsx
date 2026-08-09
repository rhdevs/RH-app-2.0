/**
 * DISPLAY ONLY. Never the basis of a permission decision (I-7): every capability
 * these badges imply is independently enforced server-side, and the array they
 * render comes from the session/query copy that I-5 marks render-only.
 *
 * D-1: `resident` is a REAL role and the baseline booking capability, so it is
 * badged like any other. The zero-roles case is therefore NOT "Resident" — it
 * means the user currently cannot book anything, and printing "Resident" there
 * would tell a locked-out user they are fine (lockout mode 16).
 */
const ROLE_META: Record<
  string,
  { label: string; className: string; title: string }
> = {
  admin: {
    label: "Admin",
    className: "bg-red-100 text-red-800 border-red-300",
    title: "Full access, including role management.",
  },
  jcrc: {
    label: "JCRC",
    className: "bg-emerald-100 text-emerald-800 border-emerald-300",
    title: "Can manage roles and book the SCRC Room.",
  },
  scrc: {
    label: "Hall Office",
    className: "bg-amber-100 text-amber-800 border-amber-300",
    title: "Hall Office / SCRC. Can appoint JCRC and book the SCRC Room.",
  },
  cca_head: {
    label: "CCA Head",
    className: "bg-indigo-100 text-indigo-800 border-indigo-300",
    title: "Can book CCA rooms.",
  },
  resident: {
    label: "Resident",
    className: "bg-slate-100 text-slate-700 border-slate-300",
    title: "Verified NUS resident. Can book normal rooms.",
  },
};

/** Baseline first, then escalating. A stable order so the row does not reshuffle
 *  between renders when the underlying array order changes. */
const ORDER = ["resident", "cca_head", "jcrc", "scrc", "admin"];

export function RoleBadges({ roles }: { roles: string[] }) {
  // "user" was the v1 implicit default and is never stored by the new writers.
  // If it appears at all it is legacy data, so do not badge it.
  const shown = roles.filter((r) => r !== "user");

  if (shown.length === 0) {
    return (
      <span
        className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800"
        title="You do not currently hold any role, so you cannot book facilities. If you just signed up, reload the page. If this persists, contact the JCRC."
      >
        No roles — cannot book
      </span>
    );
  }

  const sorted = [...shown].sort(
    (a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99),
  );

  return (
    <div className="flex flex-wrap gap-2">
      {sorted.map((r) => {
        // The unknown-role fallback is deliberate. UserRole.roles is a String[]
        // in a collection with no $jsonSchema validator, so an out-of-vocabulary
        // string is physically possible; rendering it neutrally makes it visible
        // instead of invisible. It confers nothing — normalizeStoredRoles drops
        // unknown strings before any authorization check.
        const m = ROLE_META[r] ?? {
          label: r,
          className: "bg-gray-100 text-gray-800 border-gray-300",
          title: "",
        };
        return (
          <span
            key={r}
            title={m.title}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${m.className}`}
          >
            {m.label}
          </span>
        );
      })}
    </div>
  );
}

export default RoleBadges;
