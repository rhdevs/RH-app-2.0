"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import { api } from "~/trpc/react";

export default function LandingPage() {
  const { data: eventsData, isLoading: eventsLoading } =
    api.event.getAll.useQuery();
  interface CalendarEvent {
    id: string;
    title: string;
    start: Date;
    end: Date;
  }
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    if (eventsData) {
      const mapped = eventsData.map((event) => ({
        id: event.id.toString(),
        title: event.description,
        start: new Date(event.slot),
        // Assume events last 1 hour; adjust as needed.
        end: new Date(new Date(event.slot).getTime() + 60 * 60 * 1000),
        allDay: false,
      }));
      setCalendarEvents(mapped);
    }
  }, [eventsData]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-green-600 to-green-400 text-white">
      {/* Header */}
      <header className="container mx-auto px-4 py-8">
        <nav className="flex flex-col items-center justify-between sm:flex-row">
          <h1 className="mb-4 text-3xl font-bold sm:mb-0">RH App</h1>
          <div className="space-x-4">
            <Link className="hover:underline" href="/bookings">
              Bookings
            </Link>
            <Link className="hover:underline" href="/events">
              Events
            </Link>
            <Link className="hover:underline" href="/profile">
              Profile
            </Link>
          </div>
        </nav>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <h2 className="text-4xl font-extrabold">Welcome to RH App!</h2>
          <p className="max-w-md text-lg">
            Your one-stop app for booking facilities, joining exciting events,
            and creating your own.
          </p>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Link
              className="rounded bg-white px-6 py-3 font-bold text-green-600 shadow transition hover:bg-green-100"
              href="/bookings"
            >
              Book Facilities
            </Link>
            <Link
              className="rounded bg-white px-6 py-3 font-bold text-green-600 shadow transition hover:bg-green-100"
              href="/events/create"
            >
              Create Event
            </Link>
          </div>

          {/* Calendar Section */}
          <div className="mt-8 w-full">
            <h3 className="mb-4 text-2xl font-semibold">Event Calendar</h3>
            {eventsLoading ? (
              <p>Loading events...</p>
            ) : (
              <div className="rounded bg-white p-2 text-black shadow">
                <FullCalendar
                  plugins={[dayGridPlugin, interactionPlugin]}
                  initialView="dayGridMonth"
                  events={calendarEvents}
                  height="auto"
                  contentHeight="auto"
                  aspectRatio={1.0}
                  headerToolbar={{
                    left: "",
                    center: "title",
                    right: "",
                  }}
                  footerToolbar={{
                    left: "",
                    center: "prev,next",
                    right: "",
                  }}
                  handleWindowResize={true}
                />
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="container mx-auto px-4 py-8 text-center text-sm">
        <p>
          &copy; {new Date().getFullYear()} Raffles Hall Developers. All rights
          reserved.
        </p>
      </footer>
    </div>
  );
}
