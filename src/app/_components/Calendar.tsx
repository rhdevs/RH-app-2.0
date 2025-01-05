"use client";

import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import { api } from "~/trpc/react";
import { endOfMonth, getUnixTime, startOfMonth } from "date-fns";
import { useState } from "react";

const Calendar = () => {
  const [start, setStart] = useState(getUnixTime(startOfMonth(new Date())));
  const [end, setEnd] = useState(getUnixTime(endOfMonth(new Date())));

  const bookingsInMonth = api.bookings.getBookings.useQuery({
    startTime: start,
    endTime: end,
  });

  // ToDo: display bookingsInMonth once implemented display of time
  return (
    <div className={"container"}>
      <FullCalendar
        plugins={[dayGridPlugin]}
        initialView="dayGridMonth"
        events={bookingsInMonth.data}
        datesSet={(dateInfo) => {
          setStart(getUnixTime(startOfMonth(dateInfo.start)));
          setEnd(getUnixTime(endOfMonth(dateInfo.end)));
        }}
      />
    </div>
  );
};

export default Calendar;
