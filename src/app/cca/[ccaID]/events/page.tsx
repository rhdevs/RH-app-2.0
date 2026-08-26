import { notFound } from "next/navigation";

import EventsListPanel from "../../_components/EventsListPanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's events. No server guard — listForOwner carries the object-scoped
 * check (I-7), the same policy as the details section.
 *
 * `manageHrefBase` is passed IN because EventsListPanel also serves the
 * hall-wide surface at /admin/events, where there is no ccaID to build a path
 * from. It is a STRING and must stay one: this is a SERVER component, and React
 * refuses to serialise a function across the boundary — the throw happens at
 * RENDER, so tsc, lint and `next build` all pass while the route 500s.
 *
 * There is no `newHref`. "New event" is a mutation button inside the panel now
 * (D-29); the /new route is gone.
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
      manageHrefBase={`/cca/${ccaID}/events`}
    />
  );
}
