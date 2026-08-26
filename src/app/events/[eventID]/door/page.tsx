import { notFound } from "next/navigation";

import DoorScanner from "~/app/events/_components/DoorScanner";
import { parseCcaID } from "~/app/cca/_lib/ccaParam";

/**
 * The door surface for one event.
 *
 * NO SERVER GUARD HERE, deliberately and consistently with the rest of this
 * feature: every attendance procedure carries its own object-scoped check
 * (`assertMayScan`), re-reads roles live (I-5), and asserts BOTH kill switches.
 * A layout guard would be defence in depth at best and a second, drifting copy
 * of the rule at worst. `attendanceStatus` is what the page renders from, and it
 * answers "may I scan, is the window open, is it configured" honestly enough
 * that the page never has to guess.
 *
 * EVERY PROP CROSSING THIS BOUNDARY IS A SCALAR. This is a server component and
 * `DoorScanner` is a client component, so a function prop here would throw at
 * RENDER — "Functions cannot be passed directly to Client Components" — while
 * tsc, ESLint and `next build` all pass. That exact mistake once killed all five
 * event authoring routes in this repo and survived two adversarial review
 * passes; see the warning on `EventManage`'s `manageHrefBase`.
 *
 * `parseCcaID` doubles as a positive-int parser for the eventID segment, the
 * same way the other event routes use it.
 */
export default function EventDoorPage({
  params,
}: {
  params: { eventID: string };
}) {
  const eventID = parseCcaID(params.eventID);
  if (eventID === null) notFound();

  return <DoorScanner eventID={eventID} />;
}
