import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

/** Session-dependent — never cached. */
export const dynamic = "force-dynamic";

/**
 * The narrow guard for /admin/points (03 §3: a hidden tab is not a guard).
 * DEFENCE IN DEPTH — every ccaPoints config procedure re-checks
 * `manageCcaPointsRanges` against a live role read. This only keeps the page's
 * markup from streaming to someone without the capability. It RECOMPUTES from
 * its own live read rather than trusting a prop from the parent layout, and it
 * sits inside /admin/layout.tsx's AdminShell, so it returns children unwrapped.
 */
export default async function AdminPointsLayout({
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
    redirect("/"); // fail CLOSED, swallow — see admin/layout.tsx
  }

  if (!computeCapabilities(roles).manageCcaPointsRanges) redirect("/admin");

  return <>{children}</>;
}
