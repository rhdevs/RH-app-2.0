import { notFound } from "next/navigation";

import ProposalEditor from "../../../_components/ProposalEditor";
import { parseCcaID } from "../../../_lib/ccaParam";

/** A proposal id is a 24-character hex ObjectId; anything else is a 404. */
const PROPOSAL_ID = /^[a-f\d]{24}$/i;

export default function ProposalPage({
  params,
}: {
  params: { ccaID: string; proposalID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null || !PROPOSAL_ID.test(params.proposalID)) notFound();

  return <ProposalEditor ccaID={ccaID} proposalID={params.proposalID} />;
}
