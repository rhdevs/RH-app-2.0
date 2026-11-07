import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { directorProposalHref, headProposalHref } from "~/lib/proposals/links";
import { REVIEW_MOVES, type ReviewAction } from "~/lib/proposals/status";
import { notify } from "~/server/api/services/notifications";
import {
  assertProposalDirector,
  directorsOrRefuse,
  readSelfApproved,
} from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";
import { draftEventAfterApproval, type EventDraftOutcome } from "./eventLink";
import { assertWithinLimit } from "./limits";
import {
  PROPOSAL_CONFLICT,
  transitionProposal,
  type TransitionedProposal,
} from "./transition";

/**
 * A director approves, returns or finishes a proposal: three moves, one path.
 *
 * WHO MAY ACT is worked out here, every time, from the stored rows:
 *  1. load the proposal and take its CCA from the STORED row (the browser sends
 *     an id and a version, never a CCA or a position);
 *  2. ask the strict guard (`assertProposalDirector`, which is directorGuard's
 *     `isDirectorOf`) whether this person is a director of THAT CCA now. A
 *     read that throws refuses, writes nothing and logs the error name only.
 *     Anyone else gets the same NOT_FOUND a missing id gets;
 *  3. spend the person's hourly budget (after the guard, so a person who may
 *     not act writes no counter);
 *  4. check the proposal is in the one status this move starts from, at the
 *     version the director read (CONFLICT otherwise). A draft is invisible to
 *     directors, so it answers NOT_FOUND (B19);
 *  5. `transitionProposal`: one compare-and-set, the history row, the audit
 *     row and the notices to the heads and the other directors in ONE transaction. If the notice cannot be
 *     written the move is rolled back with it.
 *
 * Not used, on purpose: getUserRoles, the session's roles, myPositionCcas, the
 * oversees-all switch. A director who also heads the CCA may approve their own
 * proposal; the history then carries the self-approved label, worked out in
 * the same transaction (the RFs read it first, and a second rule would add no
 * second reader). RHApp does not wait for, send or record the RF email:
 * `cleared` means only that the director approved.
 */

export type ReviewInput = { id: string; version: number };
export type ReviewResult = {
  id: string;
  version: number;
  status: "cleared" | "needs_action" | "finished";
  /** Approve only: what the automatic Event draft did. */
  eventDraft?: EventDraftOutcome;
};

type Extras = {
  /** The approval note or the return reason, stored in history. */
  note: string | null;
};

const NOTICE: Record<
  ReviewAction,
  { kind: string; title: string; directorTitle: string; withNote: boolean }
> = {
  approve: {
    kind: "proposal.approved",
    title: "Your proposal was approved",
    directorTitle: "A proposal was approved",
    withNote: true,
  },
  return: {
    kind: "proposal.returned",
    title: "Your proposal was returned to you",
    directorTitle: "A proposal was returned to its head",
    withNote: true,
  },
  finish: {
    kind: "proposal.finished",
    title: "Your proposal was marked finished",
    directorTitle: "A proposal was marked finished",
    withNote: false,
  },
};

async function reviewMove(
  db: PrismaClient,
  userID: string,
  action: ReviewAction,
  input: ReviewInput,
  extras: Extras,
): Promise<ReviewResult> {
  const move = REVIEW_MOVES[action];
  const row = await db.proposal.findUnique({
    where: { id: input.id },
    select: { id: true, ccaID: true, status: true, version: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  await assertProposalDirector(db, userID, row.ccaID, {
    hideExistence: true,
  });
  await assertWithinLimit(action, userID);

  if (row.status === "draft") {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  if (row.status !== move.from || row.version !== input.version) {
    throw new TRPCError({ code: "CONFLICT", message: PROPOSAL_CONFLICT });
  }

  const moved = await transitionProposal(
    db,
    {
      proposalID: row.id,
      from: move.from,
      to: move.to,
      actorID: userID,
      expectedVersion: input.version,
      expectedCcaID: row.ccaID,
      note: extras.note,
      ...(action === "approve" && { approverID: userID }),
    },
    {
      ...(action === "approve" && {
        selfApproved: (tx, proposal) => readSelfApproved(tx, userID, proposal),
      }),
      inTransaction: (tx, proposal) =>
        noticeOfOutcome(tx, action, proposal, userID, extras.note),
    },
  );
  return { id: moved.id, version: moved.version, status: move.to };
}

/**
 * Tell the CCA's heads and its other directors, except the person who just
 * acted (they know). Written on the transaction client; recipients come from
 * CcaHead rows and the strict guard, never from the request. A read that
 * fails rolls the move back with it.
 *
 * Heads get the note or reason in the body: it is their own proposal. Other
 * directors get the title alone and a link to the director's route (the /cca
 * routes admit heads only): the note is private to the head and the actor.
 * Someone who is both head and director gets the head's notice, once.
 */
async function noticeOfOutcome(
  tx: Prisma.TransactionClient,
  action: ReviewAction,
  proposal: TransitionedProposal,
  actorID: string,
  note: string | null,
): Promise<void> {
  const heads = (
    await tx.ccaHead.findMany({
      where: { ccaID: proposal.ccaID },
      select: { userID: true },
    })
  )
    .map((h) => h.userID)
    .filter((id) => id !== actorID);
  const headSet = new Set(heads);
  const directors = (await directorsOrRefuse(tx, proposal.ccaID)).filter(
    (id) => id !== actorID && !headSet.has(id),
  );
  const spec = NOTICE[action];
  await notify(tx, {
    recipients: heads,
    kind: spec.kind,
    title: spec.title,
    body:
      spec.withNote && note
        ? `${proposal.title}: ${note}`.slice(0, 1000)
        : proposal.title,
    href: headProposalHref(proposal.ccaID, proposal.id),
  });
  await notify(tx, {
    recipients: directors,
    kind: spec.kind,
    title: spec.directorTitle,
    body: proposal.title,
    href: directorProposalHref(proposal.id),
  });
}

/**
 * Approve, and THEN, if the head asked for an Event, make its draft. The
 * approval has committed by then; the draft step never throws and never
 * undoes it (eventLink.ts), and the Create event button recovers a miss.
 */
export async function approveProposal(
  db: PrismaClient,
  userID: string,
  input: ReviewInput & { note?: string | null | undefined },
): Promise<ReviewResult> {
  const result = await reviewMove(db, userID, "approve", input, {
    note: input.note ?? null,
  });
  const eventDraft = await draftEventAfterApproval(db, result.id);
  return { ...result, eventDraft };
}

export function returnProposal(
  db: PrismaClient,
  userID: string,
  input: ReviewInput & { reason: string },
): Promise<ReviewResult> {
  return reviewMove(db, userID, "return", input, { note: input.reason });
}

export function finishProposal(
  db: PrismaClient,
  userID: string,
  input: ReviewInput,
): Promise<ReviewResult> {
  return reviewMove(db, userID, "finish", input, { note: null });
}
