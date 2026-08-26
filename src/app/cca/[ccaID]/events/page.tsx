import { notFound } from "next/navigation";

import EventsListPanel from "../../_components/EventsListPanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's events. No server guard — listForOwner carries the object-scoped
 * check (I-7), the same policy as the details section.
 *
 * The hrefs are passed IN because EventsListPanel also serves the hall-wide
 * surface at /admin/events, where there is no ccaID to build a path from.
 */
export default function CcaEventsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return (
    <EventsListPanel
      ccaID={ccaID}
      newHref={`/cca/${ccaID}/events/new`}
      manageHrefBase={`/cca/${ccaID}/events`}
    />
  );
}
