import { notFound } from "next/navigation";

import { parseCcaID } from "~/app/cca/_lib/ccaParam";
import YearView from "../_components/YearView";

/** One CCA's milestones by academic year. The procedure decides who may read. */
export default function CcaMilestonesPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return <YearView ccaID={ccaID} />;
}
