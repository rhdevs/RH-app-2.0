import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  isProposalCategory,
  missingForSubmit,
} from "~/lib/proposals/categories";
import { directorProposalHref } from "~/lib/proposals/links";
import { isProposalStatus, SUBMITTABLE_STATUSES } from "~/lib/proposals/status";
import { ADMIN_ROLE, HALL_OFFICE_ROLE, SCRC_ROLE } from "~/lib/roleNames";
import { currentDirectorIDs } from "~/server/api/services/directorGuard";
import { notify } from "~/server/api/services/notifications";
import { assertCcaHead } from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";
import { assertWithinLimit } from "./limits";
import { PROPOSAL_CONFLICT, transitionProposal } from "./transition";

export const PROPOSAL_INCOMPLETE = "PROPOSAL_INCOMPLETE";

const STAFF_ROLES = [ADMIN_ROLE, SCRC_ROLE, HALL_OFFICE_ROLE];

/**
 * Submit a proposal to the CCA's director: ONE server call. The caller must
 * head the CCA (a strict read).
 *
 * The order, and why it is safe to fail at any point:
 *  1. read the row and refuse unless the version and status are the ones the
 *     caller saw (CONFLICT), and the category's rules are met
 *     (BAD_REQUEST `PROPOSAL_INCOMPLETE:<what is missing>`). Nothing has been
 *     written yet;
 *  2. `transitionProposal` moves draft or returned to in_review as a
 *     compare-and-set on both the status AND the version just validated, so
 *     content edited after step 1 makes the write find nothing and refuse,
 *     instead of sending content nobody checked;
 *  3. inside that same transaction the notices are written. A failure there
 *     rolls back the move, its history row and its audit row: A FAILED SUBMIT
 *     LEAVES THE DRAFT EXACTLY AS IT WAS (A20).
 *
 * Who is told: the CCA's directors (`proposal.submitted`). If there are none
 * (every flagged position is vacant, or `directors.enabled` is off) the
 * proposal still goes to in_review and admins, RFs and Hall Office are told
 * instead (`proposal.vacant`, A49), so it does not sit unseen. A director who
 * also heads the CCA does not count: they would be vetting their own CCA's
 * proposal, so a CCA whose only directors head it is vacant too. `notify`
 * writes nothing while `notifications.enabled` is off.
 */
export async function submitProposal(
  db: PrismaClient,
  userID: string,
  input: { id: string; version: number },
): Promise<{ id: string; version: number; status: "in_review" }> {
  const row = await db.proposal.findUnique({ where: { id: input.id } });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  // A non-head gets the same NOT_FOUND as a missing id.
  await assertCcaHead(db, userID, row.ccaID, { hideExistence: true });
  await assertWithinLimit("submit", userID);

  if (
    !isProposalStatus(row.status) ||
    !SUBMITTABLE_STATUSES.includes(row.status) ||
    row.version !== input.version
  ) {
    throw new TRPCError({ code: "CONFLICT", message: PROPOSAL_CONFLICT });
  }
  if (!isProposalCategory(row.category)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${PROPOSAL_INCOMPLETE}:A valid category`,
    });
  }
  const missing = missingForSubmit({
    category: row.category,
    title: row.title,
    description: row.description,
    blastMessage: row.blastMessage,
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    posterUrl: row.posterUrl,
    docLink: row.docLink,
  });
  if (missing.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${PROPOSAL_INCOMPLETE}:${missing.join("; ")}`,
    });
  }

  const moved = await transitionProposal(
    db,
    {
      proposalID: row.id,
      from: row.status,
      to: "in_review",
      actorID: userID,
      expectedVersion: row.version,
    },
    {
      inTransaction: (tx, proposal) =>
        noticeOfSubmission(tx, proposal.id, proposal.ccaID, proposal.title),
    },
  );
  return { id: moved.id, version: moved.version, status: "in_review" };
}

const isUserID = (id: string | null | undefined): id is string =>
  typeof id === "string" && id.trim() !== "";

async function noticeOfSubmission(
  tx: Prisma.TransactionClient,
  proposalID: string,
  ccaID: number,
  title: string,
): Promise<void> {
  const candidates = (await currentDirectorIDs(tx, ccaID)).filter(isUserID);
  const heads =
    candidates.length === 0
      ? []
      : await tx.ccaHead.findMany({
          where: { ccaID, userID: { in: candidates } },
          select: { userID: true },
        });
  const headIDs = new Set(heads.map((h) => h.userID));
  const directors = candidates.filter((id) => !headIDs.has(id));
  if (directors.length > 0) {
    await notify(tx, {
      recipients: directors,
      kind: "proposal.submitted",
      title: "A proposal is ready for your review",
      body: title,
      href: directorProposalHref(proposalID),
    });
    return;
  }
  // No director can act for this CCA now. Staff get no link: the proposal
  // screen is for the CCA's own heads and directors.
  const staff = await tx.userRole.findMany({
    where: {
      OR: [{ roles: { hasSome: STAFF_ROLES } }, { role: { in: STAFF_ROLES } }],
    },
    select: { userID: true },
  });
  await notify(tx, {
    // A role row with a blank id would make `notify` throw and roll back the
    // submit, so it is left out.
    recipients: staff.map((s) => s.userID).filter(isUserID),
    kind: "proposal.vacant",
    title: `A proposal for CCA ${ccaID} has no director to review it`,
    body: title,
  });
}
