"use client";

import { useRef, useEffect } from "react";
import FullCalendar from "@fullcalendar/react";
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid'
import { api } from "~/trpc/react";
import { endOfMonth, getUnixTime, startOfMonth } from "date-fns";
import { useState } from "react";
import { useMediaQuery } from "usehooks-ts";

const Calendar = () => {
  const [start, setStart] = useState(getUnixTime(startOfMonth(new Date())));
  const [end, setEnd] = useState(getUnixTime(endOfMonth(new Date())));

  const bookingsInMonth = api.bookings.getBookings.useQuery({
    startTime: start,
    endTime: end,
  });

  const calendarRef = useRef<FullCalendar>(null);

  const isMobile = useMediaQuery("(max-width: 768px)");

  useEffect(() => {
    if (isMobile) {
      calendarRef.current?.getApi().changeView("listMonth");
    } else {
      calendarRef.current?.getApi().changeView("timeGridWeek");
    }
  }, [isMobile]);

  // ToDo: display bookingsInMonth once implemented display of time
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
          omitZeroMinute: false
        }}
        ref={calendarRef}
      />
    </div>
  );
};

export default Calendar;
