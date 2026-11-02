import { TRPCError } from "@trpc/server";

import { rateLimit } from "~/lib/rateLimit";

/**
 * Per-person hourly ceilings on the disposable writes, one counter per action,
 * in the same window the proposals use (services/proposals/limits.ts). A CCA
 * files a few requests a term; the Social director works a queue, so a
 * decision gets a ceiling well above a day's review. Only a script or a stuck
 * client reaches these.
 */
export const DISPOSABLE_WINDOW_MS = 60 * 60 * 1000;
export const DISPOSABLE_LIMITS = {
  create: 20,
  update: 60,
  approve: 120,
  reject: 120,
  delete: 60,
  nudge: 30,
} as const;

export type DisposableLimitedAction = keyof typeof DISPOSABLE_LIMITS;

export const disposableLimitKey = (
  action: DisposableLimitedAction,
  userID: string,
) => `disposable.${action}:${userID}`;

/**
 * Spend one unit of the caller's budget for this action, or refuse with
 * TOO_MANY_REQUESTS `RATE_LIMITED:<seconds>`. Called AFTER the access check,
 * so a person who may not act does not write counter rows.
 */
export async function assertWithinLimit(
  action: DisposableLimitedAction,
  userID: string,
): Promise<void> {
  const result = await rateLimit(
    disposableLimitKey(action, userID),
    DISPOSABLE_LIMITS[action],
    DISPOSABLE_WINDOW_MS,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${result.retryAfter}`,
    });
  }
}
