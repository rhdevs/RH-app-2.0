import EventReviewQueue from "../_components/events/EventReviewQueue";
import HallEventsPanel from "../_components/events/HallEventsPanel";

/**
 * Two surfaces, one page: the JCRC's own hall-wide events (which never queue —
 * "Register and publish" submits and approves back to back), and the review
 * queue for everyone else's.
 */
export default function AdminEventsPage() {
  return (
    <div className="space-y-8">
      <HallEventsPanel />
      <EventReviewQueue />
    </div>
  );
}
