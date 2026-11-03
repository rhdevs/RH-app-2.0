"use client";

import { api } from "~/trpc/react";
import { NotificationRow } from "./NotificationRow";

const PAGE_SIZE = 20;

/** The inbox. Inert (one line of text, no list query) while the switch is off. */
export default function NotificationList() {
  const utils = api.useUtils();
  const enabledQuery = api.notifications.enabled.useQuery(undefined, {
    retry: false,
  });
  const enabled = enabledQuery.data?.enabled === true;

  const list = api.notifications.list.useInfiniteQuery(
    { limit: PAGE_SIZE },
    {
      enabled,
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const refresh = () =>
    Promise.all([
      utils.notifications.list.invalidate(),
      utils.notifications.unreadCount.invalidate(),
    ]);
  const markRead = api.notifications.markRead.useMutation({
    onSuccess: refresh,
  });
  const markAllRead = api.notifications.markAllRead.useMutation({
    onSuccess: refresh,
  });

  if (enabledQuery.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!enabled) {
    return (
      <p className="text-sm text-gray-500">
        Notifications are not switched on yet.
      </p>
    );
  }

  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={() => markAllRead.mutate()}
          disabled={markAllRead.isPending || items.every((i) => i.readAt)}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-800 disabled:text-gray-400"
        >
          Mark all as read
        </button>
      </div>
      {list.isError ? (
        <p className="text-sm text-red-600">
          Could not load your notifications. Try again shortly.
        </p>
      ) : list.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing here yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <NotificationRow
                item={item}
                onOpen={(id) => {
                  if (!item.readAt) markRead.mutate({ ids: [id] });
                }}
              />
            </li>
          ))}
        </ul>
      )}
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
