"use client";

import { useState } from "react";
import { api } from "~/trpc/react";

// ----- Booking Item Component -----
interface BookingItemProps {
  booking: {
    id: number;
    userId: string;
    facilityId: number;
    slot: Date;
  };
  onUpdate: (id: number, slot: Date, facilityId: number) => void;
  onDelete: (id: number) => void;
}

function BookingItem({ booking, onUpdate, onDelete }: BookingItemProps) {
  // Using getUserName endpoint to display username instead of raw userId
  const { data: username } = api.auth.getUserName.useQuery(booking.userId);

  return (
    <li key={booking.id} className="rounded border p-4">
      <div>
        <strong>Booking #{booking.id}</strong>
        <br />
        User: {username?.name ?? "Loading..."} | Facility: {booking.facilityId}
        <br />
        Slot: {new Date(booking.slot).toLocaleString()}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          className="rounded bg-green-500 p-2 text-white"
          onClick={() => {
            const newSlotVal = prompt(
              "Enter new slot (YYYY-MM-DDTHH:MM)",
              new Date(booking.slot).toISOString().slice(0, 16),
            );
            const newFacility = prompt(
              "Enter new facility id",
              booking.facilityId.toString(),
            );
            if (newSlotVal && newFacility) {
              onUpdate(
                booking.id,
                new Date(newSlotVal),
                parseInt(newFacility, 10),
              );
            }
          }}
        >
          Update
        </button>
        <button
          className="rounded bg-red-500 p-2 text-white"
          onClick={() => {
            if (confirm("Are you sure you want to delete this booking?")) {
              onDelete(booking.id);
            }
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

// ----- Event Item Component -----
interface EventItemProps {
  event: {
    id: number;
    location: string;
    slot: Date;
    description: string;
    signUpLink: string;
    organiserId: string;
  };
  onUpdate: (
    id: number,
    location: string,
    slot: Date,
    description: string,
    signUpLink: string,
  ) => void;
  onDelete: (id: number) => void;
}

function EventItem({ event, onUpdate, onDelete }: EventItemProps) {
  const { data: organiser } = api.auth.getUserName.useQuery(event.organiserId);
  return (
    <li key={event.id} className="rounded border p-4">
      <div>
        <strong>Event #{event.id}</strong>
        <br />
        Location: {event.location} <br />
        Slot: {new Date(event.slot).toLocaleString()} <br />
        Description: {event.description} <br />
        SignUp Link: {event.signUpLink} <br />
        Organiser: {organiser?.name ?? "Loading..."}
      </div>
      <div className="mt-2 flex gap-2">
        <button
          className="rounded bg-green-500 p-2 text-white"
          onClick={() => {
            const newLocation = prompt("Enter new location", event.location);
            const newSlotVal = prompt(
              "Enter new slot (YYYY-MM-DDTHH:MM)",
              new Date(event.slot).toISOString().slice(0, 16),
            );
            const newDescription = prompt(
              "Enter new description",
              event.description,
            );
            const newSignUpLink = prompt(
              "Enter new sign up link",
              event.signUpLink,
            );
            if (newLocation && newSlotVal && newDescription && newSignUpLink) {
              onUpdate(
                event.id,
                newLocation,
                new Date(newSlotVal),
                newDescription,
                newSignUpLink,
              );
            }
          }}
        >
          Update
        </button>
        <button
          className="rounded bg-red-500 p-2 text-white"
          onClick={() => {
            if (confirm("Are you sure you want to delete this event?")) {
              onDelete(event.id);
            }
          }}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

export default function DevelopmentPage() {
  const [activeTab, setActiveTab] = useState<"bookings" | "events">("bookings");

  // Bookings queries & mutations
  const { data: bookings, refetch: refetchBookings } =
    api.booking.getAll.useQuery();
  const createBooking = api.booking.create.useMutation({
    onSuccess: () => refetchBookings(),
  });
  const updateBooking = api.booking.update.useMutation({
    onSuccess: () => refetchBookings(),
  });
  const deleteBooking = api.booking.delete.useMutation({
    onSuccess: () => refetchBookings(),
  });
  const [newSlot, setNewSlot] = useState("");
  const [newFacilityId, setNewFacilityId] = useState("");

  // Events queries & mutations
  const { data: events, refetch: refetchEvents } = api.event.getAll.useQuery();
  const createEvent = api.event.create.useMutation({
    onSuccess: () => refetchEvents(),
  });
  const updateEvent = api.event.update.useMutation({
    onSuccess: () => refetchEvents(),
  });
  const deleteEvent = api.event.delete.useMutation({
    onSuccess: () => refetchEvents(),
  });
  const [newLocation, setNewLocation] = useState("");
  const [newEventSlot, setNewEventSlot] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newSignUpLink, setNewSignUpLink] = useState("");

  return (
    <div className="p-8">
      <h1 className="mb-4 text-3xl font-bold">Development Dashboard</h1>

      {/* Tabs */}
      <div className="mb-6 flex gap-4">
        <button
          className={`rounded px-4 py-2 ${
            activeTab === "bookings" ? "bg-blue-500 text-white" : "bg-gray-200"
          }`}
          onClick={() => setActiveTab("bookings")}
        >
          Bookings
        </button>
        <button
          className={`rounded px-4 py-2 ${
            activeTab === "events" ? "bg-blue-500 text-white" : "bg-gray-200"
          }`}
          onClick={() => setActiveTab("events")}
        >
          Events
        </button>
      </div>

      {activeTab === "bookings" && (
        <section className="mb-8">
          <h2 className="mb-2 text-xl font-semibold">Booking Management</h2>
          {/* Create New Booking */}
          <div className="mb-4 rounded border p-4">
            <h3 className="mb-2 text-lg font-semibold">Create New Booking</h3>
            <div className="flex flex-col gap-2">
              <input
                type="datetime-local"
                value={newSlot}
                onChange={(e) => setNewSlot(e.target.value)}
                className="border p-2"
              />
              <input
                type="number"
                placeholder="Facility Id"
                value={newFacilityId}
                onChange={(e) => setNewFacilityId(e.target.value)}
                className="border p-2"
              />
              <button
                className="rounded bg-blue-500 p-2 text-white"
                onClick={() => {
                  if (!newSlot || !newFacilityId) {
                    alert("Please enter both slot and facility id");
                    return;
                  }
                  createBooking.mutate({
                    slot: new Date(newSlot),
                    facilityId: parseInt(newFacilityId, 10),
                  });
                  setNewSlot("");
                  setNewFacilityId("");
                }}
              >
                Create Booking
              </button>
            </div>
          </div>

          {/* List All Bookings */}
          <div>
            <h3 className="mb-2 text-lg font-semibold">All Bookings</h3>
            {bookings ? (
              <ul className="space-y-4">
                {bookings.map((booking) => (
                  <BookingItem
                    key={booking.id}
                    booking={booking}
                    onUpdate={(id, slot, facilityId) => {
                      updateBooking.mutate({ id, slot, facilityId });
                    }}
                    onDelete={(id) => {
                      deleteBooking.mutate({ id });
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p>Loading bookings...</p>
            )}
          </div>
        </section>
      )}

      {activeTab === "events" && (
        <section className="mb-8">
          <h2 className="mb-2 text-xl font-semibold">Event Management</h2>
          {/* Create New Event */}
          <div className="mb-4 rounded border p-4">
            <h3 className="mb-2 text-lg font-semibold">Create New Event</h3>
            <div className="flex flex-col gap-2">
              <input
                type="text"
                placeholder="Location"
                value={newLocation}
                onChange={(e) => setNewLocation(e.target.value)}
                className="border p-2"
              />
              <input
                type="datetime-local"
                placeholder="Slot"
                value={newEventSlot}
                onChange={(e) => setNewEventSlot(e.target.value)}
                className="border p-2"
              />
              <input
                type="text"
                placeholder="Description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="border p-2"
              />
              <input
                type="url"
                placeholder="SignUp Link"
                value={newSignUpLink}
                onChange={(e) => setNewSignUpLink(e.target.value)}
                className="border p-2"
              />
              <button
                className="rounded bg-blue-500 p-2 text-white"
                onClick={() => {
                  if (!newLocation || !newEventSlot || !newDescription) {
                    alert("Please fill in all fields");
                    return;
                  }
                  createEvent.mutate({
                    location: newLocation,
                    slot: new Date(newEventSlot),
                    description: newDescription,
                    signUpLink: newSignUpLink,
                  });
                  setNewLocation("");
                  setNewEventSlot("");
                  setNewDescription("");
                  setNewSignUpLink("");
                }}
              >
                Create Event
              </button>
            </div>
          </div>

          {/* List All Events */}
          <div>
            <h3 className="mb-2 text-lg font-semibold">All Events</h3>
            {events ? (
              <ul className="space-y-4">
                {events.map((event) => (
                  <EventItem
                    key={event.id}
                    event={event}
                    onUpdate={(id, location, slot, description, signUpLink) => {
                      updateEvent.mutate({
                        id,
                        location,
                        slot,
                        description,
                        signUpLink,
                      });
                    }}
                    onDelete={(id) => {
                      deleteEvent.mutate(id);
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p>Loading events...</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
