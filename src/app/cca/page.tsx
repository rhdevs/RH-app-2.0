import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import CcaIndex from "./_components/CcaIndex";

export const dynamic = "force-dynamic";

/**
 * A SERVER component, because the single-CCA passthrough is a redirect().
 * Doing it client-side with router.replace() would stream and paint the index
 * first, so a head of one CCA would see a pointless one-item list flash past on
 * every visit.
 */
export default async function CcaIndexPage() {
  const session = await auth();
  // The layout already established this; repeating it is cheap and keeps this
  // page correct if it is ever reached another way.
  if (!session?.user?.userID) redirect("/login");

  let roles: string[] = [];
  try {
    roles = await getUserRoles(db, session.user.userID); // I-5 live read
  } catch {
    redirect("/");
  }
  const capabilities = computeCapabilities(roles);

  const heads = await db.ccaHead.findMany({
    where: { userID: session.user.userID },
    select: { ccaID: true },
  });

  // THE PASSTHROUGH. Note `!capabilities.viewAnyCcaRoster`: an admin or jcrc who
  // happens to head exactly one CCA must NOT be teleported into it — they have
  // /admin/ccas for browsing and would otherwise be unable to reach their own
  // index at all.
  if (!capabilities.viewAnyCcaRoster && heads.length === 1) {
    redirect(`/cca/${heads[0]!.ccaID}`);
  }

  return <CcaIndex />;
}
