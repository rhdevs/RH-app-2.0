import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * Narrower than ../layout.tsx, so it ships its own gate (03 §3): a hidden tab
 * is not a guard. Without this, anyone who could reach /admin at all could type
 * /admin/ccas and read every roster.
 *
 * It RECOMPUTES from its own live read rather than taking a prop from the
 * parent layout. The duplication with ../layout.tsx is the point.
 */
export default async function AdminCcasLayout({
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

  if (!computeCapabilities(roles).viewAnyCcaRoster) redirect("/admin");

  return <>{children}</>;
}
