import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const PROPOSALS_FLAG_KEY = "proposals.enabled";
export const PROPOSALS_DISABLED = "PROPOSALS_DISABLED";

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `proposals.enabled` goes on only after create-proposal-indexes.mjs has run
 * and the doctor's director check is green.
 */
export async function isProposalsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: PROPOSALS_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every gated procedure. */
export async function assertProposalsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isProposalsEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: PROPOSALS_DISABLED });
  }
}
