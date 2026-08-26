import { notFound } from "next/navigation";

import EventManage from "~/app/cca/_components/EventManage";
import { parseCcaID } from "~/app/cca/_lib/ccaParam";

/**
 * Manage one HALL-WIDE event (D-20). The flow inside EventManage depends on the
 * event's status. No server guard — every event.* procedure carries the
 * object-scoped check, and ccaID null routes to manageHallEvents.
 *
 * parseCcaID doubles as a positive-int parser for the eventID segment, exactly
 * as the /cca and /admin event routes use it. It rejects 0, which is why no
 * route segment can ever encode "hall" — hence this separate path prefix rather
 * than a magic /cca/0/events.
 */
export default function ManageHallEventPage({
  params,
}: {
  params: { eventID: string };
}) {
  const eventID = parseCcaID(params.eventID);
  if (eventID === null) notFound();

  return (
    <EventManage
      ccaID={null}
      eventID={eventID}
      backHref="/admin/events"
      // Duplicating lands on the COPY's own manage page, the same interaction
      // shape as create. Passed in because a hall event has no /cca/{id} route
      // to derive it from.
      manageHrefBase="/admin/events/hall"
    />
  );
}
