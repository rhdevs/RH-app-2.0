import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const DISPOSABLES_FLAG_KEY = "disposables.enabled";
export const DISPOSABLES_DISABLED = "DISPOSABLES_DISABLED";

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `disposables.enabled` goes on only after
 * create-disposable-reminder-indexes.mjs has run and the doctor is green: it
 * checks that the partial unique index exists, that `directors.enabled` is on,
 * and that exactly one position handles disposables and has a holder.
 */
export async function isDisposablesEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: DISPOSABLES_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every gated procedure. */
export async function assertDisposablesEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isDisposablesEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: DISPOSABLES_DISABLED });
  }
}
