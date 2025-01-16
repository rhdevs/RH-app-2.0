"use client";

import { useRef, useEffect, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import listPlugin from "@fullcalendar/list";
import timeGridPlugin from "@fullcalendar/timegrid";
import { api } from "~/trpc/react";
import { endOfMonth, getUnixTime, startOfMonth } from "date-fns";
import { useMediaQuery, useToggle } from "usehooks-ts";

const Calendar = () => {
  const [start, setStart] = useState(getUnixTime(startOfMonth(new Date())));
  const [end, setEnd] = useState(getUnixTime(endOfMonth(new Date())));
  const [isFacilityModalOpen, toggleFacilityModal] = useToggle(false);
  const [facility, setFacility] = useState<number>(-1);

  const bookingsInMonth = api.bookings.getBookings.useQuery({
    startTime: start,
    endTime: end,
    ...(facility !== -1 ? { facilityID: facility } : {}),
  });

  const facilities = [
    ...(api.bookings.getAllFacilities.useQuery().data ?? []),
    {
      id: "",
      facilityName: "Select Facility",
      facilityLocation: "",
      facilityID: -1,
    },
  ];

  const calendarRef = useRef<FullCalendar>(null);

  const isMobile = useMediaQuery("(max-width: 768px)");

  useEffect(() => {
    if (isMobile) {
      calendarRef.current?.getApi().changeView("listMonth");
    } else {
      calendarRef.current?.getApi().changeView("timeGridWeek");
    }
  }, [isMobile]);

  // ToDo: display bookingsInMonth once implemented display of time;
  return (
    <div className={"container"}>
      <FullCalendar
        plugins={[timeGridPlugin, listPlugin]}
        events={bookingsInMonth.data}
        initialView="timeGridWeek"
        datesSet={(dateInfo) => {
          setStart(getUnixTime(startOfMonth(dateInfo.start)));
          setEnd(getUnixTime(endOfMonth(dateInfo.end)));
        }}
        eventTimeFormat={{
          hour: "numeric",
          minute: "2-digit",
          meridiem: "short",
          omitZeroMinute: false,
        }}
        ref={calendarRef}
        customButtons={{
          selectFacilityButton: {
            text:
              facilities.find((f) => f.facilityID === facility)?.facilityName ??
              "Select Facility",
            click: () => {
              toggleFacilityModal();
            },
          },
        }}
        headerToolbar={{
          left: "timeGridWeek,listMonth",
          center: "title",
          right: "selectFacilityButton today prev,next",
        }}
      />
      <div
        className={`${isFacilityModalOpen ? "inline-block" : "hidden"} fixed inset-0 z-50 overflow-y-auto bg-gray-800 bg-opacity-75`}
      >
        <div className="flex min-h-full items-center justify-center p-4 text-center">
          <div className="w-full max-w-md transform rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
            <h3 className="text-lg font-medium leading-6 text-gray-900">
              Select Facility
            </h3>
            <div className="mt-2">
              <ul>
                {facilities.map((facility) => (
                  <li
                    key={facility.id}
                    onClick={() => {
                      setFacility(facility.facilityID);
                      toggleFacilityModal();
                    }}
                    className="cursor-pointer rounded p-2 text-gray-900 hover:bg-gray-200"
                  >
                    {facility.facilityName}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-4">
              <button
                type="button"
                className="inline-flex justify-center rounded-md border border-transparent bg-blue-100 px-4 py-2 text-sm font-medium text-blue-900 hover:bg-blue-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                onClick={() => {
                  toggleFacilityModal();
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Calendar;
