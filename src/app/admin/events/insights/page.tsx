import Link from "next/link";

import HallInsights from "~/app/admin/_components/events/HallInsights";

/**
 * The hall-wide events view.
 *
 * A SUB-PAGE OF /admin/events, deliberately — it sits under that route's layout
 * and therefore inherits its live role read and its
 * `reviewEvents || manageHallEvents` gate with no new gate to get wrong.
 * `AdminShell`'s tab list is NOT touched: `/admin/events` is already a tab, and
 * this is reached by a link from it.
 *
 * `getHallStats` re-checks `reviewEvents` live anyway (I-5). The layout proves
 * the caller could reach the page; the procedure proves they still hold the
 * capability at the moment they ask for every CCA's turnout.
 *
 * NO PROPS CROSS THIS BOUNDARY AT ALL — this server component renders a client
 * component with none. A function prop here would throw at render while tsc,
 * ESLint and next build all pass, which is how five authoring routes shipped
 * broken in this repo.
 */
export default function AdminEventInsightsPage() {
  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/events" className="text-sm text-gray-500 underline">
          ← Back to events
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-gray-900">
          Across the hall
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Every published event in a date range, who ran it, and how many
          actually turned up.
        </p>
      </div>
      <HallInsights />
    </div>
  );
}
