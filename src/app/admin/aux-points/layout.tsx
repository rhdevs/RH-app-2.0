import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

/** Session-dependent — never cached. */
export const dynamic = "force-dynamic";

/**
 * The narrow guard for /admin/aux-points, the same one /admin/points has (03 §3: a
 * hidden tab is not a guard). DEFENCE IN DEPTH — every aux procedure re-checks
 * `manageCcaPointsRanges` against a live role read; this only keeps the page's
 * markup from streaming to someone without the capability.
 */
export default async function AdminAuxLayout({
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
