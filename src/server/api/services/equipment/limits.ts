import { TRPCError } from "@trpc/server";

import { rateLimit } from "~/lib/rateLimit";

/**
 * Per-person hourly ceilings on the equipment writes, one counter per action,
 * in the same window the disposables use. An event files a loan or two; the
 * Social director works a queue, so a decision gets a ceiling well above a
 * day's review. `check` is the form's live preview, which asks as the person
 * types. `upload` and `view` are for the return photo. Only a script or a
 * stuck client reaches these.
 */
export const EQUIPMENT_WINDOW_MS = 60 * 60 * 1000;
export const EQUIPMENT_LIMITS = {
  file: 20,
  approve: 120,
  reject: 120,
  cancel: 60,
  collect: 60,
  return: 60,
  note: 60,
  check: 300,
  item: 120,
  upload: 40,
  view: 600,
} as const;

export type EquipmentLimitedAction = keyof typeof EQUIPMENT_LIMITS;

export const equipmentLimitKey = (
  action: EquipmentLimitedAction,
  userID: string,
) => `equipment.${action}:${userID}`;

/**
 * Spend one unit of the caller's budget for this action, or refuse with
 * TOO_MANY_REQUESTS `RATE_LIMITED:<seconds>`. Called AFTER the access check,
 * so a person who may not act does not write counter rows.
 */
export async function assertWithinLimit(
  action: EquipmentLimitedAction,
  userID: string,
): Promise<void> {
  const result = await rateLimit(
    equipmentLimitKey(action, userID),
    EQUIPMENT_LIMITS[action],
    EQUIPMENT_WINDOW_MS,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${result.retryAfter}`,
    });
  }
}
