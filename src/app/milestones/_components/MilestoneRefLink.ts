import type { MilestoneRef } from "~/lib/milestones/open";

/** The screen for one milestone. */
export function milestoneHref(ref: MilestoneRef): string {
  return ref.kind === "event"
    ? `/milestones/event/${ref.eventID}`
    : `/milestones/proposal/${ref.proposalID}`;
}
