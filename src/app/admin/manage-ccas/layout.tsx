import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * ADMIN ONLY, and the narrowest gate in the app after /admin/audit. Ships its
 * own live role read for the same reason every narrow segment does: a hidden
 * tab is not a guard, and a jcrc typing this URL must not reach a surface that
 * creates and renames CCAs.
 *
 * The kill switch is NOT checked here. This layout answers "may you be in this
 * room"; the switch answers "is the machinery live", and that belongs in the
 * procedures — a page-level switch check would leave the mutations reachable
 * from the console.
 */
export default async function ManageCcasLayout({
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

  if (!computeCapabilities(roles).manageCcas) redirect("/admin");

  return <>{children}</>;
}
