"use client";

import Link from "next/link";

import { MILESTONE_WAITING_WINDOW_DAYS } from "~/lib/milestones/open";
import { api } from "~/trpc/react";
import { describeMilestoneError } from "../_lib/errors";
import MilestonesFlag from "./MilestonesFlag";

/**
 * The CCAs this person heads or directs, with what is waiting in each. Used
 * as the /milestones page and as a section of the director's home.
 */
export default function MilestonesHome({
  heading = true,
}: {
  heading?: boolean;
}) {
  return (
    <MilestonesFlag>
      <Rows heading={heading} />
    </MilestonesFlag>
  );
}

function Rows({ heading }: { heading: boolean }) {
  const mine = api.milestone.mine.useQuery(undefined, { retry: false });
  return (
    <section aria-labelledby="my-milestones" className="space-y-3">
      {heading && (
        <h1
          id="my-milestones"
          className="text-2xl font-semibold text-gray-900 dark:text-foreground"
        >
          Milestones
        </h1>
      )}
      {!heading && (
        <h2
          id="my-milestones"
          className="text-sm font-semibold text-gray-900 dark:text-foreground"
        >
          Milestones
        </h2>
      )}
      {mine.isLoading ? (
        <p className="text-sm text-gray-500 dark:text-muted-foreground">
          Loading…
        </p>
      ) : mine.isError || !mine.data ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {describeMilestoneError(mine.error?.message ?? "")}
        </p>
      ) : mine.data.rows.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500 dark:border-border dark:bg-card dark:text-muted-foreground">
          You are not a head or director of a CCA.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white dark:divide-border dark:border-border dark:bg-card">
          {mine.data.rows.map((r) => (
            <li key={r.ccaID}>
              <Link
                href={`/milestones/${r.ccaID}`}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 focus-visible:bg-gray-50 dark:hover:bg-muted"
              >
                <span className="text-sm font-medium text-gray-900 dark:text-foreground">
                  {r.ccaName}
                </span>
                <span className="flex gap-2 text-xs">
                  {r.head && !(mine.data.capped && r.toFile === 0) && (
                    <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-gray-700 dark:bg-muted dark:text-foreground">
                      {mine.data.capped ? "at least " : ""}
                      {r.toFile} to file
                    </span>
                  )}
                  {r.director && !(mine.data.capped && r.toRate === 0) && (
                    <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
                      {mine.data.capped ? "at least " : ""}
                      {r.toRate} to rate
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {mine.data?.capped && (
        <p className="text-xs text-gray-500 dark:text-muted-foreground">
          Too many recent milestones to count them all, so the numbers are a
          minimum.
        </p>
      )}
      <p className="text-xs text-gray-500 dark:text-muted-foreground">
        Counts cover milestones that ended in the last{" "}
        {MILESTONE_WAITING_WINDOW_DAYS} days. Open a CCA for the full yearly
        record.
      </p>
    </section>
  );
}
