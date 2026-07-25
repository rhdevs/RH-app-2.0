import { notFound } from "next/navigation";

import EventsListPanel from "../../_components/EventsListPanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's events. No server guard — listMineForCca carries the object-scoped
 * check (I-7), the same policy as the details section.
 */
export default function CcaEventsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <EventsListPanel ccaID={ccaID} />;
}
