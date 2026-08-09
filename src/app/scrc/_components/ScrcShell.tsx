"use client";

import type { Capabilities } from "~/server/api/services/roles";
import { ScrcCapabilityProvider } from "./ScrcCapabilityContext";

/**
 * The client half of the /scrc segment: it carries the capability set the server
 * layout computed, and owns the one persistent heading.
 *
 * Thinner than AdminShell on purpose. AdminShell also owns a tab strip because
 * /admin is many ROUTES; the hall office is one route with three panels, so the
 * panel switcher lives in page.tsx next to the panels it switches between and
 * this component stays a provider plus a header.
 */
export default function ScrcShell({
  capabilities,
  children,
}: {
  capabilities: Capabilities;
  children: React.ReactNode;
}) {
  return (
    <ScrcCapabilityProvider value={capabilities}>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold text-gray-900">Hall Office</h1>
          <p className="mt-1 text-sm text-gray-500">
            Appoint the JCRC, and look in on CCA rosters and events.
          </p>
        </header>
        {children}
      </div>
    </ScrcCapabilityProvider>
  );
}
