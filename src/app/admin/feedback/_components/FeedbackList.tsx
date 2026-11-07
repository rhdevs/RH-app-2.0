"use client";

import { api } from "~/trpc/react";

const PAGE_SIZE = 20;

/** Every string is rendered as React text; `whitespace-pre-wrap` keeps line breaks. */
export default function FeedbackList() {
  const enabledQuery = api.feedback.enabled.useQuery(undefined, {
    retry: false,
  });
  const enabled = enabledQuery.data?.enabled === true;
  const list = api.feedback.list.useInfiniteQuery(
    { limit: PAGE_SIZE },
    {
      enabled,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  if (enabledQuery.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!enabled) {
    return (
      <p className="text-sm text-gray-500">Feedback is not switched on yet.</p>
    );
  }
  if (list.isError) {
    return (
      <p className="text-sm text-red-600">
        Could not load feedback. Try again shortly.
      </p>
    );
  }
  if (list.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (items.length === 0) {
    return <p className="text-sm text-gray-500">Nothing here yet.</p>;
  }

  return (
    <div>
      <ul className="space-y-3">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-lg border border-gray-200 bg-white p-4"
          >
            <div className="mb-2 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
              <span className="rounded bg-gray-100 px-2 py-0.5 font-medium text-gray-700">
                {item.category}
              </span>
              <span>{item.userID}</span>
              <time dateTime={item.createdAt.toISOString()}>
                {item.createdAt.toLocaleString()}
              </time>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-gray-900">
              {item.message}
            </p>
          </li>
        ))}
      </ul>
      {list.hasNextPage && (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => void list.fetchNextPage()}
            disabled={list.isFetchingNextPage}
            className="text-sm font-medium text-emerald-700 hover:text-emerald-800 disabled:text-gray-400"
          >
            {list.isFetchingNextPage ? "Loading…" : "Show older"}
          </button>
        </div>
      )}
    </div>
  );
}
