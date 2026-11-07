import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const DISPOSABLES_FLAG_KEY = "disposables.enabled";
export const DISPOSABLES_DISABLED = "DISPOSABLES_DISABLED";

const FLAG_TTL_MS = 15_000;
let flagCache: { at: number; on: boolean } | null = null;

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `disposables.enabled` goes on only after
 * create-disposable-reminder-indexes.mjs has run and the doctor is green: it
 * checks that the partial unique index exists, that `directors.enabled` is on,
 * and that exactly one position handles disposables and has a holder.
 *
 * Cached per lambda for 15 seconds, like areNotificationsEnabled: the header asks
 * for the navigation entry on every page for every signed-in user. A failed
 * read is not cached, so an outage is not stretched by the cache. Switching
 * the flag off takes up to 15 seconds to reach every instance.
 */
export async function isDisposablesEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: DISPOSABLES_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetDisposablesFlagCache(): void {
  flagCache = null;
}

/** Called first in every gated procedure. */
export async function assertDisposablesEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isDisposablesEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: DISPOSABLES_DISABLED });
  }
}
