import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * Per-segment guard, the same shape as ../audit/layout.tsx. Feedback is
 * admin-only (`readAuditLog` is held by admin alone, and the procedure is
 * `adminProcedure`), which is narrower than `reachDashboard`, so hiding the
 * tab in AdminShell is not a guard. Recomputed from a LIVE role read.
 */
export default async function AdminFeedbackLayout({
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
