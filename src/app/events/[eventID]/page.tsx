import { notFound } from "next/navigation";

import { HydrateClient } from "~/trpc/server";
import Header from "~/app/_components/header";
import EventDetail from "../_components/EventDetail";
import { parseCcaID } from "~/app/cca/_lib/ccaParam";

export default function EventPage({
  params,
}: {
  params: { eventID: string };
}) {
  const eventID = parseCcaID(params.eventID);
  if (eventID === null) notFound();

  return (
    <HydrateClient>
      <Header currentPage="Events" />
      <div className="min-h-[calc(100vh-4rem)] bg-gradient-to-br from-gray-50 to-gray-100 pb-20">
        <EventDetail eventID={eventID} />
      </div>
    </HydrateClient>
  );
}
