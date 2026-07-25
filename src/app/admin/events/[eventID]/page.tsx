import { notFound } from "next/navigation";

import EventReviewDetail from "../../_components/events/EventReviewDetail";
import { parseCcaID } from "~/app/cca/_lib/ccaParam";

export default function AdminEventDetailPage({
  params,
}: {
  params: { eventID: string };
}) {
  const eventID = parseCcaID(params.eventID);
  if (eventID === null) notFound();

  return <EventReviewDetail eventID={eventID} />;
}
