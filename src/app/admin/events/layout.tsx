import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

/** Session-dependent — never cached. */
export const dynamic = "force-dynamic";

/**
 * The narrow guard for the event review surface (03 §2, layer 2). DEFENCE IN
 * DEPTH — every event.* reviewer procedure re-checks (roleManagerProcedure +
 * assertEventsEnabled, and decide re-reads reviewEvents live). This only keeps
 * review markup from streaming to someone without the capability. Sits inside
 * /admin/layout.tsx's AdminShell, so it returns children unwrapped.
 */
export default async function AdminEventsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  let roles: string[] = [];
  try {
    roles = await getUserRoles(db, session.user.userID); // I-5 live read
  } catch {
    redirect("/"); // fail closed, swallow — see admin/layout.tsx
  }

  // Both capabilities, because this surface now carries both jobs: the review
  // queue (reviewEvents) and the JCRC's own hall events (manageHallEvents).
  // They are the identical set today — both are `manager` — so this is
  // behaviour-identical, but naming both means widening one later cannot
  // silently widen access to the other.
  const caps = computeCapabilities(roles);
  if (!caps.reviewEvents && !caps.manageHallEvents) redirect("/");

  return <>{children}</>;
}
