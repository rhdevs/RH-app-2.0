import EventCreateForm from "~/app/cca/_components/EventCreateForm";

/**
 * Create a HALL-WIDE event (D-20). ccaID null is what makes it hall-owned;
 * the server branches on it and requires manageHallEvents.
 */
export default function NewHallEventPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold text-gray-900">New event</h2>
      <EventCreateForm
        ccaID={null}
        backHref="/admin/events"
        manageHref={(eventID) => `/admin/events/hall/${eventID}`}
      />
    </div>
  );
}
