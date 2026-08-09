import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import Header from "~/app/_components/header";
import ScrcShell from "./_components/ScrcShell";

/** Session-dependent. Never static, never ISR — a cached hall-office shell would
 *  be served to whoever asked for it next. */
export const dynamic = "force-dynamic";

/**
 * The route guard for the Hall Office (scrc) surface. DEFENCE IN DEPTH, not the
 * security boundary: a client can call api.admin.setJcrcRole.mutate() from the
 * console on any page in the app, so every procedure behind this layout carries
 * its own live capability check plus the `scrc.enabled` switch (I-7). What this
 * buys is that no hall-office markup ever streams to someone who holds neither
 * `admin` nor `scrc`.
 *
 * Structurally a copy of cca/layout.tsx, and DELIBERATELY a copy rather than a
 * shared helper: each narrow segment recomputes from its own live read. The
 * duplication is the point — a shared guard is one edit away from being widened
 * for one caller and silently widened for all of them.
 *
 * NOTE what this does NOT establish. `reachScrcDashboard` answers "is this
 * surface for you" and nothing else. It says nothing about WHICH CCA's roster
 * may be read (assertMayViewCcaRoster decides that per ccaID) and nothing about
 * whether any given account may be granted `jcrc` (assertCanMutateRoles decides
 * that per target).
 *
 * THE `scrc.enabled` KILL SWITCH IS NOT CHECKED HERE, deliberately, following
 * the /admin/manage-ccas layout precedent: this layout answers "may you be in
 * this room"; the switch answers "is the machinery live", and that belongs in
 * the procedures — a page-level switch check would leave every procedure
 * reachable from the console anyway, while making the flag look like it was
 * enforced by the page. assertScrcEnabled's own comment names this file as the
 * place with deliberately no check. The role ships with the switch OFF, so the
 * first person here reaches the page and every panel reports SCRC_DISABLED
 * calmly; that is the intended first-run experience, not a bug.
 */
export default async function ScrcLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  let roles: string[] = [];
  try {
    // LIVE database read, NOT session.user.roles (I-5). The session copy is
    // render-only and the JWT lives 30 days; a hall-office grant revoked this
    // morning must close this page now.
    roles = await getUserRoles(db, session.user.userID);
  } catch {
    // Fail CLOSED, and swallow rather than rethrow — a segment's own error.tsx
    // does NOT catch an error thrown by that segment's layout.tsx, so a rethrow
    // would blank the whole app shell rather than deny one route.
    redirect("/");
  }

  const capabilities = computeCapabilities(roles);
  // redirect("/") and not a 403: an unauthorised viewer should not learn that
  // /scrc exists at all.
  if (!capabilities.reachScrcDashboard) redirect("/");

  return (
    <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Must match the nav link's `name` in header.tsx ("Hall Office") —
          isActive() compares currentPage to link.name before falling back to
          the pathname. */}
      <Header currentPage="Hall Office" />
      {/* max-w-7xl, matching /admin rather than /cca: this surface is panels and
          tables, not a sidebar plus a content column, so a capped measure keeps
          the tables readable on a wide screen. */}
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* The capability set crosses to the client ONCE, here, as a prop.
            Nothing below re-derives authority from a role string. */}
        <ScrcShell capabilities={capabilities}>{children}</ScrcShell>
      </main>
    </div>
  );
}
