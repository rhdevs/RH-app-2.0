import { notFound } from "next/navigation";

import RosterPanel from "~/app/_components/RosterPanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The member list. The SAME RosterPanel that /admin/ccas renders, but with
 * `manageMembers` on: a head can remove members from their own roster here.
 * The heading is suppressed because the dashboard shell already shows the name.
 *
 * The read-only /admin/ccas viewer omits `manageMembers`, so removal is a
 * head-surface affordance only — admins prune from /admin/manage-ccas. Either
 * way cca.removeMember re-checks with assertHeadsCca, so the flag is UI, not
 * the boundary.
 */
export default function CcaMembersPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <RosterPanel ccaID={ccaID} hideHeader manageMembers />;
}
