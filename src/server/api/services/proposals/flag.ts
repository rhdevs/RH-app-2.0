import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const PROPOSALS_FLAG_KEY = "proposals.enabled";
export const PROPOSALS_DISABLED = "PROPOSALS_DISABLED";

const FLAG_TTL_MS = 15_000;
let flagCache: { at: number; on: boolean } | null = null;

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `proposals.enabled` goes on only after create-proposal-indexes.mjs has run
 * and the doctor's director check is green.
 *
 * Cached per lambda for 15 seconds, like areNotificationsEnabled: every gated
 * procedure, the upload route and the navigation entry ask on each call. A
 * failed read is not cached, so an outage is not stretched by the cache.
 * Switching the flag off therefore takes up to 15 seconds to reach every
 * instance.
 */
export async function isProposalsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: PROPOSALS_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetProposalsFlagCache(): void {
  flagCache = null;
}

/** Called first in every gated procedure. */
export async function assertProposalsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isProposalsEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: PROPOSALS_DISABLED });
  }
}
