"use client";

import React, { useState, useMemo } from "react";
import { ChevronDown, Calendar, Clock, Search, X } from "lucide-react";
import { useSession } from "next-auth/react";
import { api } from "~/trpc/react";
import { format } from "date-fns";
import Loading from "./Loading";

const timeFrames = [
  { label: "All Time", value: "all" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 3 months", value: "3m" },
  { label: "Last 6 months", value: "6m" },
  { label: "Last year", value: "1y" },
];

const getTimeFrameStart = (value: string): number | null => {
  const now = new Date();
  switch (value) {
    case "7d":
      return Math.floor(
        new Date(now.getTime() - 7 * 86400000).getTime() / 1000,
      );
    case "30d":
      return Math.floor(
        new Date(now.getTime() - 30 * 86400000).getTime() / 1000,
      );
    case "3m":
      now.setMonth(now.getMonth() - 3);
      return Math.floor(now.getTime() / 1000);
    case "6m":
      now.setMonth(now.getMonth() - 6);
      return Math.floor(now.getTime() / 1000);
    case "1y":
      now.setFullYear(now.getFullYear() - 1);
      return Math.floor(now.getTime() / 1000);
    default:
      return null;
  }
};

const PastBookings = () => {
  const { data: session } = useSession();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFacility, setSelectedFacility] = useState("All Facilities");
  const [selectedTimeFrame, setSelectedTimeFrame] = useState("all");
  const [isFacilityDropdownOpen, setIsFacilityDropdownOpen] = useState(false);
  const [isTimeFrameDropdownOpen, setIsTimeFrameDropdownOpen] = useState(false);

  const { data: facilitiesData } = api.bookings.getAllFacilities.useQuery();
  const facilities = useMemo(
    () => [
      { facilityID: -1, facilityName: "All Facilities" },
      ...(facilitiesData ?? []),
    ],
    [facilitiesData],
  );

  const now = Math.floor(Date.now() / 1000);
  const startTime = getTimeFrameStart(selectedTimeFrame) ?? 0;

  const {
    data: bookings = [],
    isLoading,
    refetch,
  } = api.bookings.getBookings.useQuery(
    {
      startTime,
      endTime: now,
      seeAll: true,
      ...(selectedFacility !== "All Facilities"
        ? {
            facilityID:
              facilities.find((f) => f.facilityName === selectedFacility)
                ?.facilityID ?? undefined,
          }
        : {}),
      userId: session?.user?.userID,
    },
    {
      enabled: !!session?.user?.userID,
    },
  );

  const filteredBookings = useMemo(() => {
    return bookings
      .filter((booking) => {
        const lower = searchQuery.toLowerCase();
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        return (
          booking.title?.toLowerCase().includes(lower) ||
          booking.eventName?.toLowerCase().includes(lower)
        );
      })
      .sort((a, b) => b.start.getTime() - a.start.getTime());
  }, [bookings, searchQuery]);

  const clearFilters = () => {
    setSelectedFacility("All Facilities");
    setSelectedTimeFrame("all");
    setSearchQuery("");
  };

  const hasActiveFilters =
    selectedFacility !== "All Facilities" ||
    selectedTimeFrame !== "all" ||
    searchQuery.trim();

  const utils = api.useUtils();

  const deleteBooking = api.bookings.deleteBooking.useMutation({
    onSuccess: async () => {
      await utils.bookings.getBookings.invalidate();
      await refetch();
    },
  });

  const handleDelete = (id: string) => {
    deleteBooking.mutate({ id });
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

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex flex-col space-y-4 md:flex-row md:items-end md:space-x-4 md:space-y-0">
          <div className="flex-1">
            <label className="mb-2 block text-sm font-medium text-gray-700">
              Search
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by facility or event..."
                className="w-full rounded-lg border border-gray-200 py-2 pl-10 pr-4 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          <div className="relative min-w-48">
            <label className="mb-2 block text-sm font-medium text-gray-700">
              Facility
            </label>
            <button
              onClick={() => setIsFacilityDropdownOpen(!isFacilityDropdownOpen)}
              className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-4 py-2 text-left hover:bg-gray-50"
            >
              <span className="truncate">{selectedFacility}</span>
              <ChevronDown className="h-4 w-4 text-gray-400" />
            </button>
            {isFacilityDropdownOpen && (
              <div className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
                {facilities.map((f) => (
                  <button
                    key={f.facilityID}
                    onClick={() => {
                      setSelectedFacility(f.facilityName);
                      setIsFacilityDropdownOpen(false);
                    }}
                    className={`w-full px-4 py-2 text-left hover:bg-gray-50 ${
                      selectedFacility === f.facilityName
                        ? "bg-emerald-50 text-emerald-700"
                        : "text-gray-700"
                    }`}
                  >
                    {f.facilityName}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative min-w-40">
            <label className="mb-2 block text-sm font-medium text-gray-700">
              Time Frame
            </label>
            <button
              onClick={() =>
                setIsTimeFrameDropdownOpen(!isTimeFrameDropdownOpen)
              }
              className="flex w-full items-center justify-between rounded-lg border border-gray-200 px-4 py-2 text-left hover:bg-gray-50"
            >
              <span>
                {timeFrames.find((tf) => tf.value === selectedTimeFrame)?.label}
              </span>
              <ChevronDown className="h-4 w-4 text-gray-400" />
            </button>
            {isTimeFrameDropdownOpen && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
                {timeFrames.map((tf) => (
                  <button
                    key={tf.value}
                    onClick={() => {
                      setSelectedTimeFrame(tf.value);
                      setIsTimeFrameDropdownOpen(false);
                    }}
                    className={`w-full px-4 py-2 text-left hover:bg-gray-50 ${
                      selectedTimeFrame === tf.value
                        ? "bg-emerald-50 text-emerald-700"
                        : "text-gray-700"
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center rounded-lg border border-red-200 px-4 py-2 text-red-600 hover:bg-red-50 hover:text-red-700"
            >
              <X className="mr-2 h-4 w-4" />
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 text-sm text-gray-600">
        Showing {filteredBookings.length} booking
        {filteredBookings.length !== 1 ? "s" : ""}
        {hasActiveFilters ? " (filtered)" : ""}
      </div>

      {isLoading ? (
        <div className="mt-40 flex items-center justify-center">
          <Loading />
        </div>
      ) : (
        <div className="space-y-4">
          {filteredBookings.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
              <Calendar className="mx-auto mb-4 h-12 w-12 text-gray-400" />
              <h3 className="mb-2 text-lg font-medium text-gray-900">
                No bookings found
              </h3>
              <p className="text-gray-600">
                {hasActiveFilters
                  ? "Try adjusting your filters to see more results."
                  : "You haven't made any bookings yet."}
              </p>
            </div>
          ) : (
            filteredBookings.map((booking, idx) => (
              <div
                key={idx}
                className="rounded-lg border border-gray-200 bg-white p-6 transition-shadow hover:shadow-md"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-start space-x-4">
                      <div
                        className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium ${getFacilityColor(
                          booking.title ?? "",
                        )}`}
                      >
                        {booking.title}
                      </div>
                      <div
                        className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                          booking.end < new Date()
                            ? "bg-gray-100 text-gray-600"
                            : "bg-emerald-100 text-emerald-600"
                        }`}
                      >
                        {booking.end < new Date() ? "Completed" : "Incoming"}
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-1 gap-4 text-sm text-gray-600 md:grid-cols-3">
                      <div className="flex items-center">
                        <Calendar className="mr-2 h-4 w-4 text-gray-400" />
                        {format(booking.start, "MMM d, yyyy")}
                      </div>
                      <div className="flex items-center">
                        <Clock className="mr-2 h-4 w-4 text-gray-400" />
                        {format(booking.start, "h:mm a")} -{" "}
                        {format(booking.end, "h:mm a")}
                      </div>
                    </div>
                    <div className="mt-2 text-sm text-gray-600">
                      <span>Event: {booking.eventName}</span>
                    </div>
                    {booking.end >= new Date() && (
                      <button
                        onClick={() => handleDelete(booking.id)}
                        className="ml-auto mt-2 rounded-md bg-red-100 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-200"
                      >
                        Delete booking
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default PastBookings;
