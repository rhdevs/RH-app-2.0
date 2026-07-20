import { notFound } from "next/navigation";

import { parseCcaID } from "../../_lib/ccaParam";
import InterviewSessions from "../../_components/InterviewSessions";

/** The "Interviews" tab: work through booked interviews and mark each done.
 *  Data comes from procedures that each call assertHeadsCca. */
export default function CcaSessionsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return <InterviewSessions ccaID={ccaID} />;
}
