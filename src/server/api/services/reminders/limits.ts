import { TRPCError } from "@trpc/server";

import { rateLimit } from "~/lib/rateLimit";

/**
 * Per-person hourly ceilings on the reminder writes, one counter per action,
 * in the same window the proposals and disposables use. A director sends a few
 * broadcasts a term; a head marks a few done. Only a script or a stuck client
 * reaches these.
 */
export const REMINDER_WINDOW_MS = 60 * 60 * 1000;
export const REMINDER_LIMITS = {
  send: 10,
  cancel: 30,
  markDone: 120,
} as const;

export type ReminderLimitedAction = keyof typeof REMINDER_LIMITS;

export const reminderLimitKey = (
  action: ReminderLimitedAction,
  userID: string,
) => `reminder.${action}:${userID}`;

/**
 * Spend one unit of the caller's budget for this action, or refuse with
 * TOO_MANY_REQUESTS `RATE_LIMITED:<seconds>`. Called AFTER the access check,
 * so a person who may not act does not write counter rows.
 */
export async function assertWithinLimit(
  action: ReminderLimitedAction,
  userID: string,
): Promise<void> {
  const result = await rateLimit(
    reminderLimitKey(action, userID),
    REMINDER_LIMITS[action],
    REMINDER_WINDOW_MS,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${result.retryAfter}`,
    });
  }
}
