import { notFound } from "next/navigation";

import ProposalEditor from "../../../_components/ProposalEditor";
import { parseCcaID } from "../../../_lib/ccaParam";

export default function NewProposalPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <ProposalEditor ccaID={ccaID} />;
}
