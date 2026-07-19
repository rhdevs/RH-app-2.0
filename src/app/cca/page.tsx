import { redirect } from "next/navigation";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import CcaEmptyState from "./_components/CcaEmptyState";

export const dynamic = "force-dynamic";

/**
 * The entry point, and normally just a doorway.
 *
 * ANY headship redirects straight into that CCA's dashboard — not only when
 * there is exactly one, as before. The sidebar switcher now handles moving
 * between CCAs, so an intermediate "pick one" list is a click that buys nothing.
 *
 * A SERVER component, because that redirect must happen before render: a client
 * router.replace() would paint this page first and flash it away on every visit.
 */
export default async function CcaEntryPage() {
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

  const heads = await db.ccaHead.findMany({
    where: { userID: session.user.userID },
    select: { ccaID: true },
    orderBy: { ccaID: "asc" }, // deterministic landing CCA
  });

  if (heads.length > 0) redirect(`/cca/${heads[0]!.ccaID}`);

  // No headships. Reached by a manager who heads nothing, or by CH-1 drift —
  // a stale `cca_head` string whose CcaHead rows are gone. Both land somewhere
  // calm and honest rather than on an error.
  return (
    <CcaEmptyState
      canBrowseAll={computeCapabilities(roles).viewAnyCcaRoster}
    />
  );
}
