import { TRPCError } from "@trpc/server";

import { rateLimit } from "~/lib/rateLimit";

/**
 * Per-person ceilings on the proposal writes, one counter per action, in the
 * same one-hour window the feedback form uses. They are set well above what a
 * working head does (a CCA files a handful of proposals a term, and an editor
 * that saves as it goes sends tens of updates), so only a script or a stuck
 * client reaches them.
 */
export const PROPOSAL_WINDOW_MS = 60 * 60 * 1000;
export const PROPOSAL_LIMITS = {
  create: 10,
  update: 120,
  submit: 20,
} as const;

export type LimitedAction = keyof typeof PROPOSAL_LIMITS;

export const proposalLimitKey = (action: LimitedAction, userID: string) =>
  `proposal.${action}:${userID}`;

/**
 * Spend one unit of the caller's budget for this action, or refuse with
 * TOO_MANY_REQUESTS `RATE_LIMITED:<seconds>`. Called AFTER the access check,
 * so a person who may not act does not write counter rows.
 */
export async function assertWithinLimit(
  action: LimitedAction,
  userID: string,
): Promise<void> {
  const result = await rateLimit(
    proposalLimitKey(action, userID),
    PROPOSAL_LIMITS[action],
    PROPOSAL_WINDOW_MS,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${result.retryAfter}`,
    });
  }
}
