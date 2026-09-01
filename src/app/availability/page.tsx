import { HydrateClient } from "~/trpc/server";
import Header from "../_components/header";
import AvailabilityBoard from "./_components/AvailabilityBoard";

/**
 * "What's free right now?" — the time-first availability board.
 *
 * NO SERVER GUARD HERE, consistently with every other resident-facing page in
 * this app (`/`, `/bookings`, `/events`): the page is a shell, and both queries
 * behind it are `protectedProcedure`, so an unauthenticated visitor gets a
 * rendered frame and no data. `AvailabilityBoard` renders an explicit
 * sign-in-to-see state for that case rather than an empty grid, which is the
 * part that was worth writing — a blank board looks broken, not gated.
 *
 * EVERY PROP CROSSING THIS BOUNDARY IS A SCALAR — there are none at all here.
 * This is a server component and `AvailabilityBoard` is a client component, so a
 * function prop would throw at RENDER while tsc, ESLint and `next build` all
 * pass. That mistake once killed all five event authoring routes in this repo;
 * see the warning on `EventManage`'s `manageHrefBase`.
 */
export default function AvailabilityPage() {
  return (
    <HydrateClient>
      <Header currentPage="Availability" />
      <div className="min-h-[calc(100vh-4rem)] bg-gradient-to-br from-gray-50 to-gray-100 pb-20">
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
          <h1 className="text-2xl font-bold text-gray-900">
            What&apos;s free right now?
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Pick a window and see every room that is open for it.
          </p>
        </div>
        <AvailabilityBoard />
      </div>
    </HydrateClient>
  );
}
