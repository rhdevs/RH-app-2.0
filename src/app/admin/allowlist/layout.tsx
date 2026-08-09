import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";

export const dynamic = "force-dynamic";

/**
 * Per-segment guard (03 §3, §13), the same shape as ../facilities/layout.tsx
 * and ../audit/layout.tsx. `modifyAdmins` is ADMIN-ONLY (roles.ts) — strictly
 * narrower than `reachDashboard` (admin || jcrc) — so AdminShell hiding the
 * tab from a jcrc is not a guard: without this file a jcrc typing
 * /admin/allowlist would render the one surface that ISSUES IDENTITIES. A
 * jcrc who could read or write here could pin their own non-NUS address to a
 * fresh EXT: key and hand it any role — the exact attack
 * services/authAllowlist.ts (M1-M4) and admin.ts's AuthAllowlist block exist
 * to make structurally impossible from the write side (M4). This file is what
 * stops the markup streaming at all.
 *
 * Recomputed from a LIVE getUserRoles read, not inherited as a prop from the
 * parent layout — see ../audit/layout.tsx's note for why a prop is not a
 * guard: the parent's `capabilities` was computed once, at that layout's own
 * render, and a demotion between the two renders must still be caught here.
 */
export default async function AllowlistLayout({
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

  if (!computeCapabilities(roles).modifyAdmins) redirect("/admin");
  return <>{children}</>;
}
