import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import Header from "~/app/_components/header";

/** Session-dependent. Never static, never ISR — a cached CCA shell would be
 *  served to whoever asked for it next. */
export const dynamic = "force-dynamic";

/**
 * The route guard for the CCA head surface. DEFENCE IN DEPTH, not the security
 * boundary: a client can call api.cca.getRoster.query() from the console on any
 * page, so the procedure carries its own object-scoped guard (I-7). What this
 * buys is that no CCA markup ever streams to someone with no headship at all.
 *
 * Structurally a copy of admin/layout.tsx, and DELIBERATELY a copy rather than
 * a shared helper: each narrow segment recomputes from its own live read. The
 * duplication is the point — a shared guard is one edit away from being widened
 * for one caller and silently widened for all of them.
 *
 * NOTE what this does NOT establish. `reachCcaDashboard` is true for anyone
 * holding the cca_head string, which under CH-1 means at least one CcaHead row
 * — but CH-1 is a code contract MongoDB cannot enforce. So this gate answers
 * "is this surface for you", never "which CCA". Every ccaID is checked
 * independently by assertHeadsCca.
 */
export default async function CcaLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  let roles: string[] = [];
  try {
    // LIVE database read, NOT session.user.roles (I-5). The session copy is
    // render-only and the JWT lives 30 days; a headship revoked this morning
    // must close this page now.
    roles = await getUserRoles(db, session.user.userID);
  } catch {
    // Fail CLOSED, and swallow rather than rethrow — a segment's own error.tsx
    // does NOT catch an error thrown by that segment's layout.tsx, so a rethrow
    // would blank the whole app shell rather than deny one route.
    redirect("/");
  }

  // redirect("/") and not a 403: an unauthorised viewer should not learn that
  // /cca exists at all.
  if (!computeCapabilities(roles).reachCcaDashboard) redirect("/");

  return (
    <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Must match the nav link's `name` in header.tsx — isActive() compares
          currentPage to link.name before falling back to the pathname. */}
      <Header currentPage="My CCAs" />
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
