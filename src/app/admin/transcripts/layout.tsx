import { redirect } from "next/navigation";

import { canManageTranscriptPeriods } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import { auth } from "~/server/auth";
import { db } from "~/server/db";

export const dynamic = "force-dynamic";

/**
 * Per-segment guard for /admin/transcripts and the preview under it: admin or
 * jcrc only. A hidden tab is not a guard, so this RECOMPUTES from a live role
 * read (I-5) rather than trusting the parent layout or the session copy. A head
 * or a resident who types the address is sent back to the admin overview (and
 * the admin layout above sends a plain resident on to the home page). Every
 * procedure behind these screens re-checks too; this only decides the page.
 */
export default async function TranscriptsAdminLayout({
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

  if (!canManageTranscriptPeriods(roles)) redirect("/admin");

  return <>{children}</>;
}
