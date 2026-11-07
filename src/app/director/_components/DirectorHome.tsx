"use client";

import Link from "next/link";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  isProposalCategory,
  PROPOSAL_CATEGORY_LABELS,
} from "~/lib/proposals/categories";
import {
  PROPOSAL_STATUS_LABELS,
  type ProposalStatus,
} from "~/lib/proposals/status";
import { directorProposalHref } from "~/lib/proposals/links";
import { unreadLabel } from "~/lib/proposals/unreadText";
import { formatDateTime } from "~/app/events/_lib/format";
import { describeReviewFailure } from "../_lib/reviewText";

const COUNT_ORDER: Exclude<ProposalStatus, "draft">[] = [
  "in_review",
  "needs_action",
  "cleared",
  "finished",
  "canceled",
];

const toEpoch = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

/**
 * The director's home: counts by status, the review queue (submitted proposals
 * only, oldest first) and the CCAs this person vets with their heads. NOT a
 * guard: both procedures work out the caller's CCAs from the stored rows, and
 * refuse anyone who directs none.
 *
 * A failed read is an ERROR on the page. It is never drawn as an empty queue,
 * because "nothing to review" would look like success.
 */
export default function DirectorHome() {
  const enabled = api.proposal.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const home = api.proposal.directorHome.useQuery(undefined, {
    retry: false,
    enabled: on,
  });
  const queue = api.proposal.directorQueue.useInfiniteQuery(
    {},
    {
      retry: false,
      enabled: on && home.isSuccess,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  if (enabled.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (enabled.isError) {
    return (
      <p role="alert" className="text-sm text-red-600">
        Could not check whether proposals are switched on. Try again shortly.
      </p>
    );
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Proposals are not switched on yet.
      </p>
    );
  }
  if (home.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (home.isError || !home.data) {
    const failure = describeReviewFailure(home.error?.message);
    return (
      <p
        role={failure.notDirector ? "status" : "alert"}
        className={
          failure.notDirector ? "text-sm text-gray-600" : "text-sm text-red-600"
        }
      >
        {failure.text}
      </p>
    );
  }

  const { ccas, counts } = home.data;
  const items = queue.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-gray-900">
        Director&apos;s home
      </h1>

      <section aria-labelledby="director-counts">
        <h2
          id="director-counts"
          className="mb-2 text-sm font-semibold text-gray-900"
        >
          Proposals by status
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {COUNT_ORDER.map((s) => (
            <div
              key={s}
              className={`rounded-lg border px-3 py-2 ${
                s === "in_review"
                  ? "border-emerald-300 bg-emerald-50"
                  : "border-gray-200 bg-white"
              }`}
            >
              <dt className="text-xs text-gray-500">
                {PROPOSAL_STATUS_LABELS[s]}
              </dt>
              <dd className="text-2xl font-semibold text-gray-900">
                {counts[s]}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="director-queue">
        <h2
          id="director-queue"
          className="mb-2 text-sm font-semibold text-gray-900"
        >
          Waiting for your review
        </h2>
        {queue.isError ? (
          <p role="alert" className="text-sm text-red-600">
            Could not load the review queue. Try again shortly.
          </p>
        ) : queue.isLoading ? (
          <p className="text-sm text-gray-500">Loading the queue…</p>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white px-4 py-6 text-center text-sm text-gray-500">
            Nothing is waiting for review.
          </p>
        ) : (
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
            {items.map((p) => (
              <li key={p.id}>
                <Link
                  href={directorProposalHref(p.id)}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-gray-50 focus-visible:bg-gray-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-gray-900">
                      {p.title}
                    </span>
                    <span className="block text-xs text-gray-500">
                      {p.ccaName ?? "A CCA you direct"}
                      {" · "}
                      {isProposalCategory(p.category)
                        ? PROPOSAL_CATEGORY_LABELS[p.category]
                        : "Proposal"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {unreadLabel(p.unread) && (
                      <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
                        {unreadLabel(p.unread)}
                      </span>
                    )}
                    {p.submittedAt && (
                      <span className="text-xs text-gray-500">
                        Submitted {formatDateTime(toEpoch(p.submittedAt))}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {queue.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={queue.isFetchingNextPage}
              onClick={() => void queue.fetchNextPage()}
            >
              {queue.isFetchingNextPage ? "Loading…" : "Show more"}
            </Button>
          </div>
        )}
      </section>

      <section aria-labelledby="director-ccas">
        <h2
          id="director-ccas"
          className="mb-2 text-sm font-semibold text-gray-900"
        >
          CCAs you vet
        </h2>
        <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
          {ccas.map((c) => (
            <li key={c.ccaID} className="px-4 py-3">
              <p className="text-sm font-medium text-gray-900">
                {c.name ?? "A CCA you direct"}
              </p>
              <p className="text-xs text-gray-500">
                {c.heads.length === 0
                  ? "No heads on record"
                  : `Heads: ${c.heads.join(", ")}`}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
