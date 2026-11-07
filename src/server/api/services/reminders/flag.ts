import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const REMINDERS_FLAG_KEY = "reminders.enabled";
export const REMINDERS_DISABLED = "REMINDERS_DISABLED";

const FLAG_TTL_MS = 15_000;
let flagCache: { at: number; on: boolean } | null = null;

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `reminders.enabled` goes on only after
 * create-disposable-reminder-indexes.mjs has run and the doctor is green: it
 * checks that the unique (broadcast, CCA) index exists and that
 * `directors.enabled` is on.
 *
 * Cached per lambda for 15 seconds, like areNotificationsEnabled: the header asks
 * for the navigation entry on every page for every signed-in user. A failed
 * read is not cached, so an outage is not stretched by the cache. Switching
 * the flag off takes up to 15 seconds to reach every instance.
 */
export async function isRemindersEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: REMINDERS_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetRemindersFlagCache(): void {
  flagCache = null;
}

/** Called first in every gated procedure. */
export async function assertRemindersEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isRemindersEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: REMINDERS_DISABLED });
  }
}
