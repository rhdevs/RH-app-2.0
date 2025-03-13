"use client";

import { useState } from "react";
import { api } from "~/trpc/react";

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
              booking.slot.toISOString().slice(0, 16),
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

export default function DevelopmentPage() {
  const { data: bookings, refetch } = api.booking.getAll.useQuery();

  const createBooking = api.booking.create.useMutation({
    onSuccess: () => refetch(),
  });
  const updateBooking = api.booking.update.useMutation({
    onSuccess: () => refetch(),
  });
  const deleteBooking = api.booking.delete.useMutation({
    onSuccess: () => refetch(),
  });

  const [newSlot, setNewSlot] = useState("");
  const [newFacilityId, setNewFacilityId] = useState("");

  return (
    <div className="p-8">
      <h1 className="mb-4 text-3xl font-bold">Booking Management</h1>

      {/* Create New Booking */}
      <section className="mb-8 rounded border p-4">
        <h2 className="mb-2 text-xl font-semibold">Create New Booking</h2>
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
      </section>

      {/* List All Bookings */}
      <section className="mb-8">
        <h2 className="mb-2 text-xl font-semibold">All Bookings</h2>
        {bookings ? (
          <ul className="space-y-4">
            {bookings.map((booking) => (
              <BookingItem
                key={booking.id}
                booking={booking}
                onUpdate={(id, slot, facilityId) => {
                  updateBooking.mutate({
                    id,
                    slot,
                    facilityId,
                  });
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
      </section>
    </div>
  );
}
