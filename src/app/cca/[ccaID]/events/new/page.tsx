import { notFound } from "next/navigation";

import EventCreateForm from "../../../_components/EventCreateForm";
import { parseCcaID } from "../../../_lib/ccaParam";

export default function NewEventPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">New event</h2>
      <EventCreateForm
        ccaID={ccaID}
        backHref={`/cca/${ccaID}/events`}
        manageHref={(eventID) => `/cca/${ccaID}/events/${eventID}`}
      />
    </div>
  );
}
