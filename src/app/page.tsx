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

const mockFeatures = [
  {
    id: "1",
    name: "Feature A",
    startAt: new Date(2024, 11, 1),
    endAt: new Date(2024, 11, 2),
    status: { id: "1", name: "Active", color: "green" },
  },
  {
    id: "2",
    name: "Feature B",
    startAt: new Date(2024, 11, 3),
    endAt: new Date(2024, 11, 3),
    status: { id: "2", name: "Inactive", color: "red" },
  },
  {
    id: "3",
    name: "Feature C",
    startAt: new Date(2024, 11, 3),
    endAt: new Date(2024, 11, 6),
    status: { id: "1", name: "Active", color: "green" },
  },
  {
    id: "4",
    name: "Feature D",
    startAt: new Date(2024, 11, 3),
    endAt: new Date(2024, 11, 3),
    status: { id: "3", name: "Pending", color: "yellow" },
  },
  {
    id: "5",
    name: "Feature E",
    startAt: new Date(2024, 11, 3),
    endAt: new Date(2024, 11, 3),
    status: { id: "4", name: "Completed", color: "blue" },
  },
  {
    id: "6",
    name: "Long Event",
    startAt: new Date(2024, 11, 4),
    endAt: new Date(2024, 11, 10),
    status: { id: "1", name: "Active", color: "purple" },
  },
  {
    id: "7",
    name: "Overlap Event",
    startAt: new Date(2024, 11, 5),
    endAt: new Date(2024, 11, 7),
    status: { id: "5", name: "Urgent", color: "orange" },
  },
];

export default async function Home() {
  const hello = await api.post.hello({ text: "from tRPC" });
  const session = await getServerAuthSession();

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
        <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
          <h1 className="flex items-baseline font-extrabold tracking-tight sm:text-[5rem]">
            <span className="text-5xl text-[hsl(280,100%,70%)]">RHApp</span>
            <span className="ml-2 text-lg">By RH Dev</span>
          </h1>

          <CalendarProvider locale="en-US" startDay={0}>
            <div className="w-full rounded-lg bg-white/10 p-6 shadow-md">
              <CalendarDate>
                <CalendarDatePicker className="flex gap-4">
                  <CalendarMonthPicker className="rounded-lg bg-white/10 p-2 hover:bg-white/20" />
                  <CalendarYearPicker
                    start={2000}
                    end={2050}
                    className="rounded-lg bg-white/10 p-2 hover:bg-white/20"
                  />
                </CalendarDatePicker>
                <CalendarDatePagination className="flex gap-2 text-sm text-gray-300" />
              </CalendarDate>
              <CalendarHeader className="mb-2 grid grid-cols-7 gap-2 text-sm text-gray-400" />
              <CalendarBody features={mockFeatures} />
            </div>
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
