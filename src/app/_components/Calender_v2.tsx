"use client";

import React, { useState, useMemo } from "react";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Plus,
  Clock,
  Filter,
  ChevronDown,
} from "lucide-react";
import { api } from "~/trpc/react";
import {
  endOfMonth,
  getUnixTime,
  startOfMonth,
  set,
  format,
  fromUnixTime,
  eachDayOfInterval,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  isToday,
  isSameDay,
  parseISO,
} from "date-fns";
import Loading from "./Loading";
import { Session } from "next-auth";
import Toast from "./Toast";

function classNames(...classes: (string | boolean | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

interface CalendarProps {
  session: Session | null;
}

const Calendar_v2: React.FC<CalendarProps> = ({ session }) => {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [facility, setFacility] = useState<number>(-1);
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);

  const [start, setStart] = useState(getUnixTime(monthStart));
  const [end, setEnd] = useState(getUnixTime(monthEnd));

  const handleDateClick = (date: Date) => {
    // Check if the clicked date is not in the current month
    if (!isSameMonth(date, currentMonth)) {
      // Navigate to the appropriate month
      const newMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      setCurrentMonth(newMonth);
      setStart(getUnixTime(startOfMonth(newMonth)));
      setEnd(getUnixTime(endOfMonth(newMonth)));
    }
    setSelectedDate(date);
  };

  const bookingsInMonth = api.bookings.getBookings.useQuery({
    startTime: start,
    endTime: end,
    ...(facility !== -1 ? { facilityID: facility } : {}),
  });

  const facilitiesQuery = api.bookings.getAllFacilities.useQuery();

  const facilities = useMemo(() => {
    const baseFacilities = facilitiesQuery.data ?? [];
    return [
      {
        id: "",
        facilityName: "All Facilities",
        facilityLocation: "",
        facilityID: -1,
      },
      ...baseFacilities,
    ];
  }, [facilitiesQuery.data]);

  const selectedFacility = facilities.find((f) => f.facilityID === facility);

  const calendarDays = useMemo(() => {
    const calendarStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const calendarEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

    return eachDayOfInterval({ start: calendarStart, end: calendarEnd }).map(
      (date) => ({
        date,
        isCurrentMonth: isSameMonth(date, currentMonth),
        isToday: isToday(date),
        isSelected: isSameDay(date, selectedDate),
        hasEvent: false,
      }),
    );
  }, [currentMonth, selectedDate]);

  const processedBookings = useMemo(() => {
    if (!bookingsInMonth.data) return [];

    return bookingsInMonth.data.map((booking: any) => ({
      id: booking.id || Math.random().toString(),
      title: booking.title || "Untitled Event",
      start: booking.start ? new Date(booking.start) : new Date(),
      end: booking.end ? new Date(booking.end) : new Date(),
      // Format for display
      date: booking.start
        ? format(new Date(booking.start), "MMMM do, yyyy")
        : "",
      time: booking.start ? format(new Date(booking.start), "h:mm a") : "",
      endTime: booking.end ? format(new Date(booking.end), "h:mm a") : "",
      location: booking.location || "TBD",
      status: booking.status || "confirmed",
    }));
  }, [bookingsInMonth.data]);

  const calendarDaysWithEvents = useMemo(() => {
    return calendarDays.map((day) => ({
      ...day,
      hasEvent: processedBookings.some((booking) =>
        isSameDay(booking.start, day.date),
      ),
    }));
  }, [calendarDays, processedBookings]);

  const eventsForSelectedDate = useMemo(() => {
    return processedBookings.filter((booking) =>
      isSameDay(booking.start, selectedDate),
    );
  }, [processedBookings, selectedDate]);

  const navigateMonth = (direction: "prev" | "next") => {
    const newMonth = new Date(currentMonth);
    if (direction === "prev") {
      newMonth.setMonth(newMonth.getMonth() - 1);
    } else {
      newMonth.setMonth(newMonth.getMonth() + 1);
    }
    setCurrentMonth(newMonth);
    setStart(getUnixTime(startOfMonth(newMonth)));
    setEnd(getUnixTime(endOfMonth(newMonth)));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "confirmed":
        return "bg-green-100 text-green-800";
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "cancelled":
        return "bg-red-100 text-red-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const handleFacilityChange = (facilityID: number) => {
    setFacility(facilityID);
    setIsFilterDropdownOpen(false);
  };

  if (bookingsInMonth.isLoading || facilitiesQuery.isLoading) {
    return <Loading />;
  }

  const bookFacility = () => {
    if (!session) {
      setToastContent("Log in to book facility!");
      setToastOpen(true);
      setToastType("danger");
    }
  };

  return (
    <div className="">
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 flex items-center justify-between">
          <div></div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsFilterDropdownOpen(!isFilterDropdownOpen)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              <Filter className="h-4 w-4" />
              <span className="max-w-40 truncate">
                {selectedFacility?.facilityName || "All Facilities"}
              </span>
              <ChevronDown className="h-4 w-4" />
            </button>

            {isFilterDropdownOpen && (
              <div className="absolute right-0 z-10 mt-2 w-64 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none">
                <div className="max-h-60 overflow-y-auto py-1">
                  {facilities.map((facilityOption) => (
                    <button
                      key={facilityOption.facilityID}
                      onClick={() =>
                        handleFacilityChange(facilityOption.facilityID)
                      }
                      className={classNames(
                        "flex w-full items-center px-4 py-2 text-left text-sm hover:bg-gray-100",
                        facility === facilityOption.facilityID
                          ? "bg-indigo-50 text-indigo-700"
                          : "text-gray-700",
                      )}
                    >
                      <div className="flex-1">
                        <div className="font-medium">
                          {facilityOption.facilityName}
                        </div>
                      </div>
                      {facility === facilityOption.facilityID && (
                        <div className="ml-2 h-2 w-2 rounded-full bg-indigo-600"></div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-12 lg:gap-8">
          <div className="lg:col-span-5 xl:col-span-4">
            <div className="h-[450px] rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl font-semibold text-gray-900">
                  {format(currentMonth, "MMMM yyyy")}
                </h2>
                <div className="flex items-center space-x-1">
                  <button
                    type="button"
                    onClick={() => navigateMonth("prev")}
                    className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateMonth("next")}
                    className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="mb-2 grid grid-cols-7 gap-1">
                {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
                  (day) => (
                    <div
                      key={day}
                      className="py-2 text-center text-xs font-medium text-gray-500"
                    >
                      {day}
                    </div>
                  ),
                )}
              </div>

              <div className="grid grid-cols-7 gap-1">
                {calendarDaysWithEvents.map((day, dayIdx) => {
                  const dayNumber = format(day.date, "d");

                  return (
                    <button
                      key={day.date.toISOString()}
                      type="button"
                      onClick={() => handleDateClick(day.date)}
                      className={classNames(
                        "relative rounded-lg p-2 text-sm font-medium transition-all duration-200 hover:bg-gray-50",
                        day.isCurrentMonth ? "text-gray-900" : "text-gray-400",
                        day.isSelected &&
                          "bg-indigo-600 text-white hover:bg-indigo-700",
                        day.isToday &&
                          !day.isSelected &&
                          "bg-indigo-50 font-semibold text-indigo-600",
                        !day.isCurrentMonth && "hover:bg-gray-25",
                      )}
                    >
                      <span className="relative z-10">{dayNumber}</span>
                      {day.hasEvent && (
                        <div
                          className={classNames(
                            "absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 transform rounded-full",
                            day.isSelected ? "bg-white" : "bg-indigo-600",
                          )}
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => bookFacility()}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white transition-colors hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                <Plus className="h-5 w-5" />
                Book Facility
              </button>
            </div>
          </div>

          <div className="mt-8 lg:col-span-7 lg:mt-0 xl:col-span-8">
            <div className="flex h-[450px] flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
              <div className="flex-shrink-0 border-b border-gray-200 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-900">
                      {isSameDay(selectedDate, new Date())
                        ? "Today's Events"
                        : `Events for ${format(selectedDate, "MMMM do, yyyy")}`}
                    </h2>
                    <p className="mt-1 text-sm text-gray-600">
                      {eventsForSelectedDate.length} event
                      {eventsForSelectedDate.length !== 1 ? "s" : ""} scheduled
                      {facility !== -1 && selectedFacility && (
                        <span className="ml-2 text-indigo-600">
                          • {selectedFacility.facilityName}
                        </span>
                      )}
                    </p>
                  </div>
                  {facility !== -1 && (
                    <button
                      onClick={() => setFacility(-1)}
                      className="text-sm text-indigo-600 hover:text-indigo-700"
                    >
                      Clear filter
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto">
                <div className="divide-y divide-gray-100">
                  {eventsForSelectedDate.map((booking) => (
                    <div
                      key={booking.id}
                      className="cursor-pointer p-6 transition-colors hover:bg-gray-50"
                    >
                      <div className="flex items-start gap-4">
                        {/* Event Icon */}
                        <div className="flex-shrink-0">
                          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100">
                            <Calendar className="h-6 w-6 text-indigo-600" />
                          </div>
                        </div>

                        {/* Content */}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between">
                            <div>
                              <h3 className="mb-1 text-lg font-semibold text-gray-900">
                                {booking.title}
                              </h3>
                              <div className="flex items-center gap-4 text-sm text-gray-600">
                                <div className="flex items-center gap-1.5">
                                  <Clock className="h-4 w-4" />
                                  <span>
                                    {booking.time}
                                    {booking.endTime &&
                                      booking.endTime !== booking.time &&
                                      ` - ${booking.endTime}`}
                                  </span>
                                </div>
                                {booking.location &&
                                  booking.location !== "TBD" && (
                                    <div className="flex items-center gap-1.5">
                                      <MapPin className="h-4 w-4" />
                                      <span>{booking.location}</span>
                                    </div>
                                  )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {eventsForSelectedDate.length === 0 && (
                  <div className="py-12 text-center">
                    <Calendar className="mx-auto mb-4 h-12 w-12 text-gray-400" />
                    <h3 className="mb-2 text-lg font-medium text-gray-900">
                      No events scheduled
                    </h3>
                    <p className="text-gray-600">
                      {facility !== -1 && selectedFacility ? (
                        <>
                          No events for {selectedFacility.facilityName} on{" "}
                          {isSameDay(selectedDate, new Date())
                            ? "today"
                            : "this date"}
                          .
                        </>
                      ) : (
                        <>
                          {isSameDay(selectedDate, new Date())
                            ? "You have no events today."
                            : "No events scheduled for this date."}
                        </>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Calendar_v2;
