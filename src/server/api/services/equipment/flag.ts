import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const EQUIPMENT_FLAG_KEY = "equipment.enabled";
export const EQUIPMENT_DISABLED = "EQUIPMENT_DISABLED";

/**
 * Fail CLOSED, read exactly as `disposables.enabled` is: an absent row, any
 * value but "on", or a failed read is off. The Social director, who runs the
 * list and the decisions, is the strict guard's answer (it needs
 * `directors.enabled` and exactly one flagged position); with that unavailable
 * nobody can decide a loan, but the board and the filing still work.
 */
export async function isEquipmentEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: EQUIPMENT_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every gated procedure. */
export async function assertEquipmentEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isEquipmentEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: EQUIPMENT_DISABLED });
  }
}
