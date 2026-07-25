"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Users2,
  Upload,
  DoorOpen,
  ScrollText,
  Settings2,
  CalendarCheck,
} from "lucide-react";

import Header from "~/app/_components/header";
import type { Capabilities } from "~/server/api/services/roles";
import { AdminCapabilityProvider } from "./AdminCapabilityContext";

/**
 * Adding a future admin feature = one entry here + one folder + one capability.
 * `requires` names a CAPABILITY, never a role (D-2).
 *
 * IT CONTROLS RENDERING ONLY. A hidden tab is not a guard: every segment listed
 * here whose capability is narrower than `reachDashboard` MUST also ship its own
 * layout.tsx doing a live role read (03 §3). Without that, a jcrc typing
 * /admin/audit would render the accountability record of their own actions.
 *
 * The CCA tab from 07-cca-future.md slots in as one more entry with
 * `requires: "manageCcaHeads"` — no other change to this file.
 */
const ADMIN_TABS = [
  {
    href: "/admin",
    label: "Overview",
    icon: LayoutDashboard,
    requires: "reachDashboard",
  },
  { href: "/admin/users", label: "Users", icon: Users, requires: "listUsers" },
  { href: "/admin/bulk", label: "Bulk", icon: Upload, requires: "bulkAssign" },
  // Read-only roster viewer — admin + jcrc.
  {
    href: "/admin/ccas",
    label: "CCAs",
    icon: Users2,
    requires: "viewAnyCcaRoster",
  },
  // CCA create/rename, heads and members — admin only, and additionally behind
  // the cca.management.enabled kill switch checked in the procedures.
  {
    href: "/admin/manage-ccas",
    label: "Manage CCAs",
    icon: Settings2,
    requires: "manageCcas",
  },
  // Event review queue — admin + jcrc (reviewEvents). Behind the events.enabled
  // kill switch checked in the procedures.
  {
    href: "/admin/events",
    label: "Events",
    icon: CalendarCheck,
    requires: "reviewEvents",
  },
  {
    href: "/admin/facilities",
    label: "Facilities",
    icon: DoorOpen,
    requires: "manageFacilityAccess",
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    icon: ScrollText,
    requires: "readAuditLog",
  },
] as const satisfies readonly {
  href: string;
  label: string;
  icon: unknown;
  requires: keyof Capabilities;
}[];

export default function AdminShell({
  capabilities,
  children,
}: {
  capabilities: Capabilities;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // `=== true` and not a truthiness test: `assignableRoles` is a (possibly
  // empty) ARRAY on this same object, and [] is truthy. A future tab keyed on
  // one of those fields would otherwise render for everyone.
  const tabs = ADMIN_TABS.filter((t) => capabilities[t.requires] === true);

  return (
    <AdminCapabilityProvider value={capabilities}>
      {/* mb-14 clears the root layout's `fixed bottom-0` footer. The users
          table is the tallest content in the app, so without it the last row
          sits underneath the footer. */}
      <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
        {/* D-2: ONE dashboard, ONE label. v1's admin-vs-jcrc label fork is
            removed — both see the same screen; only the tab set differs. */}
        <Header currentPage="Admin" />

        <nav className="border-b border-gray-200 bg-white">
          {/* overflow-x-auto: five tabs do not fit a 375px viewport. */}
          <div className="mx-auto flex max-w-7xl gap-6 overflow-x-auto px-4 sm:px-6 lg:px-8">
            {tabs.map((t) => {
              const active =
                t.href === "/admin"
                  ? pathname === "/admin"
                  : pathname.startsWith(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={`flex items-center gap-2 whitespace-nowrap border-b-2 py-4 text-sm font-medium transition-colors ${
                    active
                      ? "border-emerald-600 text-emerald-700"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  <t.icon className="h-4 w-4" />
                  {t.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </AdminCapabilityProvider>
  );
}
