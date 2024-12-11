import Link from "next/link";
import type { ReactNode } from "react";
import { LatestPost } from "~/app/_components/post";
import { getServerAuthSession } from "~/server/auth";
import { api, HydrateClient } from "~/trpc/server";
import {
  CalendarDate,
  CalendarDatePicker,
  CalendarMonthPicker,
  CalendarProvider,
  CalendarYearPicker,
} from "~/components/roadmap-ui/calendar";
import {
  CalendarHeader,
  CalendarBody,
  CalendarDatePagination,
  CalendarItem,
} from "~/components/roadmap-ui/calendar";

const mockFeatures = [
  {
    id: "1",
    name: "Feature A",
    startAt: new Date(2024, 0, 1),
    endAt: new Date(2024, 0, 2),
    status: { id: "1", name: "Active", color: "green" },
  },
  {
    id: "2",
    name: "Feature B",
    startAt: new Date(2024, 0, 3),
    endAt: new Date(2024, 0, 3),
    status: { id: "2", name: "Inactive", color: "red" },
  },
];

export default async function Home() {
  const hello = await api.post.hello({ text: "from tRPC" });
  const session = await getServerAuthSession();

  const renderedFeatures = mockFeatures.reduce<Record<number, ReactNode>>(
    (acc, feature) => {
      const day = new Date(feature.endAt).getDate();
      if (!acc[day]) acc[day] = [];
      acc[day] = (
        <>
          {acc[day]}
          <CalendarItem
            key={feature.id}
            feature={feature}
            className="bg-[hsl(280,100%,70%)] text-white"
          />
        </>
      );
      return acc;
    },
    {},
  );

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] text-white">
        <div className="container flex flex-col items-center justify-center gap-12 px-4 py-16">
          <h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">
            Create <span className="text-[hsl(280,100%,70%)]">T3</span> App
          </h1>

          <CalendarProvider locale="en-US" startDay={0}>
            <div className="w-full max-w-lg rounded-lg bg-white/10 p-4">
              <CalendarDate>
                <CalendarDatePicker>
                  <CalendarMonthPicker />
                  <CalendarYearPicker start={2000} end={2050} />
                </CalendarDatePicker>
                <CalendarDatePagination />
              </CalendarDate>
              <CalendarHeader />
              <CalendarBody
                features={mockFeatures}
                renderedFeatures={renderedFeatures}
              />
            </div>
          </CalendarProvider>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:gap-8">
            <Link
              className="flex max-w-xs flex-col gap-4 rounded-xl bg-white/10 p-4 hover:bg-white/20"
              href="https://create.t3.gg/en/usage/first-steps"
              target="_blank"
            >
              <h3 className="text-2xl font-bold">First Steps →</h3>
              <div className="text-lg">
                Just the basics - Everything you need to know to set up your
                database and authentication.
              </div>
            </Link>
            <Link
              className="flex max-w-xs flex-col gap-4 rounded-xl bg-white/10 p-4 hover:bg-white/20"
              href="https://create.t3.gg/en/introduction"
              target="_blank"
            >
              <h3 className="text-2xl font-bold">Documentation →</h3>
              <div className="text-lg">
                Learn more about Create T3 App, the libraries it uses, and how
                to deploy it.
              </div>
            </Link>
          </div>

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
