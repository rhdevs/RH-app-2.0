import Link from "next/link";
import { LatestPost } from "~/app/_components/post";
import { getServerAuthSession } from "~/server/auth";
import { api, HydrateClient } from "~/trpc/server";
import {
  CalendarDate,
  CalendarDatePicker,
  CalendarMonthPicker,
  CalendarProvider,
  CalendarYearPicker,
  CalendarHeader,
  CalendarBody,
  CalendarDatePagination,
} from "~/components/roadmap-ui/calendar";
import { startOfMonth, endOfMonth, getUnixTime, fromUnixTime } from "date-fns";

const mockFeatures = [
  {
    id: "1",
    name: "Feature A",
    startAt: new Date(2024, 11, 1, 9, 30), // December 1, 2024, 9:30 AM
    endAt: new Date(2024, 11, 1, 17, 0), // December 1, 2024, 5:00 PM
    status: { id: "1", name: "Active", color: "green" },
  },
  {
    id: "2",
    name: "Feature B",
    startAt: new Date(2024, 11, 3, 8, 0), // December 3, 2024, 8:00 AM
    endAt: new Date(2024, 11, 3, 12, 0), // December 3, 2024, 12:00 PM
    status: { id: "2", name: "Inactive", color: "red" },
  },
  {
    id: "3",
    name: "Feature C",
    startAt: new Date(2024, 11, 3, 14, 0), // December 3, 2024, 2:00 PM
    endAt: new Date(2024, 11, 6, 15, 30), // December 6, 2024, 3:30 PM
    status: { id: "1", name: "Active", color: "green" },
  },
  {
    id: "4",
    name: "Feature D",
    startAt: new Date(2024, 11, 3, 10, 0), // December 3, 2024, 10:00 AM
    endAt: new Date(2024, 11, 3, 16, 0), // December 3, 2024, 4:00 PM
    status: { id: "3", name: "Pending", color: "yellow" },
  },
  {
    id: "5",
    name: "Feature E",
    startAt: new Date(2024, 11, 3, 11, 0), // December 3, 2024, 11:00 AM
    endAt: new Date(2024, 11, 3, 11, 30), // December 3, 2024, 11:30 AM
    status: { id: "4", name: "Completed", color: "blue" },
  },
  {
    id: "6",
    name: "Long Event",
    startAt: new Date(2024, 11, 4, 9, 0), // December 4, 2024, 9:00 AM
    endAt: new Date(2024, 11, 10, 22, 0), // December 10, 2024, 10:00 PM
    status: { id: "1", name: "Active", color: "purple" },
  },
  {
    id: "7",
    name: "Overlap Event",
    startAt: new Date(2024, 11, 5, 12, 0), // December 5, 2024, 12:00 PM
    endAt: new Date(2024, 11, 7, 18, 0), // December 7, 2024, 6:00 PM
    status: { id: "5", name: "Urgent", color: "orange" },
  },
];

export default async function Home() {
  const hello = await api.post.hello({ text: "from tRPC" });
  const session = await getServerAuthSession();

  const bookingsInMonth = await api.bookings
    .getBookings({
      startTime: getUnixTime(startOfMonth(new Date())),
      endTime: getUnixTime(endOfMonth(new Date())),
    })
    .then((res) => {
      return res.map((booking) => {
        return {
          id: booking.id,
          name: booking.description ?? "Booking",
          startAt: fromUnixTime(booking.startTime),
          endAt: fromUnixTime(booking.endTime),
          status: { id: booking.id, name: "Active", color: "green" },
        };
      });
    });

  // ToDo: display bookingsInMonth once implemented display of time

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
        <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
          <h1 className="flex items-baseline font-extrabold tracking-tight sm:text-[5rem]">
            <span className="text-5xl text-[hsl(280,100%,70%)]">RHApp</span>
            <span className="ml-2 text-lg">By RH Dev</span>
          </h1>

          <CalendarProvider
            locale="en-US"
            startDay={0}
            className="w-full max-w-3xl rounded-lg bg-white/5 p-4"
          >
            <CalendarDate>
              <CalendarDatePicker className="flex gap-4">
                <CalendarMonthPicker className="rounded-lg bg-white/10 p-2 hover:bg-white/20" />
                <CalendarYearPicker
                  start={2000}
                  end={2050}
                  className="rounded-lg bg-white/10 p-2 hover:bg-white/20"
                />
              </CalendarDatePicker>
              <CalendarDatePagination className="hidden gap-2 text-sm text-gray-300 md:flex" />
            </CalendarDate>
            <CalendarHeader className="mb-2 grid grid-cols-7 gap-1 text-xs sm:text-sm" />
            <CalendarBody features={mockFeatures}></CalendarBody>
          </CalendarProvider>

          <div className="flex flex-col items-center gap-2">
            <p className="text-2xl text-white">
              {hello ? hello.greeting : "Loading tRPC query..."}
            </p>

            <div className="flex flex-col items-center justify-center gap-4">
              <p className="text-center text-2xl text-white">
                {session && <span>Logged in as {session.user?.name}</span>}
              </p>
              <Link
                href={session ? "/api/auth/signout" : "/api/auth/signin"}
                className="rounded-full bg-white/10 px-10 py-3 font-semibold no-underline transition hover:bg-white/20"
              >
                {session ? "Sign out" : "Sign in"}
              </Link>
            </div>
          </div>

          {session?.user && <LatestPost />}
        </div>
      </main>
    </HydrateClient>
  );
}
