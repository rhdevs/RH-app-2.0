import { notFound } from "next/navigation";

import { parseCcaID } from "../../_lib/ccaParam";
import PointsWorkbench from "./_components/PointsWorkbench";

/**
 * Points entry for a CCA's heads. Everything here happens in the browser:
 * scores are typed, checked and exported as a CSV on the leader's own device
 * and are never sent to the server. The only server reads are the head-gated
 * ccaPoints.getEntryContext (ranges + open/closed) and cca.memberDirectory.
 */
export default function CcaPointsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <PointsWorkbench ccaID={ccaID} />;
}
