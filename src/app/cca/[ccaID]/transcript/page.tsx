import { notFound } from "next/navigation";

import { parseCcaID } from "../../_lib/ccaParam";
import TranscriptTab from "./_components/TranscriptTab";

/**
 * The CCA's transcript annotations: who was in for how long, roles, extra
 * contributions and, for a volunteering CCA, volunteer hours.
 *
 * No server-side guard here, matching the sibling sections: every procedure
 * behind it checks that the caller heads THIS CCA (or is a manager), so a head
 * of another CCA sees this shell and then a refusal inside it.
 */
export default function CcaTranscriptPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <TranscriptTab ccaID={ccaID} />;
}
