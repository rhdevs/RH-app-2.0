import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import AdminShell from "./_components/AdminShell";

/** Session-dependent. Never static, never ISR — a cached admin shell would be
 *  served to whoever asked for it next. */
export const dynamic = "force-dynamic";

/**
 * The route guard (03 §2, layer 2 of 3). It is DEFENCE IN DEPTH, not the
 * security boundary: a client can call api.admin.setUserRoles.mutate() from the
 * console on any page in the app, so every affordance behind this layout has an
 * independent procedure guard (I-7). What this buys is that no admin markup
 * ever streams to an unauthorised viewer.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  let roles: string[] = [];
  try {
    // LIVE database read, NOT session.user.roles (I-5). The session copy is
    // render-only; this is the last check before admin markup streams, and it
    // must see a demotion that happened after the JWT was minted.
    roles = await getUserRoles(db, session.user.userID);
  } catch {
    // Fail CLOSED, and swallow rather than rethrow. A segment's own error.tsx
    // does NOT catch an error thrown by that segment's layout.tsx, and the root
    // boundary would render over the whole app shell — so an Atlas hiccup here
    // would blank the app rather than deny one route. Redirecting home degrades
    // to "you are not an admin today", which is the safe direction.
    redirect("/");
  }

  const capabilities = computeCapabilities(roles);
  // redirect("/") and not a 403: an unauthorised viewer should not learn that
  // /admin exists at all.
  if (!capabilities.reachDashboard) redirect("/");

  return <AdminShell capabilities={capabilities}>{children}</AdminShell>;
}
