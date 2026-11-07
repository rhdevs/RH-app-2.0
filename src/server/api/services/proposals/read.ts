import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { EDITABLE_STATUSES, isProposalStatus } from "~/lib/proposals/status";
import { assertProposalReader, type ProposalViewer } from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";

/**
 * What a reader sees. Two rules shape it:
 *  - A director sees a proposal only once it has been SUBMITTED. A draft is
 *    the head's work in progress; for a director it does not exist (NOT_FOUND,
 *    and it is missing from the list).
 *  - No person id leaves the server. The author and the actors of history
 *    rows are reduced to "is it me", so the screens never hold ids of people
 *    who are not the viewer.
 * `eventID` is not returned: nothing in this PR uses it.
 */

const LIST_MAX = 200;

export type ProposalListItem = {
  id: string;
  category: string;
  title: string;
  status: string;
  updatedAt: Date;
  submittedAt: Date | null;
};

export type ProposalDetail = ProposalListItem & {
  ccaID: number;
  description: string;
  blastMessage: string | null;
  plannedStart: number | null;
  plannedEnd: number | null;
  posterUrl: string | null;
  docLink: string | null;
  version: number;
  createdAt: Date;
  createdByMe: boolean;
  viewer: ProposalViewer;
  canEdit: boolean;
  history: Array<{
    id: string;
    fromStatus: string;
    toStatus: string;
    at: Date;
    byMe: boolean;
    selfApproved: boolean;
    note: string | null;
  }>;
};

const hiddenFromDirector = (viewer: ProposalViewer, status: string) =>
  viewer === "director" && status === "draft";

export async function getProposal(
  db: PrismaClient,
  userID: string,
  id: string,
): Promise<ProposalDetail> {
  const row = await db.proposal.findUnique({ where: { id } });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  // A non-reader gets the same NOT_FOUND as a missing id.
  const viewer = await assertProposalReader(db, userID, row.ccaID, {
    hideExistence: true,
  });
  if (hiddenFromDirector(viewer, row.status)) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  const history = await db.proposalStatusHistory.findMany({
    where: { proposalID: row.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
  });
  return {
    id: row.id,
    ccaID: row.ccaID,
    category: row.category,
    title: row.title,
    description: row.description,
    blastMessage: row.blastMessage,
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    posterUrl: row.posterUrl ?? null,
    docLink: row.docLink ?? null,
    status: row.status,
    version: row.version,
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByMe: row.createdBy === userID,
    viewer,
    canEdit:
      viewer === "head" &&
      isProposalStatus(row.status) &&
      EDITABLE_STATUSES.includes(row.status),
    history: history.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      at: h.createdAt,
      byMe: h.actorID === userID,
      selfApproved: h.selfApproved,
      note: h.note,
    })),
  };
}

/** The proposals of ONE CCA, newest edit first. The CCA is checked first. */
export async function listProposals(
  db: PrismaClient,
  userID: string,
  ccaID: number,
): Promise<{ viewer: ProposalViewer; items: ProposalListItem[] }> {
  const viewer = await assertProposalReader(db, userID, ccaID);
  const items = await db.proposal.findMany({
    where: {
      ccaID,
      ...(viewer === "director" && { status: { not: "draft" } }),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: LIST_MAX,
    select: {
      id: true,
      category: true,
      title: true,
      status: true,
      updatedAt: true,
      submittedAt: true,
    },
  });
  return { viewer, items };
}
