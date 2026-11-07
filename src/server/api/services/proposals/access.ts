import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  currentDirectorIDs,
  directedCcaIDs,
  isDirectorOf,
  NOT_DIRECTOR,
} from "~/server/api/services/directorGuard";

/**
 * Who may touch a CCA's proposals, decided from the stored rows every time.
 *
 * - A HEAD (a `CcaHead` row for THIS CCA) reads, writes and submits.
 * - A DIRECTOR of the CCA (directorGuard) reads what has been submitted, and
 *   approves, returns and finishes it. A person can be both: a director who
 *   also heads the CCA may approve their own proposal (merge proposal 4.2).
 * - Everyone else is refused, admins who are neither included.
 *
 * NOT used, on purpose: `getUserRoles` (forgiving: a failed read keeps stored
 * roles), the session's roles (a 30-day JWT), `assertHeadsCca` (lets an admin
 * through for any CCA), `myPositionCcas` and the oversees-all switch (built for
 * views, they hand every CCA to people who hold no position). The reads here
 * have no catch around any single one; a catch wraps the WHOLE decision, only
 * ever refuses, and logs the error name alone (a driver message can carry
 * stored values). During a database fault nobody can act until it passes.
 * A source scan in proposalAccess.test.ts keeps those imports out.
 */

export const NOT_CCA_HEAD = "NOT_CCA_HEAD";
export const NOT_PROPOSAL_READER = "NOT_PROPOSAL_READER";
export const PROPOSAL_ACCESS_CHECK_FAILED = "PROPOSAL_ACCESS_CHECK_FAILED";

/**
 * What the director guard reads, plus the head table. Spelled from the guard's
 * own signature so this file never names the position collections (a source
 * scan keeps them to the positions files and the guard).
 */
export type ProposalAccessDb = Parameters<typeof isDirectorOf>[0] &
  Pick<PrismaClient, "ccaHead">;

export type ProposalViewer = "head" | "director";

function refuseOnFailure(err: unknown): never {
  console.error(
    JSON.stringify({
      evt: "proposal_access_read_failed",
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  throw new TRPCError({
    code: "FORBIDDEN",
    message: PROPOSAL_ACCESS_CHECK_FAILED,
  });
}

/** Strict read: does this person head THIS CCA right now? Rejects on failure. */
async function headsCca(
  db: Pick<ProposalAccessDb, "ccaHead">,
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

export const PROPOSAL_NOT_FOUND = "PROPOSAL_NOT_FOUND";

/**
 * How a denial is spelled. Paths that start from a proposal ID the caller
 * sent pass `hideExistence`, so a missing ID and another CCA's ID are the same
 * NOT_FOUND and the ID cannot be used to probe which proposals exist. Paths
 * that start from a CCA ID (create, list) keep the FORBIDDEN, which says
 * nothing about any proposal.
 */
export type DenialOptions = { hideExistence?: boolean };

function denial(code: string, options?: DenialOptions): TRPCError {
  return options?.hideExistence
    ? new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND })
    : new TRPCError({ code: "FORBIDDEN", message: code });
}

/** Refuse unless this person heads this CCA now. */
export async function assertCcaHead(
  db: ProposalAccessDb,
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
  if (!allowed) throw denial(NOT_CCA_HEAD, options);
}

/**
 * Refuse unless this person heads this CCA or directs it now, and say which.
 * A person who is both is a head.
 */
export async function assertProposalReader(
  db: ProposalAccessDb,
  userID: string,
  ccaID: number,
  options?: DenialOptions,
): Promise<ProposalViewer> {
  let viewer: ProposalViewer | null;
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
  if (viewer === null) throw denial(NOT_PROPOSAL_READER, options);
  return viewer;
}

/**
 * Like assertProposalReader, but also says whether the person directs the CCA
 * even when they head it too, so a head who is a director is shown the review
 * actions. Both reads are strict, and either failing refuses the whole call.
 */
export async function proposalAccess(
  db: ProposalAccessDb,
  userID: string,
  ccaID: number,
  options?: DenialOptions,
): Promise<{ viewer: ProposalViewer; isDirector: boolean }> {
  let head: boolean;
  let director: boolean;
  try {
    head = await headsCca(db, userID, ccaID);
    director = await isDirectorOf(db, userID, ccaID);
  } catch (err) {
    return refuseOnFailure(err);
  }
  if (!head && !director) throw denial(NOT_PROPOSAL_READER, options);
  return { viewer: head ? "head" : "director", isDirector: director };
}

/**
 * Refuse unless this person is a director of this CCA NOW, by the strict
 * guard. The CCA is the stored proposal's, never the browser's. A refusal says
 * nothing a missing id would not say when `hideExistence` is set. A read that
 * throws refuses and logs the error name only.
 */
export async function assertProposalDirector(
  db: ProposalAccessDb,
  userID: string,
  ccaID: number,
  options?: DenialOptions,
): Promise<void> {
  let allowed: boolean;
  try {
    allowed = await isDirectorOf(db, userID, ccaID);
  } catch (err) {
    return refuseOnFailure(err);
  }
  if (!allowed) throw denial(NOT_DIRECTOR, options);
}

/**
 * The CCAs this person directs now (possibly none), by the strict guard,
 * filtered in the query to their own flagged positions. A read that throws
 * refuses and logs the error name only; it is never an empty list.
 */
export async function directedCcasOrRefuse(
  db: Parameters<typeof directedCcaIDs>[0],
  userID: string,
): Promise<number[]> {
  try {
    return await directedCcaIDs(db, userID);
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/**
 * Everyone who directs this CCA now (possibly nobody), by the strict guard,
 * for the outcome notices. Run on the move's transaction client, so a read
 * that throws refuses, logs the error name only and rolls the move back.
 */
export async function directorsOrRefuse(
  db: Parameters<typeof currentDirectorIDs>[0],
  ccaID: number,
): Promise<string[]> {
  try {
    return await currentDirectorIDs(db, ccaID);
  } catch (err) {
    return refuseOnFailure(err);
  }
}

/**
 * The self-approved label: true when the approver is the proposal's author or
 * a head of its CCA right now. Run INSIDE the approval's transaction, so the
 * answer and the history row it goes on come from one snapshot. A read that
 * throws refuses the approval: a missing label would hide the very thing the
 * trail exists to show.
 */
export async function readSelfApproved(
  db: Pick<ProposalAccessDb, "ccaHead">,
  approverID: string,
  proposal: { ccaID: number; createdBy: string | null },
): Promise<boolean> {
  try {
    if (proposal.createdBy !== null && proposal.createdBy === approverID) {
      return true;
    }
    return await headsCca(db, approverID, proposal.ccaID);
  } catch (err) {
    return refuseOnFailure(err);
  }
}
