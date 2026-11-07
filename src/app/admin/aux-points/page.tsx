"use client";

import { useState } from "react";

import { useCapabilities } from "~/app/admin/_components/AdminCapabilityContext";
import { api } from "~/trpc/react";
import AwardsPanel from "./_components/AwardsPanel";
import EventsPanel from "./_components/EventsPanel";
import RecordsPanel from "./_components/RecordsPanel";
import TotalsPanel from "./_components/TotalsPanel";

/**
 * AUX: hall participation counted towards points. JCRC flags AUX events,
 * fixes their attendance, adds record-only events and gives awards; the page
 * shows each resident's total with where it came from. Totals go to the points
 * sandbox in the bundle from /admin/points, which applies the cap.
 *
 * The capability gate below is cosmetic: the layout guards the route and every
 * aux procedure re-checks `manageCcaPointsRanges`. A past points year is shown
 * read-only. Residents never see their count here or anywhere else.
 */
export default function AdminAuxPage() {
  const cap = useCapabilities();
  const [year, setYear] = useState<string | undefined>(undefined);
  const overview = api.aux.overview.useQuery(
    { year },
    { enabled: cap.manageCcaPointsRanges },
  );
  const shown = overview.data?.year;
  const sources = api.aux.sources.useQuery(
    { year: shown ?? "" },
    { enabled: !!shown },
  );
  const refresh = () => {
    void overview.refetch();
    void sources.refetch();
  };

  if (!cap.manageCcaPointsRanges) {
    return (
      <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-sm text-gray-500">
        You don&rsquo;t have access to AUX.
      </p>
    );
  }

  const data = overview.data;
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">AUX</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Hall participation that counts towards points. It starts again from
            zero when &ldquo;Start new points year&rdquo; is pressed on the
            Points tab for a new academic year (a press from May to July counts
            towards the coming one); earlier years stay here to read.
          </p>
        </div>
        {data && data.years.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            Year
            <select
              value={data.year}
              onChange={(e) => setYear(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              {data.years.map((y) => (
                <option key={y} value={y}>
                  {y}
                  {y === data.current ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {overview.isLoading ? (
        <div className="space-y-6" role="status" aria-label="Loading AUX">
          <div className="h-40 animate-pulse rounded-xl bg-white shadow-lg" />
          <div className="h-56 animate-pulse rounded-xl bg-white shadow-lg" />
        </div>
      ) : !data ? (
        <div
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3"
          role="alert"
        >
          <p className="text-sm text-red-800">
            Couldn&rsquo;t read AUX.{" "}
            <button
              type="button"
              onClick={() => void overview.refetch()}
              className="rounded font-medium underline underline-offset-2 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              Retry
            </button>
          </p>
        </div>
      ) : (
        <>
          {data.readOnly && (
            <div
              className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900"
              role="status"
            >
              {data.year} is an earlier points year, so it can only be read. The
              current year is {data.current}.
            </div>
          )}
          <TotalsPanel overview={data} onChanged={refresh} />
          <EventsPanel
            year={data.year}
            readOnly={data.readOnly}
            events={sources.data?.events ?? []}
            onChanged={refresh}
          />
          <RecordsPanel
            readOnly={data.readOnly}
            records={sources.data?.records ?? []}
            onChanged={refresh}
          />
          {!data.readOnly && <AwardsPanel onChanged={refresh} />}
          {sources.isError && (
            <p className="text-sm text-red-700" role="alert">
              Couldn&rsquo;t load the AUX events for {data.year}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
