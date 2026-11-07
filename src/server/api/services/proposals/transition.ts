import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { isWriteConflict } from "~/lib/transcript/writeConflict";
import { canTransition, type ProposalStatus } from "~/lib/proposals/status";

/**
 * THE ONLY CODE THAT WRITES `Proposal.status` (merge proposal 4.1). The one
 * other place a status is ever stored is the schema default, "draft", applied
 * when a proposal is created; proposalStatusWriter.test.ts scans the source to
 * keep it so.
 *
 * One call is one transaction holding three writes that stand or fall
 * together:
 *  1. a COMPARE-AND-SET on the proposal: `updateMany` whose filter names the
 *     status the caller saw (and, for submit, the content version it
 *     validated), so it applies only if nothing moved in between. Zero rows
 *     changed means a stale caller, and the answer is CONFLICT with nothing
 *     written. This is what makes two directors pressing approve and return at
 *     once safe: exactly one of them wins;
 *  2. a `ProposalStatusHistory` row, carrying the approver and the
 *     self-approved label when the move is an approval. The label can be
 *     worked out INSIDE this transaction (`options.selfApproved`), after the
 *     compare-and-set has applied and before the row is written, so a failed
 *     read of it rolls the whole move back;
 *  3. an audit row (`proposal.transition`, RoleAuditLog) written on the SAME
 *     transaction client. This is deliberately unlike writeAudit, which takes
 *     the plain client so a denial survives its own rollback: here the audit
 *     row is part of the change, so a change without its row must not exist.
 *
 * MongoDB gives a transaction snapshot isolation. Two overlapping transactions
 * that both write the same proposal do not both commit: the loser is aborted
 * with a write conflict (Prisma P2034), mapped to the same CONFLICT.
 *
 * `inTransaction` runs inside the transaction after the three writes, with the
 * transaction client, so a caller's notices commit or roll back with the
 * change. If it throws, the status change, history row and audit row are
 * rolled back too.
 *
 * Whether the actor MAY make this move is the caller's job, done before this
 * call; this function checks only that the move exists in the table.
 */

export const PROPOSAL_CONFLICT = "PROPOSAL_CONFLICT";
export const PROPOSAL_BAD_TRANSITION = "PROPOSAL_BAD_TRANSITION";
export const PROPOSAL_AUDIT_ACTION = "proposal.transition";

export type TransitionInput = {
  proposalID: string;
  /** The status the caller saw. The write applies only if it is still this. */
  from: ProposalStatus;
  to: ProposalStatus;
  /** Who made the move. */
  actorID: string;
  /** If set, the write also needs the proposal still in this CCA (the one the caller checked access for). */
  expectedCcaID?: number;
  /** If set, the write also needs the proposal still at this content version. */
  expectedVersion?: number;
  /** Who approved (when `to` is "cleared"). */
  approverID?: string | null;
  /** True when the approver is also a head of the CCA. */
  selfApproved?: boolean;
  note?: string | null;
};

export type TransitionedProposal = {
  id: string;
  ccaID: number;
  /** The author, or null once their account is deleted. */
  createdBy: string | null;
  title: string;
  version: number;
};

export type TransitionOptions = {
  /**
   * Works out the self-approved label inside the transaction, from the
   * transaction client, once the compare-and-set has applied. Overrides
   * `input.selfApproved`. If it throws, nothing is written.
   */
  selfApproved?: (
    tx: Prisma.TransactionClient,
    proposal: TransitionedProposal,
  ) => Promise<boolean>;
  /** Runs inside the transaction, after the three writes. */
  inTransaction?: (
    tx: Prisma.TransactionClient,
    proposal: TransitionedProposal,
  ) => Promise<void>;
};

const conflict = () =>
  new TRPCError({ code: "CONFLICT", message: PROPOSAL_CONFLICT });

export async function transitionProposal(
  db: PrismaClient,
  input: TransitionInput,
  options: TransitionOptions = {},
): Promise<TransitionedProposal> {
  if (!canTransition(input.from, input.to)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: PROPOSAL_BAD_TRANSITION,
    });
  }
  try {
    return await db.$transaction(async (tx) => {
      const changed = await tx.proposal.updateMany({
        where: {
          id: input.proposalID,
          status: input.from,
          ...(input.expectedCcaID !== undefined && {
            ccaID: input.expectedCcaID,
          }),
          ...(input.expectedVersion !== undefined && {
            version: input.expectedVersion,
          }),
        },
        data: {
          status: input.to,
          version: { increment: 1 },
          ...(input.to === "in_review" && { submittedAt: new Date() }),
        },
      });
      if (changed.count !== 1) throw conflict();

      const row = await tx.proposal.findUnique({
        where: { id: input.proposalID },
        select: {
          id: true,
          ccaID: true,
          createdBy: true,
          title: true,
          version: true,
        },
      });
      if (!row) throw conflict();

      const selfApproved = options.selfApproved
        ? await options.selfApproved(tx, row)
        : (input.selfApproved ?? false);

      await tx.proposalStatusHistory.create({
        data: {
          proposalID: row.id,
          fromStatus: input.from,
          toStatus: input.to,
          actorID: input.actorID,
          approverID: input.approverID ?? null,
          selfApproved,
          note: input.note ?? null,
        },
      });
      await tx.roleAuditLog.create({
        data: {
          actorUserID: input.actorID,
          actorRoles: [],
          targetUserID: null,
          targetFacilityID: null,
          targetCcaID: row.ccaID,
          targetEventID: null,
          action: PROPOSAL_AUDIT_ACTION,
          rolesBefore: [],
          rolesAfter: [],
          reason: `proposal ${row.id}: ${input.from} -> ${input.to}`,
          ok: true,
          denyReason: null,
          batchId: null,
        },
      });

      await options.inTransaction?.(tx, row);
      return row;
    });
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    if (isWriteConflict(err)) throw conflict();
    throw err;
  }
}
