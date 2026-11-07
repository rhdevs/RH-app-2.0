import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const EQUIPMENT_FLAG_KEY = "equipment.enabled";
export const EQUIPMENT_DISABLED = "EQUIPMENT_DISABLED";

const FLAG_TTL_MS = 15_000;
let flagCache: { at: number; on: boolean } | null = null;

/**
 * Fail CLOSED, read exactly as `disposables.enabled` is: an absent row, any
 * value but "on", or a failed read is off. The Social director, who runs the
 * list and the decisions, is the strict guard's answer (it needs
 * `directors.enabled` and exactly one flagged position); with that unavailable
 * nobody can decide a loan, but the board and the filing still work.
 *
 * Cached per lambda for 15 seconds, like isDisposablesEnabled: the header asks
 * for the navigation entry (`equipment.entry`) on every page for every
 * signed-in user. A failed read is not cached, so an outage is not stretched
 * by the cache. Switching the flag off takes up to 15 seconds to reach every
 * instance.
 */
export async function isEquipmentEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: EQUIPMENT_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetEquipmentFlagCache(): void {
  flagCache = null;
}

/** Called first in every gated procedure. */
export async function assertEquipmentEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isEquipmentEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: EQUIPMENT_DISABLED });
  }
}
