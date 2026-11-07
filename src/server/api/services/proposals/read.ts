import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  EDITABLE_STATUSES,
  isProposalStatus,
  reviewActionsFor,
  type ReviewAction,
} from "~/lib/proposals/status";
import {
  assertProposalReader,
  proposalAccess,
  type ProposalViewer,
} from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";
import { readEventLinkView, type EventLinkView } from "./eventLink";
import { displayNames } from "./names";
import { unreadCounts } from "./unread";

/**
 * What a reader sees. Three rules shape it:
 *  - A director sees a proposal only once it has been SUBMITTED. A draft is
 *    the head's work in progress; for a director it does not exist (NOT_FOUND,
 *    and it is missing from the list).
 *  - No person id leaves the server. The author and the actors of history
 *    rows are reduced to "is it me", so the screens never hold ids of people
 *    who are not the viewer. The one name that is shown is the APPROVER's, as a
 *    display name: the trail exists to show who approved (A47).
 *  - The review actions offered are the ones the strict director guard allows
 *    this person NOW, for the proposal's status. They are a convenience for the
 *    screen; approve, return and finish check the guard again themselves.
 * The linked Event is returned as id, status and title only, and only if it
 * still exists; a missing one is flagged (`eventMissing`). The raw `eventID`
 * of the proposal is not returned.
 */

const LIST_MAX = 200;

export type ProposalListItem = {
  id: string;
  category: string;
  title: string;
  status: string;
  updatedAt: Date;
  submittedAt: Date | null;
  /** This reader's own unread comments on it (F11). */
  unread: number;
};

export type ProposalDetail = ProposalDetailContent & EventLinkView;

type ProposalDetailContent = ProposalListItem & {
  ccaID: number;
  ccaName: string | null;
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
  /** What this person, as a director of the CCA now, may do next. */
  reviewActions: ReviewAction[];
  history: Array<{
    id: string;
    fromStatus: string;
    toStatus: string;
    at: Date;
    byMe: boolean;
    selfApproved: boolean;
    /** The approver's display name; null if unknown or the account is gone. */
    approverName: string | null;
    note: string | null;
  }>;
};

export const hiddenFromDirector = (viewer: ProposalViewer, status: string) =>
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
  const { viewer, isDirector } = await proposalAccess(db, userID, row.ccaID, {
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
  const [names, cca, eventLink, unread] = await Promise.all([
    displayNames(
      db,
      history.flatMap((h) => (h.approverID ? [h.approverID] : [])),
    ),
    db.cCA.findFirst({
      where: { ccaID: row.ccaID },
      select: { ccaName: true },
    }),
    readEventLinkView(
      db,
      {
        willBeEvent: row.willBeEvent ?? null,
        status: row.status,
        eventID: row.eventID ?? null,
        eventClaimedAt: row.eventClaimedAt ?? null,
      },
      viewer === "head",
    ),
    unreadCounts(
      db,
      userID,
      [row.id],
      viewer === "head" ? new Set([row.id]) : undefined,
    ),
  ]);
  return {
    id: row.id,
    ccaID: row.ccaID,
    ccaName: cca?.ccaName ?? null,
    category: row.category,
    title: row.title,
    description: row.description,
    blastMessage: row.blastMessage,
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    posterUrl: row.posterUrl ?? null,
    docLink: row.docLink ?? null,
    ...eventLink,
    status: row.status,
    unread: unread.get(row.id) ?? 0,
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
    reviewActions: isDirector ? reviewActionsFor(row.status) : [],
    history: history.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      at: h.createdAt,
      byMe: h.actorID === userID,
      selfApproved: h.selfApproved,
      approverName: h.approverID ? (names.get(h.approverID) ?? null) : null,
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
  const rows = await db.proposal.findMany({
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
  const unread = await unreadCounts(
    db,
    userID,
    rows.map((r) => r.id),
    viewer === "head" ? new Set(rows.map((r) => r.id)) : undefined,
  );
  return {
    viewer,
    items: rows.map((r) => ({ ...r, unread: unread.get(r.id) ?? 0 })),
  };
}
