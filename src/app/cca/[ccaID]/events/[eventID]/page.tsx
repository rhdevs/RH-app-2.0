import { notFound } from "next/navigation";

import EventManage from "../../../_components/EventManage";
import { parseCcaID } from "../../../_lib/ccaParam";

/**
 * Manage one CCA event. The flow inside EventManage depends on the event's
 * status. No server guard — every event.* procedure carries the object-scoped
 * check. parseCcaID doubles as a positive-int parser for the eventID segment.
 *
 * The hall-wide counterpart is /admin/events/hall/[eventID], which renders the
 * same component with ccaID={null}.
 */
export default function ManageEventPage({
  params,
}: {
  params: { ccaID: string; eventID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  const eventID = parseCcaID(params.eventID);
  if (ccaID === null || eventID === null) notFound();

  return (
    <EventManage
      ccaID={ccaID}
      eventID={eventID}
      backHref={`/cca/${ccaID}/events`}
      manageHrefBase={`/cca/${ccaID}/events`}
    />
  );
}
