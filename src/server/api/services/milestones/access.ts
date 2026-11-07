import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { isDirectorOf } from "~/server/api/services/directorGuard";

/**
 * Who may touch a CCA's milestone evidence, decided from the stored rows every
 * time (merge proposal 4.6).
 *
 * - A HEAD (a `CcaHead` row for THIS CCA) uploads, lists and removes.
 * - A DIRECTOR of the CCA (directorGuard, which also needs `directors.enabled`)
 *   may view the photo, and nothing else.
 * - Everyone else is refused: admins, RF, JCRC and other position holders
 *   included.
 *
 * NOT used, on purpose: `getUserRoles` (forgiving: a failed read keeps stored
 * roles), the session's roles (a 30-day JWT), `assertHeadsCca` (lets an admin
 * through for any CCA), `myPositionCcas` and the oversees-all switch (built for
 * views, they hand every CCA to people who hold no position). The reads here
 * have no catch around any single one; a catch wraps the WHOLE decision, only
 * ever refuses, and logs the error name alone (a driver message can carry
 * stored values). During a database fault nobody can act until it passes.
 * A source scan in milestoneSourceScans.test.ts keeps those imports out.
 */

export const NOT_EVIDENCE_HEAD = "NOT_EVIDENCE_HEAD";
export const NOT_EVIDENCE_READER = "NOT_EVIDENCE_READER";
export const EVIDENCE_NOT_FOUND = "EVIDENCE_NOT_FOUND";
export const MILESTONE_ACCESS_CHECK_FAILED = "MILESTONE_ACCESS_CHECK_FAILED";

/**
 * What the director guard reads, plus the head table. Spelled from the guard's
 * own signature so this file never names the position collections.
 */
export type EvidenceAccessDb = Parameters<typeof isDirectorOf>[0] &
  Pick<PrismaClient, "ccaHead">;

export type EvidenceViewer = "head" | "director";

function refuseOnFailure(err: unknown): never {
  console.error(
    JSON.stringify({
      evt: "milestone_access_read_failed",
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  throw new TRPCError({
    code: "FORBIDDEN",
    message: MILESTONE_ACCESS_CHECK_FAILED,
  });
}

/** Strict read: does this person head THIS CCA right now? Rejects on failure. */
async function headsCca(
  db: Pick<EvidenceAccessDb, "ccaHead">,
  userID: string,
  ccaID: number,
): Promise<boolean> {
  if (!Number.isInteger(ccaID)) return false;
  const row = await db.ccaHead.findFirst({
    where: { userID, ccaID },
    select: { id: true },
  });
  return row !== null;
}

/**
 * How a denial is spelled. Paths that start from an evidence ID the caller
 * sent pass `hideExistence`, so a missing ID and another CCA's ID are the same
 * NOT_FOUND and the ID cannot be used to probe which photos exist.
 */
export type DenialOptions = { hideExistence?: boolean };

function denial(code: string, options?: DenialOptions): TRPCError {
  return options?.hideExistence
    ? new TRPCError({ code: "NOT_FOUND", message: EVIDENCE_NOT_FOUND })
    : new TRPCError({ code: "FORBIDDEN", message: code });
}

/** Refuse unless this person heads this CCA now. */
export async function assertEvidenceHead(
  db: EvidenceAccessDb,
  userID: string,
  ccaID: number,
  options?: DenialOptions,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await headsCca(db, userID, ccaID);
  } catch (err) {
    return refuseOnFailure(err);
  }
  if (!allowed) throw denial(NOT_EVIDENCE_HEAD, options);
}

/**
 * Refuse unless this person heads this CCA or directs it now, and say which.
 * A person who is both is a head. A read that throws refuses.
 */
export async function assertEvidenceReader(
  db: EvidenceAccessDb,
  userID: string,
  ccaID: number,
  options?: DenialOptions,
): Promise<EvidenceViewer> {
  let viewer: EvidenceViewer | null;
  try {
    if (await headsCca(db, userID, ccaID)) {
      viewer = "head";
    } else if (await isDirectorOf(db, userID, ccaID)) {
      viewer = "director";
    } else {
      viewer = null;
    }
  } catch (err) {
    return refuseOnFailure(err);
  }
  if (viewer === null) throw denial(NOT_EVIDENCE_READER, options);
  return viewer;
}
