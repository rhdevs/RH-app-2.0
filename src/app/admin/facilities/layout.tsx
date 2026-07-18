import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * Per-segment guard (03 §3, §13). Admin-only by construction: a jcrc with write
 * access here could re-gate every room behind `jcrc`, or un-gate SCRC — the
 * exact control this project exists to enforce. `setFacilityAccess` is an
 * adminProcedure for the same reason; this file only stops the page rendering.
 *
 * Recomputed from a live read, not inherited as a prop. See ../audit/layout.tsx.
 */
export default async function FacilitiesLayout({
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

  if (!computeCapabilities(roles).manageFacilityAccess) redirect("/admin");
  return <>{children}</>;
}
