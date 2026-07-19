"use client";

import React, { useEffect, useState } from "react";
import {
  X,
  Calendar as CalendarIcon,
  Clock,
  User,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { format } from "date-fns";
import { api } from "~/trpc/react";
import Toast from "./Toast";
import type { BookingData } from "~/types/booking";

interface EditBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  booking: BookingData | null;
}

const EditBookingModal: React.FC<EditBookingModalProps> = ({
  isOpen,
  onClose,
  booking,
}) => {
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [eventName, setEventName] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [toastContent, setToastContent] = useState("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState(false);

  // Initialize form data when booking changes
  useEffect(() => {
    if (booking) {
      setStartDate(new Date(booking.start));
      setEndDate(new Date(booking.end));
      setEventName(booking.eventName ?? "");
      setStartTime(format(booking.start, "HH:mm"));
      setEndTime(format(booking.end, "HH:mm"));
    }
  }, [booking]);

  const updateBooking = api.bookings.updateBooking.useMutation({
    onSuccess: () => {
      setToastContent("Booking updated successfully");
      setToastType("success");
      setToastOpen(true);
      setTimeout(() => {
        onClose();
      }, 1000);
    },
    onError: (error) => {
      setToastContent(error.message ?? "Failed to update booking");
      setToastOpen(true);
      setToastType("danger");
    },
  });

  const handleDateChange = (
    type: "start" | "end",
    direction: "prev" | "next",
  ) => {
    const current = type === "start" ? startDate : endDate;
    const other = type === "start" ? endDate : startDate;

    const newDate = new Date(current);
    newDate.setDate(newDate.getDate() + (direction === "prev" ? -1 : 1));

    if (type === "start" && newDate <= other) {
      setStartDate(newDate);
    } else if (type === "end" && newDate >= other) {
      setEndDate(newDate);
    }
  };

  const handleSubmit = () => {
    if (!booking || !eventName.trim()) {
      setToastContent("Event name is required");
      setToastType("danger");
      setToastOpen(true);
      return;
    }

    const startDateTime = new Date(startDate);
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const endDateTime = new Date(endDate);
    const [endHour, endMinute] = endTime.split(":").map(Number);

    if (startHour !== undefined && endHour !== undefined) {
      startDateTime.setHours(startHour, startMinute, 0, 0);
      endDateTime.setHours(endHour, endMinute, 0, 0);

      if (endDateTime <= startDateTime) {
        setToastContent("End time must be after start time");
        setToastType("danger");
        setToastOpen(true);
        return;
      }

      updateBooking.mutate({
        id: booking.id,
        eventName: eventName.trim(),
        startTime: Math.floor(startDateTime.getTime() / 1000),
        endTime: Math.floor(endDateTime.getTime() / 1000),
      });
    }
  };

  if (!isOpen || !booking) {
    return null;
  }

  return (
    <>
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
        <div className="relative w-full max-w-2xl rounded-xl bg-white shadow-xl">
          <div className="flex items-center justify-between border-b p-4">
            <h2 className="text-lg font-semibold">Edit Booking</h2>
            <button onClick={onClose} className="rounded p-1 hover:bg-gray-100">
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>

          <div className="space-y-4 p-4">
            {/* Facility Display (Read-only) */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Facility (cannot be changed)
              </label>
              <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-3 text-gray-600">
                {booking.title}
              </div>
            </div>

            {/* Date Selection */}
            <div className="grid grid-cols-2 gap-4">
              {["start", "end"].map((type) => {
                const date = type === "start" ? startDate : endDate;
                return (
                  <div key={type}>
                    <label className="mb-1 block text-sm font-medium text-gray-700">
                      <CalendarIcon className="mr-1 inline h-4 w-4" />
                      {type === "start" ? "Start Date" : "End Date"}
                    </label>
                    <div className="flex items-center justify-between rounded-lg bg-gray-100 p-2">
                      <button
                        onClick={() =>
                          handleDateChange(type as "start" | "end", "prev")
                        }
                        className="rounded p-1 hover:bg-gray-200"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <span className="text-sm font-medium">
                        {format(date, "eeee, MMM d yyyy")}
                      </span>
                      <button
                        onClick={() =>
                          handleDateChange(type as "start" | "end", "next")
                        }
                        className="rounded p-1 hover:bg-gray-200"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Time Selection */}
            <div className="grid grid-cols-2 gap-4">
              {["Start Time", "End Time"].map((label, idx) => (
                <div key={label}>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    <Clock className="mr-1 inline h-4 w-4" /> {label}
                  </label>
                  <input
                    type="time"
                    value={idx === 0 ? startTime : endTime}
                    onChange={(e) =>
                      idx === 0
                        ? setStartTime(e.target.value)
                        : setEndTime(e.target.value)
                    }
                    className="w-full rounded-lg border border-gray-300 p-3 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              ))}
            </div>

            {/* Event Name */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                <User className="mr-1 inline h-4 w-4" /> Event Name *
              </label>
              <input
                type="text"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 p-3 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500"
                placeholder="Enter event name"
                required
              />
            </div>

            {/* Action Buttons */}
            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 px-6 py-2 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!eventName.trim() || updateBooking.isPending}
                className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {updateBooking.isPending ? "Updating..." : "Update Booking"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default EditBookingModal;
