"use client";

import React, { useEffect, useState } from "react";
import {
  X,
  Calendar as CalendarIcon,
  Clock,
  MapPin,
  User,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { format } from "date-fns";
import { api } from "~/trpc/react";
import Toast from "./Toast";

interface Facility {
  facilityID: number;
  facilityName: string;
  facilityLocation: string;
}

interface BookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  facilities: Facility[];
  userId?: string;
  currentDate: Date;
  refetch: () => void;
}

const BookingModal: React.FC<BookingModalProps> = ({
  isOpen,
  onClose,
  facilities,
  userId,
  currentDate,
  refetch,
}) => {
  const [startDate, setStartDate] = useState(currentDate);
  const [endDate, setEndDate] = useState(currentDate);
  const [selectedFacility, setSelectedFacility] = useState<string>("");
  const [eventName, setEventName] = useState<string>("");
  const [startTime, setStartTime] = useState<string>("09:00");
  const [endTime, setEndTime] = useState<string>("10:00");
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
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

  const createBooking = api.bookings.createBooking.useMutation({
    onSuccess: () => {
      onClose();
      refetch();
    },
    onError: (error) => {
      setToastContent(error.message ?? "Booking failed");
      setToastOpen(true);
      setToastType("danger");
    },
  });

  const handleSubmit = () => {
    if (!userId || !selectedFacility || !startTime || !endTime) {
      console.error("Missing required fields");
      return;
    }
    const startDateTime = new Date(startDate);
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const endDateTime = new Date(endDate);
    const [endHour, endMinute] = endTime.split(":").map(Number);
    if (startHour !== undefined && endHour !== undefined) {
      startDateTime.setHours(startHour, startMinute, 0, 0);

      endDateTime.setHours(endHour, endMinute, 0, 0);

      createBooking.mutate({
        ccaID: 0,
        eventName: eventName,
        endTime: Number(Math.floor(endDateTime.getTime() / 1000)),
        facilityID: Number(
          facilities.find((e) => e.facilityName == selectedFacility)
            ?.facilityID,
        ),
        startTime: Number(Math.floor(startDateTime.getTime() / 1000)),
        userID: userId,
        forceBook: false,
        bookUntil: Math.floor(endDateTime.getTime() / 1000),
        repeat: 0,
        description: "",
      });
    }
  };

  useEffect(() => {
    setStartDate(currentDate);
    setEndDate(currentDate);
  }, [currentDate]);

  return !isOpen ? (
    <></>
  ) : (
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
            <h2 className="text-lg font-semibold">Book a Facility</h2>
            <button onClick={onClose}>
              <X className="h-5 w-5 text-gray-500" />
            </button>
          </div>

          <div className="space-y-4 p-4">
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
                      >
                        {" "}
                        <ChevronLeft className="h-4 w-4" />{" "}
                      </button>
                      <span>{format(date, "eeee, MMM d yyyy")}</span>
                      <button
                        onClick={() =>
                          handleDateChange(type as "start" | "end", "next")
                        }
                      >
                        {" "}
                        <ChevronRight className="h-4 w-4" />{" "}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                <MapPin className="mr-1 inline h-4 w-4" /> Facility
              </label>
              <select
                value={selectedFacility}
                onChange={(e) => setSelectedFacility(e.target.value)}
                className="w-full rounded-lg border border-gray-300 p-3"
              >
                <option value="">Select a facility</option>
                {[...facilities]
                  .sort((a, b) => a.facilityName.localeCompare(b.facilityName))
                  .map((f) => (
                  <option key={f.facilityID} value={f.facilityName}>
                    {f.facilityName} - {f.facilityLocation}
                  </option>
                  ))}
              </select>
            </div>
            {selectedFacility === "Dance Studio" && (
              <p className="text-sm text-red-600">
                Note: Dance Studio cannot be booked in this app. To book the Dance Studio, please approach the Dance CCA Exco.
              </p>
            )}

            <div className="grid grid-cols-2 gap-10">
              {["Start Time", "End Time"].map((label, idx) => (
                <div key={label} className="">
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
                    className="w-4/5 rounded-lg border border-gray-300 p-3"
                  />
                </div>
              ))}
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                <User className="mr-1 inline h-4 w-4" /> Event Name
              </label>
              <input
                type="text"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                className="w-full rounded-lg border border-gray-300 p-3"
                placeholder="Your event name"
              />
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={handleSubmit}
                disabled={!selectedFacility || !eventName || selectedFacility === "Dance Studio"}
                className="rounded-lg bg-emerald-600 px-6 py-2 text-white hover:bg-emerald-700 disabled:bg-gray-300"
              >
                Confirm Booking
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default BookingModal;
