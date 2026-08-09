import { AlertTriangle } from "lucide-react";

import { Badge } from "~/components/ui/badge";

/**
 * `variant="outline"` is the neutral base (no background), which sidesteps the
 * black `--primary: 240 5.9% 10%` default in globals.css entirely — className
 * supplies all colour. Do NOT re-theme globals.css to fix this; the rest of the
 * app is hand-rolled Tailwind on an emerald identity and this dashboard is the
 * first consumer of the shadcn primitives.
 *
 * Red for admin is intentional: the highest privilege should look alarming in a
 * list of 515 rows.
 */
const ROLE_STYLES: Record<
  string,
  { label: string; cls: string; title?: string }
> = {
  admin: {
    label: "Admin",
    cls: "bg-red-100 text-red-800 border-red-300 hover:bg-red-100",
  },
  jcrc: {
    label: "JCRC",
    cls: "bg-emerald-100 text-emerald-800 border-emerald-300 hover:bg-emerald-100",
  },
  scrc: {
    label: "Hall Office",
    cls: "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100",
    title: "Hall Office / SCRC. Can appoint JCRC and book the SCRC Room.",
  },
  cca_head: {
    label: "CCA Head",
    cls: "bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-100",
  },
  // D-1 / I-8: STORED, auto-granted at account creation to every verified
  // @u.nus.edu identity and self-healed at session read (I-8a/I-8b). Never
  // granted or revoked through this UI (I-8e). Rendered muted so it reads as
  // a fact about the account, not as a grant somebody made.
  resident: {
    label: "Resident",
    cls: "bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-100",
    title:
      "Automatic for every verified NUS account. Cannot be granted or removed here.",
  },
};

export default function RoleBadge({ role }: { role: string }) {
  // Unknown roles render neutrally rather than vanishing: a role written by a
  // script must be VISIBLE without a code change here, or the table silently
  // under-reports what a user actually holds.
  const s = ROLE_STYLES[role] ?? {
    label: role,
    cls: "bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-100",
  };
  return (
    <Badge variant="outline" className={s.cls} title={s.title}>
      {s.label}
    </Badge>
  );
}

/**
 * The zero-roles state. D-1 INVERTS v1 here, and this is the highest-risk copy
 * in the component: v1 rendered "Resident" as the fallback for an empty roles
 * array. Under a stored baseline an empty array means the account cannot book
 * ANYTHING — rendering a reassuring "Resident" would report a booking-blocked
 * account as healthy, which is precisely the gap the health panel exists to
 * surface.
 */
export function NoAccessBadge() {
  return (
    <Badge
      variant="outline"
      className="border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100"
      title="This account cannot book any facility. Check /admin → Overview → health."
    >
      No access
    </Badge>
  );
}

/**
 * The §7 anomaly marker: an NUS-eligible account whose STORED roles omit the
 * baseline. This is a LIVE LOCKOUT indicator, not a materialisation gap — under
 * the stored design the user genuinely cannot book until the row is repaired.
 *
 * Same visual language as the keyMismatch marker, deliberately.
 */
export function MissingBaselineIcon() {
  // The tooltip lives on a wrapping span: lucide-react icons forward SVG props
  // but not `title`, so putting it on the icon is silently dropped.
  return (
    <span
      role="img"
      aria-label="Missing Resident baseline"
      title="This account should hold the Resident baseline but does not. It will repair itself at their next sign-in; if it persists, see Overview → health."
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
    </span>
  );
}

export function KeyMismatchIcon() {
  return (
    <span
      role="img"
      aria-label="Stored ID differs from NUSNET ID"
      title="This account's stored ID differs from its NUSNET ID. Roles are keyed on the NUSNET ID shown."
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
    </span>
  );
}
