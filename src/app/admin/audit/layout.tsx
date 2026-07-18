import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * Per-segment guard (03 §3, the RULE). The Audit tab is hidden from a jcrc by
 * AdminShell, but a hidden tab is not a guard — without this file a jcrc typing
 * /admin/audit would render the accountability record of their own actions.
 *
 * It RECOMPUTES from a live getUserRoles read rather than receiving capabilities
 * as a prop from the parent layout, because a prop from a parent is not a guard.
 * The duplication with ../layout.tsx is the point.
 */
export default async function AuditLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  let roles: string[] = [];
  try {
    roles = await getUserRoles(db, session.user.userID);
  } catch {
    redirect("/admin"); // fail closed
  }

  if (!computeCapabilities(roles).readAuditLog) redirect("/admin");
  return <>{children}</>;
}
