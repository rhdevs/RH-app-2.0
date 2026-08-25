"use client";

import EventsListPanel from "~/app/cca/_components/EventsListPanel";

/**
 * The JCRC's own events, on the admin surface rather than under /cca/…
 * (D-20). A hall event has no ccaID, so /cca/[ccaID]/events/[eventID] cannot
 * address it — hence the /admin/events/hall/… prefix and this thin wrapper
 * around the shared owner list, with ccaID null selecting the hall-wide rows.
 *
 * NOT a guard: listForOwner carries the manageHallEvents check for ccaID null.
 */
export default function HallEventsPanel() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-gray-900">Hall events</h2>
        <p className="mt-1 text-sm text-gray-500">
          Events the JCRC runs itself. You register and publish them here —
          they don&rsquo;t go through the review queue below.
        </p>
      </div>

      <EventsListPanel
        ccaID={null}
        newHref="/admin/events/hall/new"
        manageHref={(id) => `/admin/events/hall/${id}`}
      />
    </div>
  );
}
