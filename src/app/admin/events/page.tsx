import Link from "next/link";

import EventReviewQueue from "../_components/events/EventReviewQueue";
import HallEventsPanel from "../_components/events/HallEventsPanel";

/**
 * Two surfaces, one page: the JCRC's own hall-wide events (which never queue —
 * "Register and publish" submits and approves back to back), and the review
 * queue for everyone else's.
 *
 * The page owns the `h1`, and both panels below it are `h2`. That split matters:
 * the queue used to carry the `h1` because it WAS the whole page, and leaving it
 * there once HallEventsPanel rendered above it put an `h2` ahead of the `h1` in
 * the document — a heading-order violation a screen reader reads as a section
 * nested under nothing. Every sibling admin page (ccas, users, audit,
 * facilities) names itself with exactly one `h1`; this now matches.
 */
export default function AdminEventsPage() {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-900">Events</h1>
        {/* The hall-wide view is a SUB-PAGE, not a new admin tab: /admin/events
            is already a tab, and AdminShell's list is left alone. Reached from
            here so it inherits this route's layout gate. */}
        <Link
          href="/admin/events/insights"
          className="text-sm text-blue-700 underline"
        >
          Across the hall →
        </Link>
      </div>
      <HallEventsPanel />
      <EventReviewQueue />
    </div>
  );
}
