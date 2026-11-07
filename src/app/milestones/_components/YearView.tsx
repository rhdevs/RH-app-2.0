"use client";

import { useState } from "react";
import Link from "next/link";

import { api } from "~/trpc/react";
import { currentAcademicYear } from "~/lib/transcript/academicYear";
import { describeMilestoneError } from "../_lib/errors";
import { milestoneHref } from "./MilestoneRefLink";
import MilestonesFlag from "./MilestonesFlag";

/** This academic year and the two before it. */
function recentYears(now: Date): string[] {
  const start = Number(/^AY(\d{4})/.exec(currentAcademicYear(now))![1]);
  return [0, 1, 2].map(
    (back) =>
      `AY${start - back}/${String((start - back + 1) % 100).padStart(2, "0")}`,
  );
}

const when = (sec: number) =>
  new Date(sec * 1000).toLocaleDateString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/**
 * One CCA's milestones for one academic year: which are filed and which are
 * waiting. A list, nothing more: no totals, no rubric, no comparison. Readable
 * by that CCA's heads and directors only (the procedure decides).
 */
export default function YearView({ ccaID }: { ccaID: number }) {
  return (
    <MilestonesFlag>
      <YearList ccaID={ccaID} />
    </MilestonesFlag>
  );
}

function YearList({ ccaID }: { ccaID: number }) {
  const years = recentYears(new Date());
  const [year, setYear] = useState(years[0]!);
  const view = api.milestone.year.useQuery({ ccaID, year }, { retry: false });

  return (
    <section aria-labelledby="milestones-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="milestones-heading" className="text-lg font-semibold">
            Milestones
          </h2>
          <p className="text-sm text-gray-500 dark:text-muted-foreground">
            Events that have ended, for the heads to file and the directors to
            rate.
          </p>
        </div>
        <label className="text-sm text-gray-700 dark:text-foreground">
          Year{" "}
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-border dark:bg-card"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
      </div>

      {view.isLoading ? (
        <p className="text-sm text-gray-500 dark:text-muted-foreground">
          Loading…
        </p>
      ) : view.isError || !view.data ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {describeMilestoneError(view.error?.message ?? "")}
        </p>
      ) : (
        <>
          {view.data.items.length === 0 ? (
            <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 dark:border-border dark:bg-card dark:text-muted-foreground">
              No ended events in {view.data.year}.
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-border dark:border-border dark:bg-card">
              {view.data.items.map((i) => (
                <li key={JSON.stringify(i.ref)}>
                  <Link
                    href={milestoneHref(i.ref)}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 focus-visible:bg-gray-50 dark:hover:bg-muted"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-foreground">
                        {i.title}
                      </span>
                      <span className="block text-xs text-gray-500 dark:text-muted-foreground">
                        Ended {when(i.endedAt)}
                        {i.canceled ? " · event canceled" : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-gray-700 dark:bg-muted dark:text-foreground">
                        {i.filed ? "Filed" : "Waiting to be filed"}
                      </span>
                      {i.rated && (
                        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                          Rated
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {view.data.capped && (
            <p className="text-xs text-gray-500 dark:text-muted-foreground">
              Only the most recent milestones are shown for this year.
            </p>
          )}
          {view.data.skipped > 0 && (
            <p className="text-xs text-gray-500 dark:text-muted-foreground">
              {view.data.skipped} could not be shown.
            </p>
          )}
        </>
      )}
    </section>
  );
}
