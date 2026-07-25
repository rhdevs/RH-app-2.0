import { HydrateClient } from "~/trpc/server";
import Header from "../_components/header";
import EventsTimeline from "./_components/EventsTimeline";

export default function EventsPage() {
  return (
    <HydrateClient>
      <Header currentPage="Events" />
      <div className="min-h-[calc(100vh-4rem)] bg-gradient-to-br from-gray-50 to-gray-100 pb-20">
        <EventsTimeline />
      </div>
    </HydrateClient>
  );
}
