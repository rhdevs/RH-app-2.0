import { notFound } from "next/navigation";

import DirectorProposal from "../../_components/DirectorProposal";

/** A proposal id is a 24-character hex ObjectId; anything else is a 404. */
const PROPOSAL_ID = /^[a-f\d]{24}$/i;

export default function DirectorProposalPage({
  params,
}: {
  params: { proposalID: string };
}) {
  if (!PROPOSAL_ID.test(params.proposalID)) notFound();
  return <DirectorProposal proposalID={params.proposalID} />;
}
