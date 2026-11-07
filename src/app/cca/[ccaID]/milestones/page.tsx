import { notFound } from "next/navigation";

import YearView from "~/app/milestones/_components/YearView";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's milestones by year. No server guard: the procedures check the flag
 * and that the caller is a head or director of THIS CCA.
 */
export default function CcaMilestonesTabPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return <YearView ccaID={ccaID} />;
}
