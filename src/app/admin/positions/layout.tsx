import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * Per-segment guard for /admin/positions: admin and jcrc only, the holders of
 * `manageCcaHeads`. A hidden tab is not a guard (03 §3), so this recomputes
 * from its own live read. Every jcrcPositions procedure re-checks too.
 */
export default async function AdminPositionsLayout({
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
    redirect("/admin"); // fail CLOSED
  }

  if (!computeCapabilities(roles).manageCcaHeads) redirect("/admin");

  return <>{children}</>;
}
