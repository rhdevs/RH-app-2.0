import { notFound } from "next/navigation";

import MilestoneScreen from "../../_components/MilestoneScreen";

/** One event's milestone. The procedures decide who may see it. */
export default function EventMilestonePage({
  params,
}: {
  params: { eventID: string };
}) {
  if (!/^\d{1,10}$/.test(params.eventID)) notFound();
  const eventID = Number(params.eventID);
  if (
    !Number.isSafeInteger(eventID) ||
    eventID <= 0 ||
    eventID > 2_147_483_647
  ) {
    notFound();
  }
  return <MilestoneScreen milestoneRef={{ kind: "event", eventID }} />;
}
