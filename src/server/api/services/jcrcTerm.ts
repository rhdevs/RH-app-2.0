import type { PrismaClient } from "@prisma/client";

import { JCRC_ROLE } from "~/lib/roleNames";

/**
 * THE LIVE END OF A HANDED-OVER JCRC TERM.
 *
 * A JCRC self-handover sets `JcrcTerm.endsAt` for the outgoing member when they
 * hand over their last position. From that moment `jcrc` must stop working,
 * even though `UserRole.roles` still stores it until sweepEndedJcrcTerms
 * removes it (there is no cron in this app, so the sweep runs lazily).
 *
 * This is the read-side half: given the roles normalised from storage, drop
 * `jcrc` when the term has ended. Called by getUserRoles (every guard) and by
 * the session callback (every page), so the two cannot disagree.
 *
 * Costs nothing for anyone who does not hold `jcrc`: the query is skipped.
 * NEVER THROWS: the session callback must not throw, so a read fault keeps the
 * stored roles and logs. A missed end-of-term for one request is the lesser
 * harm next to logging every JCRC member out.
 */
export async function dropEndedJcrcRole<R extends string>(
  db: PrismaClient,
  userID: string,
  roles: R[],
  now: Date = new Date(),
): Promise<R[]> {
  if (!roles.includes(JCRC_ROLE as R)) return roles;
  try {
    const term = await db.jcrcTerm.findUnique({
      where: { userID },
      select: { endsAt: true },
    });
    if (term && term.endsAt.getTime() <= now.getTime()) {
      return roles.filter((r) => r !== JCRC_ROLE);
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "jcrc_term_read_failed",
        userID,
        // The name only: a driver message can carry stored values.
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
  return roles;
}
