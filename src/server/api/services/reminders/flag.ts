import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const REMINDERS_FLAG_KEY = "reminders.enabled";
export const REMINDERS_DISABLED = "REMINDERS_DISABLED";

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `reminders.enabled` goes on only after
 * create-disposable-reminder-indexes.mjs has run and the doctor is green: it
 * checks that the unique (broadcast, CCA) index exists and that
 * `directors.enabled` is on.
 */
export async function isRemindersEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: REMINDERS_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every gated procedure. */
export async function assertRemindersEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isRemindersEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: REMINDERS_DISABLED });
  }
}
