import { TRPCError } from "@trpc/server";

import { rateLimit } from "~/lib/rateLimit";

/**
 * Per-person hourly ceilings on the evidence calls, one counter per action, in
 * the same window the proposals and reminders use. A head uploads a handful of
 * photos for a milestone; `view` is higher because one screen of thumbnails is
 * one request each. Only a script or a stuck client reaches these. The view
 * ceiling is 3000: responses are `no-store`, so every reload fetches every
 * thumbnail again, and a page can show 50 of them.
 */
export const EVIDENCE_WINDOW_MS = 60 * 60 * 1000;
export const EVIDENCE_LIMITS = {
  upload: 40,
  record: 40,
  remove: 60,
  view: 3000,
  // PR 16: the filing calls. A head saves a rating a few times per milestone;
  // a director rates once. `browse` covers the read calls (a milestone, a year,
  // the home entries), which a screen fires on load.
  file: 60,
  attach: 60,
  detach: 60,
  rate: 30,
  browse: 600,
} as const;

export type EvidenceLimitedAction = keyof typeof EVIDENCE_LIMITS;

export const evidenceLimitKey = (
  action: EvidenceLimitedAction,
  userID: string,
) => `milestone.${action}:${userID}`;

/**
 * Spend one unit of the caller's budget for this action, or refuse with
 * TOO_MANY_REQUESTS `RATE_LIMITED:<seconds>`. Called AFTER the access check,
 * so a person who may not act does not write counter rows.
 */
export async function assertWithinLimit(
  action: EvidenceLimitedAction,
  userID: string,
): Promise<void> {
  const result = await rateLimit(
    evidenceLimitKey(action, userID),
    EVIDENCE_LIMITS[action],
    EVIDENCE_WINDOW_MS,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${result.retryAfter}`,
    });
  }
}
