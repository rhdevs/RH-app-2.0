import { notFound } from "next/navigation";

import RosterPanel from "~/app/_components/RosterPanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The member list. A thin wrapper over the SAME RosterPanel that /admin/ccas
 * renders — one component, one query, so the head's view and the manager's view
 * cannot drift apart. Only the heading is suppressed, since the dashboard shell
 * already shows the CCA's name.
 */
export default function CcaMembersPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <RosterPanel ccaID={ccaID} hideHeader />;
}
