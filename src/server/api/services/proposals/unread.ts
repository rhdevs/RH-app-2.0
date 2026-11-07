import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Each person's OWN unread count for a set of proposals, in two queries
 * however many proposals there are (never one per row):
 *  1. the caller's read markers for those proposals;
 *  2. one grouped count of comments by other people newer than the caller's
 *     marker for that proposal (all of a thread when there is no marker).
 *
 * A comment is unread for a person when someone else wrote it and it is newer
 * than their marker. Their own comments never count for them. A comment whose
 * author was deleted (authorID cleared, B16) counts as someone else's.
 *
 * A comment written while the proposal was a draft (`headsOnly`) is counted
 * only for a reader who is a head there: `headsOnlyVisible` is the set of
 * proposal ids where the caller is (also) a head. For any other proposal such
 * comments are left out of the count.
 *
 * A pure read: it writes nothing (marking read is its own mutation,
 * `markRead` in comments.ts). Callers have already decided the caller may read
 * every proposal id they pass, so a count never reveals a thread to someone
 * who cannot open it.
 */

type UnreadDb = Pick<PrismaClient, "proposalComment" | "proposalCommentRead">;

/**
 * Comments a director may see: not heads-only. On MongoDB Prisma treats a
 * field that is absent (a row from before the field), null and false as three
 * different things, and `not: true` matches none of them.
 */
export const NOT_HEADS_ONLY: Prisma.ProposalCommentWhereInput = {
  OR: [
    { headsOnly: { isSet: false } },
    { headsOnly: null },
    { headsOnly: false },
  ],
};

/** More than a page of proposals is never asked for at once. */
export const UNREAD_MAX_PROPOSALS = 200;

export async function unreadCounts(
  db: UnreadDb,
  userID: string,
  proposalIDs: readonly string[],
  headsOnlyVisible: ReadonlySet<string> = new Set(),
): Promise<Map<string, number>> {
  const ids = [...new Set(proposalIDs)].slice(0, UNREAD_MAX_PROPOSALS);
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;

  const markers = await db.proposalCommentRead.findMany({
    where: { userID, proposalID: { in: ids } },
    select: { proposalID: true, readAt: true },
  });
  const readAt = new Map(markers.map((m) => [m.proposalID, m.readAt]));

  const groups = await db.proposalComment.groupBy({
    by: ["proposalID"],
    where: {
      OR: ids.map((id) => {
        const since = readAt.get(id);
        return {
          proposalID: id,
          ...(since !== undefined && { createdAt: { gt: since } }),
          ...(!headsOnlyVisible.has(id) && NOT_HEADS_ONLY),
        };
      }),
      authorID: { not: userID },
    },
    _count: { _all: true },
  });
  for (const g of groups) counts.set(g.proposalID, g._count._all);
  return counts;
}
