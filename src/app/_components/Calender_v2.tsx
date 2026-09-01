"use client";

import React, { useState, useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Filter,
  ChevronDown,
  Check,
  AlertTriangle,
} from "lucide-react";
import { api } from "~/trpc/react";
import {
  endOfMonth,
  getUnixTime,
  startOfMonth,
  format,
  eachDayOfInterval,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  isToday,
  isSameDay,
} from "date-fns";
import Loading from "./Loading";
import Toast from "./Toast";
import { useSession } from "next-auth/react";
import BookingModal, {
  NO_IDENTITY_MESSAGE,
  type PickerFacility,
} from "./BookingModal";
import { JCRC_ROLE, CCA_HEAD_ROLE, ADMIN_ROLE } from "~/lib/roleNames";

function classNames(...classes: (string | boolean | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export interface Booking {
  id: string;
  start: Date;
  end: Date;
  title?: string;
  user: string | null | undefined;
  eventName: string | null;
  eventDescription: string | null;
  userTeleHandle: string | null;
}

interface Facility {
  facilityID: number;
  facilityName: string;
  facilityLocation: string;
}

const Calendar_v2: React.FC = () => {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedFacilityIds, setSelectedFacilityIds] = useState<number[]>([]);
  const [isFilterDropdownOpen, setIsFilterDropdownOpen] = useState(false);
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [checkOwnBookings, setCheckOwnBookings] = useState<boolean>(false);
  const [bookingModalOpen, setBookingModalOpen] = useState<boolean>(false);

  const { data: session } = useSession();
  // 08 §1.2: the canonical session userID, "" for an account that is not on
  // @u.nus.edu. Every identity check below keys off this, NOT off
  // session.user.eligible — eligible is `true` for these accounts while the auth
  // kill switch is at its default "off", so an eligible-keyed check does nothing.
  const userID = session?.user?.userID ?? "";
  const hasIdentity = Boolean(userID);
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
      ...(selectedFacilityIds.length > 0
        ? { facilityIDs: selectedFacilityIds }
        : {}),
      ...(checkOwnBookings && hasIdentity ? { userId: userID } : {}),
    },
    {
      // "My Bookings" is unreachable without an identity (handleCheckOwnBookings
      // refuses the toggle and explains why), so this can no longer leave the
      // calendar permanently blank with no stated reason.
      enabled: !checkOwnBookings || hasIdentity,
    },
  );
  // Display source for the calendar grid, the filter dropdown and the colour
  // map. publicProcedure, so it keeps working signed-out. Retained unchanged:
  // it must never decide whether a booking control is enabled.
  const facilitiesQuery = api.bookings.getAllFacilities.useQuery();

  // Booking source. Server-computed per-facility permission, replacing the
  // hardcoded client-side room allowlist this component used to carry.
  //
  // protectedProcedure, so it is only enabled with a session — an unauthenticated
  // visitor must still get the calendar. Errors are deliberately not surfaced:
  // this query is cosmetic (I-7), and `bookFacility` already handles the
  // signed-out case.
  const bookableQuery = api.bookings.getFacilitiesForBooking.useQuery(
    undefined,
    { enabled: hasIdentity },
  );

  const facilities: Facility[] = useMemo(() => {
    const baseFacilities = (facilitiesQuery.data ?? []) as Facility[];
    return baseFacilities;
  }, [facilitiesQuery.data]);

  /**
   * Facilities offered in the booking modal.
   *
   * I-7 v2 corollary — a client gate must never be STRICTER than the server.
   * Two consequences encoded here:
   *   - the filter is the server's own `canBook`, computed by the same
   *     getBookableFacilityMap that reads the same kill switch as createBooking,
   *     so this list cannot disagree with the enforcement point;
   *   - until that query resolves (or if it fails) we fall back to the full
   *     list, never to the empty one. Hiding every room on a failed advisory
   *     query would be a client-only lockout with no server denial behind it.
   * The server still re-checks on submit, which is the real gate.
   */
  const bookableFacilities: PickerFacility[] = useMemo(() => {
    // FAIL OPEN, unchanged: until the advisory query resolves (or if it fails)
    // fall back to the full list, never to the empty one. Hiding every room on a
    // failed advisory query would be a client-only lockout with no server denial
    // behind it. Rooms are then rendered UNANNOTATED rather than disabled.
    if (!bookableQuery.data) {
      return facilities.map((f) => ({
        ...f,
        canBook: true,
        requiredRoles: [],
        closed: false,
        closedNote: null,
      }));
    }
    // NO LONGER FILTERED TO `canBook`. The picker now renders every room and
    // disables the ones it cannot offer, with the reason — which is what
    // `requiredRoles` was added to the payload for ("so the UI can say WHAT is
    // needed instead of silently hiding a room") and what Q2 settled. The server
    // is still the enforcement point; this only decides what is drawn.
    return bookableQuery.data.map((f) => ({
      facilityID: f.facilityID,
      facilityName: f.facilityName,
      facilityLocation: f.facilityLocation,
      canBook: f.canBook,
      requiredRoles: f.requiredRoles,
      closed: f.closed,
      closedNote: f.closedNote,
    }));
  }, [bookableQuery.data, facilities]);

  /**
   * May this session create a REPEATING booking? Advisory only — `createSeries`
   * carries its own role gate server-side and is the real check. This decides
   * whether the control is drawn at all, so a resident is not shown an option
   * that can only ever be refused.
   *
   * Reads the LIVE session role list, which the auth session callback rebuilds
   * from the database on every request (I-4), so a revoked head loses the
   * control on their next page load rather than in 30 days.
   */
  const canCreateSeries = useMemo(() => {
    const roles = session?.user?.roles ?? [];
    return (
      roles.includes(ADMIN_ROLE) ||
      roles.includes(JCRC_ROLE) ||
      roles.includes(CCA_HEAD_ROLE)
    );
  }, [session]);

  const selectedFacilities = facilities.filter((f: Facility) =>
    selectedFacilityIds.includes(f.facilityID),
  );

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
  }, [currentMonth, selectedDate, monthEnd, monthStart]);

  const processedBookings = useMemo(() => {
    if (!bookingsInMonth) return [];

    const bookings = Array.isArray(bookingsInMonth)
      ? bookingsInMonth
      : (bookingsInMonth?.bookings ?? []);
    return bookings.map((booking: Booking) => {
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
        title: booking.title ?? "Untitled Event",
        start,
        end,
        date: format(start, "MMMM do, yyyy"),
        time: isFullDay ? "All day" : format(start, "h:mm a"),
        endTime: isFullDay ? "" : format(end, "h:mm a"),
        user: booking.user,
        eventName: booking.eventName,
        userTeleHandle: booking.userTeleHandle,
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

  /**
   * The selected day's bookings, GROUPED BY ROOM with times nested inside — Q1.
   *
   * Grouped here rather than server-side on purpose. `getBookings` is
   * keyset-paginated on `(startTime desc, id asc)` and its `orderBy` has to
   * mirror that predicate exactly or the cursor walks a different sequence than
   * it cuts; adding `facilityID` as the primary sort key there would break
   * pagination outright. A day view has already fetched its whole day, so
   * grouping is free at this end and costs nothing at the other.
   *
   * `booking.title` is the facility NAME (getBookings denormalises it into the
   * title field). Rooms are ordered alphabetically and times ascending within
   * each, so the panel reads as per-room occupancy.
   */
  const bookingsByRoom = useMemo(() => {
    const byRoom = new Map<string, typeof eventsForSelectedDate>();
    for (const b of eventsForSelectedDate) {
      const room = b.title ?? "Unknown room";
      const list = byRoom.get(room) ?? [];
      list.push(b);
      byRoom.set(room, list);
    }
    return [...byRoom.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([room, list]) => ({
        room,
        bookings: list
          .slice()
          .sort((a, b) => a.start.getTime() - b.start.getTime()),
      }));
  }, [eventsForSelectedDate]);

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

  const handleFacilityToggle = (facilityID: number) => {
    setSelectedFacilityIds((prev) =>
      prev.includes(facilityID)
        ? prev.filter((id) => id !== facilityID)
        : [...prev, facilityID],
    );
    // keep dropdown open for multi-select
  };

  const getFacilityColor = (facility: string) => {
    switch (facility) {
      case "Main Area (UL)":
        return "bg-green-100 text-green-800 border-green-800";
      case "Quiet Room":
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
      case "SCRC Room":
        return "bg-teal-200 text-teal-800 border-teal-800";
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
    // Signed in but with no canonical userID: still open the modal, which
    // renders the explanatory panel instead of a form that can only fail. The
    // dead end has to say something; it must not be a Book button that opens a
    // form whose Confirm is rejected server-side with no on-screen cause.
    setBookingModalOpen(true);
  };

  const handleCheckOwnBookings = () => {
    if (!session) {
      setToastContent("Log in to see your bookings!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }
    // Without an identity the query was simply disabled and the calendar went
    // blank, which reads as "you have no bookings". Refuse the toggle and say why.
    if (!hasIdentity) {
      setToastContent(NO_IDENTITY_MESSAGE);
      setToastOpen(true);
      setToastType("danger");
      return;
    }
    setCheckOwnBookings(!checkOwnBookings);
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
        facilities={bookableFacilities}
        userId={userID}
        currentDate={selectedDate}
        refetch={refetchBookingsInMonth}
        canCreateSeries={canCreateSeries}
        onBooked={(message) => {
          // Raised HERE and not inside the modal: the modal unmounts on success,
          // taking its own Toast with it. This component stays on screen.
          setToastContent(message);
          setToastType("success");
          setToastOpen(true);
        }}
      />
      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {/* 08 §1.2: state the situation once, up front, rather than only when a
            control is pressed. The calendar itself stays fully usable — this is
            about booking and "My Bookings", not about reading the schedule. */}
        {session && !hasIdentity && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div>
              <div className="text-sm font-medium text-amber-900">
                Bookings can&apos;t be made from this account
              </div>
              <p className="mt-1 text-sm text-amber-800">
                {NO_IDENTITY_MESSAGE}
              </p>
            </div>
          </div>
        )}
        <div className="mb-8 flex items-center justify-end gap-x-4">
          <div
            onClick={handleCheckOwnBookings}
            className="rounded-full bg-emerald-700 px-4 py-1 text-white hover:bg-emerald-900"
          >
            {checkOwnBookings ? "See All Bookings" : "See My Bookings"}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsFilterDropdownOpen(!isFilterDropdownOpen)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Filter className="h-4 w-4" />
              <span className="max-w-40 truncate">
                {selectedFacilityIds.length === 0
                  ? "All Facilities"
                  : selectedFacilities
                      .map((f: Facility) => f.facilityName)
                      .slice(0, 2)
                      .join(", ") +
                    (selectedFacilityIds.length > 2
                      ? ` +${selectedFacilityIds.length - 2} more`
                      : "")}
              </span>
              <ChevronDown className="h-4 w-4" />
            </button>

            {isFilterDropdownOpen && (
              <div className="absolute right-0 z-20 mt-2 w-64 origin-top-right rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5">
                <div className="max-h-60 overflow-y-auto py-1">
                  {facilities
                    .filter((f: Facility) => f.facilityID !== -1)
                    .sort((a: Facility, b: Facility) =>
                      a.facilityName.localeCompare(b.facilityName),
                    )
                    .map((facilityOption: Facility) => {
                      const selected = selectedFacilityIds.includes(
                        facilityOption.facilityID,
                      );
                      return (
                        <button
                          key={facilityOption.facilityID}
                          onClick={() =>
                            handleFacilityToggle(facilityOption.facilityID)
                          }
                          className={classNames(
                            "flex w-full items-center px-4 py-2 text-left text-sm hover:bg-gray-100",
                            selected
                              ? "bg-gray-100 text-gray-900"
                              : "text-gray-700",
                          )}
                        >
                          <div className="flex-1">
                            <div className="font-medium">
                              {facilityOption.facilityName}
                            </div>
                          </div>
                          {selected && (
                            <Check className="h-4 w-4 text-emerald-600" />
                          )}
                        </button>
                      );
                    })}
                </div>
                <div className="flex items-center justify-between border-t border-gray-200 px-2 py-2">
                  <button
                    type="button"
                    onClick={() => setSelectedFacilityIds([])}
                    className="text-xs text-gray-600 hover:text-gray-900"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsFilterDropdownOpen(false)}
                    className="text-xs font-medium text-emerald-700 hover:text-emerald-900"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-500">
          Viewing:{" "}
          {checkOwnBookings
            ? `My Bookings`
            : 'All Bookings (Click "See My Bookings" to view your bookings by date.)'}
        </div>
        <div className="text-xs text-gray-500">
          Note: To see all your bookings in one place, navigate to &quot;My
          Bookings&quot; tab.
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
                Facilities: {""}
                {selectedFacilityIds.length === 0
                  ? "All Facilities"
                  : selectedFacilities
                      .map((f: Facility) => f.facilityName)
                      .join(", ")}
              </div>
              <div className="flex-1 overflow-y-auto pb-4">
                <div className="space-y-4 px-6">
                  {bookingsByRoom.map(({ room, bookings }) => (
                    <div key={room} className="space-y-2">
                      <div className="flex items-baseline gap-2 border-b border-gray-200 pb-1">
                        <h4 className="text-sm font-semibold text-gray-900">
                          {room}
                        </h4>
                        <span className="text-xs text-gray-400">
                          {bookings.length}
                          {bookings.length === 1 ? " booking" : " bookings"}
                        </span>
                      </div>
                      {bookings.map((booking) => (
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
                              <div className="text-sm text-gray-600">
                                Event: {booking.eventName}
                              </div>
                              <div className="text-sm text-gray-600">
                                By: {booking.user} (@{booking.userTeleHandle})
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
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
