import { notFound } from "next/navigation";

import { parseCcaID } from "../../_lib/ccaParam";
import InterviewSlots from "../../_components/InterviewSlots";

/** Open and manage interview slots for a CCA the caller heads. Every procedure
 *  behind this re-checks with assertHeadsCca. */
export default function CcaInterviewsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return <InterviewSlots ccaID={ccaID} />;
}
