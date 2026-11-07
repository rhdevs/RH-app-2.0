import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

export const MILESTONES_FLAG_KEY = "milestones.enabled";
export const MILESTONES_DISABLED = "MILESTONES_DISABLED";

/**
 * Fail CLOSED: an absent row, any value but "on", or a failed read is off.
 * `milestones.enabled` goes on only after create-milestone-indexes.mjs has run
 * and the doctor is green: it checks that the unique evidence pathname index
 * exists and that `directors.enabled` is on. It also needs the private store's
 * token (MILESTONE_BLOB_READ_WRITE_TOKEN); without it uploads and reads are
 * refused, never sent to the public store.
 */
export async function isMilestonesEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: MILESTONES_FLAG_KEY },
    });
    return row?.value === "on";
  } catch {
    return false;
  }
}

/** Called first in every gated procedure. */
export async function assertMilestonesEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isMilestonesEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: MILESTONES_DISABLED });
  }
}
