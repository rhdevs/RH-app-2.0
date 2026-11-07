import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { EDITABLE_STATUSES } from "~/lib/proposals/status";
import type {
  ProposalCreateInput,
  ProposalUpdateInput,
} from "~/lib/schemas/proposal";
import { deleteReplacedPoster } from "~/server/api/services/proposalPosterBlob";
import { assertCcaHead, PROPOSAL_NOT_FOUND } from "./access";
import { assertWithinLimit } from "./limits";
import { PROPOSAL_CONFLICT } from "./transition";

export { PROPOSAL_NOT_FOUND };
export const NOTHING_TO_UPDATE = "NOTHING_TO_UPDATE";
export const END_NOT_AFTER_START = "END_NOT_AFTER_START";

/**
 * Create a draft. The caller must head the CCA (a strict read). NO `status` is
 * written here: the schema default ("draft") applies, so
 * `transitionProposal` stays the only code that names a status. Optional
 * columns are written as explicit nulls because on MongoDB a missing key does
 * not match a `null` filter.
 */
export async function createProposal(
  db: PrismaClient,
  userID: string,
  input: ProposalCreateInput,
): Promise<{ id: string; version: number }> {
  await assertCcaHead(db, userID, input.ccaID);
  await assertWithinLimit("create", userID);
  return db.proposal.create({
    data: {
      ccaID: input.ccaID,
      createdBy: userID,
      category: input.category,
      title: input.title,
      description: input.description,
      blastMessage: input.blastMessage,
      plannedStart: input.plannedStart,
      plannedEnd: input.plannedEnd,
      eventID: null,
      posterUrl: null,
      docLink: input.docLink,
      submittedAt: null,
    },
    select: { id: true, version: true },
  });
}

/**
 * Edit the content of a draft (or a returned proposal). The save is a
 * compare-and-set on the version the editor loaded AND on the status still
 * being editable, so a stale tab, or an edit that races a submit, gets
 * CONFLICT and changes nothing. No `status` appears here either.
 */
export async function updateProposal(
  db: PrismaClient,
  userID: string,
  input: ProposalUpdateInput,
): Promise<{ id: string; version: number }> {
  const row = await db.proposal.findUnique({
    where: { id: input.id },
    select: {
      ccaID: true,
      plannedStart: true,
      plannedEnd: true,
      posterUrl: true,
    },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  // A non-head gets the same NOT_FOUND as a missing id.
  await assertCcaHead(db, userID, row.ccaID, { hideExistence: true });
  await assertWithinLimit("update", userID);

  const data = {
    ...(input.category !== undefined && { category: input.category }),
    ...(input.title !== undefined && { title: input.title }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.blastMessage !== undefined && {
      blastMessage: input.blastMessage,
    }),
    ...(input.plannedStart !== undefined && {
      plannedStart: input.plannedStart,
    }),
    ...(input.plannedEnd !== undefined && { plannedEnd: input.plannedEnd }),
    ...(input.posterUrl !== undefined && { posterUrl: input.posterUrl }),
    ...(input.docLink !== undefined && { docLink: input.docLink }),
  };
  if (Object.keys(data).length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: NOTHING_TO_UPDATE });
  }
  // The pair is checked as it will be stored, not just as sent.
  const start =
    input.plannedStart !== undefined ? input.plannedStart : row.plannedStart;
  const end =
    input.plannedEnd !== undefined ? input.plannedEnd : row.plannedEnd;
  if (start !== null && end !== null && end <= start) {
    throw new TRPCError({ code: "BAD_REQUEST", message: END_NOT_AFTER_START });
  }

  const changed = await db.proposal.updateMany({
    where: {
      id: input.id,
      version: input.version,
      status: { in: [...EDITABLE_STATUSES] },
    },
    data: { ...data, version: { increment: 1 } },
  });
  if (changed.count !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: PROPOSAL_CONFLICT });
  }
  // The write succeeded; only now is the replaced poster's blob removed. The
  // version check above means nothing changed the row since it was read, so
  // `row.posterUrl` is the address that was just replaced.
  if (
    input.posterUrl !== undefined &&
    row.posterUrl !== null &&
    row.posterUrl !== input.posterUrl
  ) {
    await deleteReplacedPoster(input.id, row.posterUrl);
  }
  return { id: input.id, version: input.version + 1 };
}
