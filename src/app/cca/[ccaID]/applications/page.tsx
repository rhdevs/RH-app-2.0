import { notFound } from "next/navigation";

import { parseCcaID } from "../../_lib/ccaParam";
import ApplicationsReview from "../../_components/ApplicationsReview";

/** The head's application review queue. Data comes from procedures that each
 *  call assertHeadsCca, so this page is chrome, not the boundary. */
export default function CcaApplicationsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return <ApplicationsReview ccaID={ccaID} />;
}
