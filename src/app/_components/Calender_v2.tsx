"use client";

import React, { useState, useMemo, useEffect } from "react";
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
  startOfDay,
  endOfDay,
} from "date-fns";
import Loading from "./Loading";
import Toast from "./Toast";
import { useSession } from "next-auth/react";
import BookingModal from "./BookingModal";

function classNames(...classes: (string | boolean | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

const Calendar_v2: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [facility, setFacility] = useState<number>(-1);
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [checkOwnBookings, setCheckOwnBookings] = useState<boolean>(false);
  const [bookingModalOpen, setBookingModalOpen] = useState<boolean>(false);

  const { data: session } = useSession();
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);

  const [start, setStart] = useState(getUnixTime(monthStart));
  const [end, setEnd] = useState(getUnixTime(monthEnd));

  const handleDateClick = (date: Date) => {
    if (!isSameMonth(date, currentMonth)) {
      const newMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      setCurrentMonth(newMonth);
      setStart(getUnixTime(startOfMonth(newMonth)));
      setEnd(getUnixTime(endOfMonth(newMonth)));
    }
    setSelectedDate(date);
  };

  const {
    data: bookingsInMonth = [],
    isLoading,
    refetch: refetchBookingsInMonth,
  } = api.bookings.getBookings.useQuery(
    {
      startTime: start,
      endTime: end,
      ...(facility !== -1 ? { facilityID: facility } : {}),
      ...(checkOwnBookings ? { userId: session?.user?.userID } : {}),
    },
    {
      enabled: !checkOwnBookings || !!session?.user?.userID,
    },
  );
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
    if (!bookingsInMonth) return [];

    return bookingsInMonth.map((booking: any) => {
      const start = booking.start ? new Date(booking.start) : new Date();
      const end = booking.end ? new Date(booking.end) : new Date();

      const isFullDay =
        start.getHours() === 0 &&
        start.getMinutes() === 0 &&
        end.getHours() === 0 &&
        end.getMinutes() === 0 &&
        end.getTime() - start.getTime() === 24 * 60 * 60 * 1000;

      return {
        id: booking.id || Math.random().toString(),
        title: booking.title || "Untitled Event",
        start,
        end,
        date: format(start, "MMMM do, yyyy"),
        time: isFullDay ? "All day" : format(start, "h:mm a"),
        endTime: isFullDay ? "" : format(end, "h:mm a"),
        location: booking.location || "TBD",
        status: booking.status || "confirmed",
        category: booking.category || "default",
        user: booking.user,
        eventName: booking.eventName,
      };
    });
  }, [bookingsInMonth]);

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

  const handleFacilityChange = (facilityID: number) => {
    setFacility(facilityID);
    setIsFilterDropdownOpen(false);
  };

  const getFacilityColor = (facility: string) => {
    switch (facility) {
      case "Main Area (UL)":
        return "bg-green-100 text-green-800 border-green-800";
      case "UL Conf Rm":
        return "bg-red-100 text-red-800 border-red-800";
      case "Alumni Room":
        return "bg-blue-100 text-blue-800 border-blue-800";
      case "Heritage Corner":
        return "bg-orange-100 text-orange-800 border-orange-800";
      case "Stage":
        return "bg-amber-100 text-amber-800 border-amber-800";
      case "Comm Hall (Front)":
        return "bg-lime-100 text-lime-800 border-lime-800";
      case "Band Room":
        return "bg-teal-100 text-teal-800 border-teal-800";
      case "Pool Area":
        return "bg-cyan-100 text-cyan-800 border-cyan-800";
      case "TV Room":
        return "bg-sky-100 text-sky-800 border-sky-800";
      case "Meeting Room":
        return "bg-indigo-100 text-indigo-800 border-indigo-800";
      case "Kuok Conf Rm":
        return "bg-violet-100 text-violet-800 border-violet-800";
      case "Hard Court":
        return "bg-rose-100 text-rose-800 border-rose-800";
      case "Basketball Court":
        return "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-800";
      case "Dance Studio":
        return "bg-pink-100 text-pink-800 border-pink-800";
      case "Comm Hall (Back)":
        return "bg-emerald-100 text-emerald-800 border-emerald-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  if (isLoading || facilitiesQuery.isLoading) {
    return (
      <div className="mt-40 flex items-center justify-center">
        <Loading />
      </div>
    );
  }

  const bookFacility = () => {
    if (!session) {
      setToastContent("Log in to book facility!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }
    setBookingModalOpen(true);
  };

  return (
    <div className="">
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <BookingModal
        isOpen={bookingModalOpen}
        onClose={() => setBookingModalOpen(false)}
        bookings={bookingsInMonth ?? []}
        facilities={facilities}
        userId={session?.user?.userID}
        currentDate={selectedDate}
        refetch={refetchBookingsInMonth}
      />
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div className="mb-8 flex items-center justify-end gap-x-4">
          <div
            onClick={() => setCheckOwnBookings(!checkOwnBookings)}
            className="rounded-full bg-emerald-700 px-4 py-1 text-white hover:bg-emerald-900"
          >
            {checkOwnBookings ? "All Bookings" : "My Bookings"}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsFilterDropdownOpen(!isFilterDropdownOpen)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Filter className="h-4 w-4" />
              <span className="max-w-40 truncate">
                {selectedFacility?.facilityName || "All Facilities"}
              </span>
              <ChevronDown className="h-4 w-4" />
            </button>

            {isFilterDropdownOpen && (
              <div className="absolute right-0 z-20 mt-2 w-64 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5">
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
                          ? "bg-gray-100 text-gray-900"
                          : "text-gray-700",
                      )}
                    >
                      <div className="flex-1">
                        <div className="font-medium">
                          {facilityOption.facilityName}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-500">
          Current View:{" "}
          {checkOwnBookings
            ? `My Bookings (${session?.user?.userID ?? "..."})`
            : "All Bookings"}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="h-[500px] rounded-lg border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-200 p-6">
                <button
                  onClick={() => navigateMonth("prev")}
                  className="rounded-lg p-2 hover:bg-gray-100"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>

                <h2 className="text-xl font-semibold text-gray-900">
                  {format(currentMonth, "MMM yyyy").toUpperCase()}
                </h2>

                <button
                  onClick={() => navigateMonth("next")}
                  className="rounded-lg p-2 hover:bg-gray-100"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </div>
              <div className="p-6">
                <div className="mb-4 grid grid-cols-7 gap-1">
                  {["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map(
                    (day) => (
                      <div
                        key={day}
                        className="py-3 text-center text-xs font-medium text-gray-500"
                      >
                        {day}
                      </div>
                    ),
                  )}
                </div>

                <div className="grid grid-cols-7 gap-1">
                  {calendarDaysWithEvents.map((day) => {
                    const dayNumber = format(day.date, "d");
                    const isWeekend = [0, 6].includes(day.date.getDay());

                    return (
                      <button
                        key={day.date.toISOString()}
                        onClick={() => handleDateClick(day.date)}
                        className={classNames(
                          "relative h-12 w-full rounded-lg text-sm font-medium transition-all",
                          day.isCurrentMonth
                            ? "text-gray-900"
                            : "text-gray-400",
                          day.isSelected && "bg-gray-900 text-white",
                          !day.isSelected &&
                            day.isToday &&
                            "bg-gray-100 text-gray-900",
                          !day.isSelected && !day.isToday && "hover:bg-gray-50",
                          isWeekend &&
                            day.isCurrentMonth &&
                            !day.isSelected &&
                            "text-red-600",
                        )}
                      >
                        {dayNumber}
                        {day.hasEvent && (
                          <div className="absolute bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 transform rounded-full bg-gray-900" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5">
            <div className="flex max-h-[450px] min-h-[500px] flex-col rounded-lg border border-gray-200 bg-white shadow-sm">
              <div className="border-b border-gray-200 p-6">
                <div className="flex justify-between">
                  <div className="flex items-center">
                    <button
                      onClick={bookFacility}
                      className="inline-flex items-center gap-2 rounded-full bg-emerald-700 px-4 py-1 text-white hover:bg-emerald-900"
                    >
                      <Plus className="h-4 w-4" />
                      Book a Facility
                    </button>
                  </div>
                  <div>
                    <div className="text-3xl font-bold text-gray-900">
                      {format(selectedDate, "d")}{" "}
                      {format(selectedDate, "MMM").toUpperCase()}
                    </div>
                    <div className="text-sm text-gray-500">
                      {format(selectedDate, "EEEE")}
                    </div>
                  </div>
                </div>
              </div>

              <div className="my-1 text-center text-gray-500">
                Facilities: {selectedFacility?.facilityName}
              </div>
              <div className="flex-1 overflow-y-auto pb-4">
                <div className="space-y-4 px-6">
                  {eventsForSelectedDate
                    .slice()
                    .sort((a, b) => a.start.getTime() - b.start.getTime())
                    .map((booking) => (
                      <div
                        key={booking.id}
                        className={classNames(
                          "rounded-lg border-l-4 p-4",
                          getFacilityColor(booking.title),
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="mb-1 text-xs font-medium text-gray-500">
                              {booking.time}
                              {booking.endTime &&
                                booking.endTime !== booking.time &&
                                ` TO ${booking.endTime}`}
                            </div>
                            <div className="mb-1 font-medium text-gray-900">
                              {booking.title}
                            </div>
                            <div className="text-sm text-gray-600">
                              Event: {booking.eventName}
                            </div>
                            <div className="text-sm text-gray-600">
                              By: {booking.user}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}

                  {eventsForSelectedDate.length === 0 && (
                    <div className="py-12 text-center">
                      <div className="mb-2 text-gray-400">
                        No events scheduled
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Calendar_v2;
