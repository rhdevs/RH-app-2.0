import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const CALENDAR_FEED_FLAG_KEY = "calendar.feed.enabled";
export const CALENDAR_FEED_DISABLED = "CALENDAR_FEED_DISABLED";

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * Not cached, so switching the flag off stops every feed and every token
 * procedure on the next request. `calendar.feed.enabled` goes on only after
 * create-calendar-feed-indexes.mjs has run and its census shows the indexes.
 * The calendar page itself needs no flag of its own: it shows nothing the
 * Events list does not (`events.enabled`).
 */
export async function isCalendarFeedEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: CALENDAR_FEED_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every token procedure. */
export async function assertCalendarFeedEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isCalendarFeedEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: CALENDAR_FEED_DISABLED });
  }
}
