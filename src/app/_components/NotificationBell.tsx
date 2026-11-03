"use client";

import Link from "next/link";
import { Bell } from "lucide-react";

import { api } from "~/trpc/react";

/** Largest count drawn on the badge; anything above reads "99+". */
export const BADGE_MAX = 99;

export function badgeLabel(count: number): string {
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/**
 * The bell in the header. It draws nothing at all while `notifications.enabled`
 * is off (or while that answer is loading or failed), and it asks for the
 * unread count only once the switch is known to be on. Both queries are plain
 * reads: opening the app writes nothing.
 */
export default function NotificationBell({ signedIn }: { signedIn: boolean }) {
  const enabled =
    api.notifications.enabled.useQuery(undefined, {
      enabled: signedIn,
      retry: false,
      staleTime: 60_000,
    }).data?.enabled === true;
  const count =
    api.notifications.unreadCount.useQuery(undefined, {
      enabled: signedIn && enabled,
      retry: false,
    }).data?.count ?? 0;

  if (!signedIn || !enabled) return null;

  return (
    <Link
      href="/notifications"
      aria-label={
        count > 0 ? `Notifications, ${count} unread` : "Notifications"
      }
      className="relative flex h-10 w-10 items-center justify-center rounded-full text-emerald-100 transition-colors duration-200 hover:bg-emerald-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
    >
      <Bell size={20} />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-amber-400 px-1 text-center text-[0.7rem] font-semibold leading-[1.1rem] text-emerald-950 ring-2 ring-emerald-800"
        >
          {badgeLabel(count)}
        </span>
      )}
    </Link>
  );
}
