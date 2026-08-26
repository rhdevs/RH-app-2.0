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
        {/*
          Says "without waiting for a review", NOT "they don't go through the
          review queue below" — which is what this used to say, and which is
          false. "Register and publish" runs submit and decide as two calls; if
          the second fails the event really does sit in the queue below, and the
          step-2 error copy says so in as many words. Browser-verified: a
          submitted-but-undecided hall event renders in BOTH panels of this one
          page, so the old sentence was contradicted a few hundred pixels down.
        */}
        <p className="mt-1 text-sm text-gray-500">
          Events the JCRC runs itself. Register and publish them here in one
          step, without waiting for a review.
        </p>
      </div>

      <EventsListPanel
        ccaID={null}
        newHref="/admin/events/hall/new"
        manageHrefBase="/admin/events/hall"
      />
    </div>
  );
}
