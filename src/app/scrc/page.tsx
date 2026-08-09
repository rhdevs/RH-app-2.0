"use client";

import { useState } from "react";
import { CalendarCheck, ShieldCheck, Users2 } from "lucide-react";

import type { Capabilities } from "~/server/api/services/roles";
import { useScrcCapabilities } from "./_components/ScrcCapabilityContext";
import JcrcRosterPanel from "./_components/JcrcRosterPanel";
import CcaBrowsePanel from "./_components/CcaBrowsePanel";
import EventsOversightPanel from "./_components/EventsOversightPanel";

/**
 * The Hall Office dashboard: three panels, one route.
 *
 * A CLIENT component, unlike /cca/page.tsx, because there is nothing to decide
 * server-side — the layout already did the live role read and the redirect, and
 * every panel's real gate is the procedure it calls. All this owns is which of
 * the three is on screen.
 *
 * `requires` names a CAPABILITY, never a role (D-2), exactly as AdminShell's tab
 * list does. IT CONTROLS RENDERING ONLY: hiding a tab is not a guard, and each
 * panel's procedures re-read the capability live and check the `scrc.enabled`
 * kill switch themselves (I-7).
 *
 * All three capabilities are currently true for both `admin` and `scrc`, so in
 * practice nobody sees a partial tab set. The filter is here anyway so that
 * narrowing one of them later is a one-line change rather than a hunt for the
 * places that assumed all three travelled together.
 */
const PANELS = [
  {
    key: "jcrc",
    label: "JCRC",
    icon: ShieldCheck,
    requires: "manageJcrcRoster",
    Panel: JcrcRosterPanel,
  },
  {
    key: "ccas",
    label: "CCA rosters",
    icon: Users2,
    requires: "viewCcaRostersReadOnly",
    Panel: CcaBrowsePanel,
  },
  {
    key: "events",
    label: "Events",
    icon: CalendarCheck,
    requires: "viewEventsReadOnly",
    Panel: EventsOversightPanel,
  },
] as const satisfies readonly {
  key: string;
  label: string;
  icon: unknown;
  requires: keyof Capabilities;
  Panel: React.ComponentType;
}[];

export default function ScrcPage() {
  const capabilities = useScrcCapabilities();
  // `=== true` and not a truthiness test: `assignableRoles` is a (possibly
  // empty) ARRAY on this same object, and [] is truthy. A future panel keyed on
  // one of those fields would otherwise render for everyone.
  const panels = PANELS.filter((p) => capabilities[p.requires] === true);

  const [active, setActive] = useState(panels[0]?.key);
  const current = panels.find((p) => p.key === active) ?? panels[0];

  if (!current) {
    // reachScrcDashboard without any of the three. Not reachable today, but a
    // blank page with no explanation is the worst possible way to find out that
    // it became reachable.
    return (
      <div className="rounded-xl bg-white p-10 text-center shadow-lg">
        <p className="text-sm font-medium text-gray-900">
          There’s nothing here for your account
        </p>
        <p className="mt-1 text-sm text-gray-500">
          You can reach the Hall Office page, but none of its tools are open to
          you. Contact an admin.
        </p>
      </div>
    );
  }

  const { Panel } = current;

  return (
    <div className="space-y-6">
      {/* The same tab idiom as AdminShell's nav — emerald underline on the
          active entry — because this is the same kind of surface and inventing
          a second look for it would only make the app read as two apps. State,
          not routing: /scrc is one route. */}
      <nav className="border-b border-gray-200">
        <div className="flex gap-6 overflow-x-auto">
          {panels.map((p) => {
            const isActive = p.key === current.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setActive(p.key)}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center gap-2 whitespace-nowrap border-b-2 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "border-emerald-600 text-emerald-700"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                <p.icon className="h-4 w-4" />
                {p.label}
              </button>
            );
          })}
        </div>
      </nav>

      <Panel />
    </div>
  );
}
