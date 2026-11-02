import { notFound } from "next/navigation";

import MilestoneScreen from "../../_components/MilestoneScreen";

/** A finished proposal with no event: its milestone. */
export default function ProposalMilestonePage({
  params,
}: {
  params: { proposalID: string };
}) {
  if (!/^[a-f\d]{24}$/i.test(params.proposalID)) notFound();
  return (
    <MilestoneScreen
      milestoneRef={{ kind: "proposal", proposalID: params.proposalID }}
    />
  );
}
