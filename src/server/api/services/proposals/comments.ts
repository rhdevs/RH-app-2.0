import { Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { directorProposalHref, headProposalHref } from "~/lib/proposals/links";
import { notify } from "~/server/api/services/notifications";
import {
  assertProposalReader,
  directorsOrRefuse,
  type ProposalViewer,
} from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";
import { assertWithinLimit } from "./limits";
import { displayNames } from "./names";
import { hiddenFromDirector } from "./read";
import { NOT_HEADS_ONLY, unreadCounts } from "./unread";

/**
 * The comment thread of a proposal (F11).
 *
 * WHO MAY USE IT is the same as who may read the proposal NOW, decided from
 * the stored rows on every call (B19 included):
 *  1. load the proposal by the id the browser sent and take its CCA from the
 *     STORED row, never from the request;
 *  2. `assertProposalReader` with `hideExistence`: a head of that CCA, or a
 *     current director of it. Anyone else (another CCA's head or director, an
 *     admin, a JCRC member, a former head) gets the same NOT_FOUND a missing
 *     id gets;
 *  3. a director gets the same NOT_FOUND for a DRAFT, whose thread is the
 *     heads' working space.
 * The rate limit is charged after those checks.
 *
 * There is no edit and no delete: the proposal asks for "a thread per
 * proposal; each person sees their own unread count" and nothing more.
 * A comment is plain text, shown as React text.
 *
 * Commenting is open in every status but `canceled` (nothing can reach it in
 * this release, so it is a guard only). Draft: heads talk to each other.
 * Cleared and finished stay open because the proposal says the head and the
 * director can note the RF reply in the thread (4.1).
 *
 * No person id leaves the server. An author is "me" or a display name, and
 * a comment whose author's account was deleted has no name: the screen says
 * "Former member".
 */

export const COMMENT_PAGE = 50;
export const COMMENTS_CLOSED = "COMMENTS_CLOSED";

export type CommentItem = {
  id: string;
  body: string;
  createdAt: Date;
  mine: boolean;
  /** Null when the account is gone or has no name on file. */
  authorName: string | null;
  /** Someone else's comment, newer than this reader's marker. */
  isNew: boolean;
  /** Written while the proposal was a draft: only heads see it. */
  headsOnly: boolean;
};

export type CommentPage = {
  /** Newest first. */
  items: CommentItem[];
  nextCursor: string | null;
  /** This reader's own unread count for the whole thread. */
  unread: number;
};

type ThreadRow = {
  viewer: ProposalViewer;
  id: string;
  ccaID: number;
  status: string;
  title: string;
};

async function openThread(
  db: PrismaClient,
  userID: string,
  proposalID: string,
): Promise<ThreadRow> {
  const row = await db.proposal.findUnique({
    where: { id: proposalID },
    select: { id: true, ccaID: true, status: true, title: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  const viewer = await assertProposalReader(db, userID, row.ccaID, {
    hideExistence: true,
  });
  if (hiddenFromDirector(viewer, row.status)) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  return { ...row, viewer };
}

/** A pure read: one page of the thread and the reader's unread count. */
export async function listComments(
  db: PrismaClient,
  userID: string,
  input: { proposalID: string; cursor?: string | undefined },
): Promise<CommentPage> {
  const row = await openThread(db, userID, input.proposalID);
  const [rows, marker, counts] = await Promise.all([
    db.proposalComment.findMany({
      where: {
        proposalID: row.id,
        // A comment from the draft stage is the heads' alone (a head who is
        // also a director is a head here).
        ...(row.viewer !== "head" && NOT_HEADS_ONLY),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COMMENT_PAGE + 1,
      ...(input.cursor !== undefined && { cursor: { id: input.cursor } }),
    }),
    db.proposalCommentRead.findUnique({
      where: { proposalID_userID: { proposalID: row.id, userID } },
      select: { readAt: true },
    }),
    unreadCounts(
      db,
      userID,
      [row.id],
      row.viewer === "head" ? new Set([row.id]) : undefined,
    ),
  ]);
  const page = rows.slice(0, COMMENT_PAGE);
  const names = await displayNames(
    db,
    page.flatMap((c) => (c.authorID ? [c.authorID] : [])),
  );
  return {
    items: page.map((c) => ({
      id: c.id,
      body: c.body,
      createdAt: c.createdAt,
      mine: c.authorID === userID,
      authorName: c.authorID ? (names.get(c.authorID) ?? null) : null,
      headsOnly: c.headsOnly === true,
      isNew:
        c.authorID !== userID &&
        (marker === null || c.createdAt.getTime() > marker.readAt.getTime()),
    })),
    nextCursor:
      rows.length > COMMENT_PAGE ? (rows[COMMENT_PAGE]?.id ?? null) : null,
    unread: counts.get(row.id) ?? 0,
  };
}

/**
 * Tell the CCA's OTHER readers, worked out now from CcaHead rows and the
 * strict director guard on the transaction client (never from the request),
 * so a head or director who changed a minute ago is told correctly. A read
 * that fails rolls the comment back with it.
 *
 * The comment is written here too, marked `headsOnly` while the proposal is a
 * draft. A draft's comment goes to heads only: directors cannot open a draft. Each
 * person gets one notice, with the link to the route they can open: the head
 * route for a head (including someone who is also a director), the director
 * route for a director who heads nothing. The body is the proposal's title,
 * not the comment.
 */
async function writeComment(
  tx: Prisma.TransactionClient,
  proposalID: string,
  authorID: string,
  body: string,
): Promise<{ id: string; createdAt: Date }> {
  const proposal = await tx.proposal.findUnique({
    where: { id: proposalID },
    select: { ccaID: true, status: true, title: true },
  });
  if (!proposal) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  // The privacy of the comment is decided HERE, from the status read inside
  // this transaction, never from the status read before it. A submit that
  // commits while this transaction runs is not seen by its snapshot, so the
  // comment stays heads-only: an overlap falls on the private side.
  const comment = await tx.proposalComment.create({
    data: {
      proposalID,
      authorID,
      body,
      headsOnly: proposal.status === "draft",
    },
    select: { id: true, createdAt: true },
  });
  const heads = (
    await tx.ccaHead.findMany({
      where: { ccaID: proposal.ccaID },
      select: { userID: true },
    })
  )
    .map((h) => h.userID)
    .filter((id) => id !== authorID);
  const headSet = new Set(heads);
  const directors =
    proposal.status === "draft"
      ? []
      : (await directorsOrRefuse(tx, proposal.ccaID)).filter(
          (id) => id !== authorID && !headSet.has(id),
        );
  const base = {
    kind: "proposal.comment",
    title: "New comment on a proposal",
    body: proposal.title,
  };
  await notify(tx, {
    ...base,
    recipients: heads,
    href: headProposalHref(proposal.ccaID, proposalID),
  });
  await notify(tx, {
    ...base,
    recipients: directors,
    href: directorProposalHref(proposalID),
  });
  return comment;
}

export async function addComment(
  db: PrismaClient,
  userID: string,
  input: { proposalID: string; body: string },
): Promise<{ id: string; createdAt: Date }> {
  const row = await openThread(db, userID, input.proposalID);
  await assertWithinLimit("comment", userID);
  if (row.status === "canceled") {
    throw new TRPCError({ code: "CONFLICT", message: COMMENTS_CLOSED });
  }
  // The comment and its notices commit together or not at all.
  return db.$transaction((tx) => writeComment(tx, row.id, userID, input.body));
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Move this reader's marker forward to `upTo` (default now), never past now
 * and never backward. Safe against two tabs at once and against a first read
 * racing itself: the update only matches a marker that is older, a missing
 * marker is created, and the unique index on (proposalID, userID) makes the
 * second creator fail; that one then updates instead.
 */
export async function markCommentsRead(
  db: PrismaClient,
  userID: string,
  input: { proposalID: string; upTo?: Date | undefined },
): Promise<{ readAt: Date }> {
  const row = await openThread(db, userID, input.proposalID);
  await assertWithinLimit("commentRead", userID);
  const now = new Date();
  const at =
    input.upTo !== undefined && input.upTo.getTime() < now.getTime()
      ? input.upTo
      : now;
  const where = { proposalID: row.id, userID };
  const advance = () =>
    db.proposalCommentRead.updateMany({
      where: { ...where, readAt: { lt: at } },
      data: { readAt: at },
    });

  if ((await advance()).count === 0) {
    const have = await db.proposalCommentRead.findUnique({
      where: { proposalID_userID: where },
      select: { readAt: true },
    });
    if (have) return { readAt: have.readAt };
    try {
      await db.proposalCommentRead.create({ data: { ...where, readAt: at } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Another tab created it first; move that marker if ours is newer.
      await advance();
    }
  }
  const stored = await db.proposalCommentRead.findUnique({
    where: { proposalID_userID: where },
    select: { readAt: true },
  });
  return { readAt: stored?.readAt ?? at };
}
