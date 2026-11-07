import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { PROPOSAL_STATUSES, type ProposalStatus } from "~/lib/proposals/status";
import { QUEUE_CURSOR } from "~/lib/schemas/proposal";
import { NOT_DIRECTOR } from "~/server/api/services/directorGuard";
import { directedCcasOrRefuse } from "./access";
import { isProposalsEnabled } from "./flag";
import { displayNames } from "./names";
import { unreadCounts } from "./unread";

/**
 * The director's home (F29): counts by status and a review queue, for the CCAs
 * this person directs NOW and no others, plus those CCAs and who heads them
 * (F03).
 *
 * The caller's CCAs come from ONE strict guard call (`directedCcaIDs`, whose
 * query already holds only the caller's own flagged positions). Every list
 * below is then a single query filtered to that set; nothing runs a director
 * check per proposal or per CCA. A guard read that throws refuses and logs the
 * error name; it is never an empty list that could pass for "nothing to
 * review". An admin, an RF, a Hall Office member, a JCRC member without a
 * flagged position and a holder of an unflagged one direct no CCA, so they are
 * refused (NOT_DIRECTOR) and see none of it, unless they are also directors.
 *
 * Drafts never appear (B19). Disposable requests are PR 13's.
 */

/** Rows per page of the queue. Oldest submission first, so nothing waits unseen. */
export const QUEUE_PAGE = 50;

export type CountedStatus = Exclude<ProposalStatus, "draft">;
export const COUNTED_STATUSES = PROPOSAL_STATUSES.filter(
  (s): s is CountedStatus => s !== "draft",
);

export type DirectorHome = {
  /** The CCAs this person vets, by name, with their heads' names. */
  ccas: Array<{ ccaID: number; name: string | null; heads: string[] }>;
  counts: Record<CountedStatus, number>;
};

export type QueueItem = {
  id: string;
  ccaID: number;
  ccaName: string | null;
  category: string;
  title: string;
  submittedAt: Date | null;
  /** This director's own unread comments on it (F11). */
  unread: number;
};

export type DirectorQueue = {
  items: QueueItem[];
  /**
   * Where the next page starts: the position (submission time, id) of this
   * page's last row, or null at the end. A position, not a row to find again,
   * so approving or returning that row before "Show more" loses nothing.
   */
  nextCursor: string | null;
};

const BAD_CURSOR = "BAD_QUEUE_CURSOR";

/** The filter for every row after a cursor, in (submittedAt, id) order. */
function afterCursor(cursor: string): Prisma.ProposalWhereInput {
  const match = QUEUE_CURSOR.exec(cursor);
  if (!match) {
    throw new TRPCError({ code: "BAD_REQUEST", message: BAD_CURSOR });
  }
  const [, at, id] = match as unknown as [string, string, string];
  if (at === "none") {
    // Rows without a submission time sort first, so everything with one follows.
    return {
      OR: [
        { submittedAt: null, id: { gt: id } },
        { submittedAt: { not: null } },
      ],
    };
  }
  const time = new Date(Number(at));
  if (Number.isNaN(time.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: BAD_CURSOR });
  }
  return {
    OR: [{ submittedAt: { gt: time } }, { submittedAt: time, id: { gt: id } }],
  };
}

function cursorOf(row: { id: string; submittedAt: Date | null }): string {
  return `${row.submittedAt ? row.submittedAt.getTime() : "none"}_${row.id}`;
}

/** The caller's CCAs, or a refusal: nobody who directs none gets past here. */
async function mustDirectSome(
  db: PrismaClient,
  userID: string,
): Promise<number[]> {
  const ccaIDs = await directedCcasOrRefuse(db, userID);
  if (ccaIDs.length === 0) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_DIRECTOR });
  }
  return ccaIDs;
}

export async function getDirectorHome(
  db: PrismaClient,
  userID: string,
): Promise<DirectorHome> {
  const ccaIDs = await mustDirectSome(db, userID);
  const [ccaRows, headRows, groups] = await Promise.all([
    db.cCA.findMany({
      where: { ccaID: { in: ccaIDs } },
      select: { ccaID: true, ccaName: true },
    }),
    db.ccaHead.findMany({
      where: { ccaID: { in: ccaIDs } },
      select: { ccaID: true, userID: true },
    }),
    db.proposal.groupBy({
      by: ["status"],
      where: { ccaID: { in: ccaIDs }, status: { not: "draft" } },
      _count: { _all: true },
    }),
  ]);
  const names = await displayNames(
    db,
    headRows.map((h) => h.userID),
  );

  const counts = Object.fromEntries(
    COUNTED_STATUSES.map((s) => [s, 0]),
  ) as Record<CountedStatus, number>;
  for (const g of groups) {
    if ((COUNTED_STATUSES as readonly string[]).includes(g.status)) {
      counts[g.status as CountedStatus] = g._count._all;
    }
  }

  return {
    ccas: ccaIDs.map((ccaID) => ({
      ccaID,
      name: ccaRows.find((c) => c.ccaID === ccaID)?.ccaName ?? null,
      heads: headRows
        .filter((h) => h.ccaID === ccaID)
        .map((h) => names.get(h.userID) ?? "A head with no name on file")
        .sort((a, b) => a.localeCompare(b)),
    })),
    counts,
  };
}

export async function getDirectorQueue(
  db: PrismaClient,
  userID: string,
  cursor?: string,
): Promise<DirectorQueue> {
  const ccaIDs = await mustDirectSome(db, userID);
  const [rows, ccaRows] = await Promise.all([
    db.proposal.findMany({
      where: {
        ccaID: { in: ccaIDs },
        status: "in_review",
        ...(cursor !== undefined && afterCursor(cursor)),
      },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: QUEUE_PAGE + 1,
      select: {
        id: true,
        ccaID: true,
        category: true,
        title: true,
        submittedAt: true,
      },
    }),
    db.cCA.findMany({
      where: { ccaID: { in: ccaIDs } },
      select: { ccaID: true, ccaName: true },
    }),
  ]);
  const page = rows.slice(0, QUEUE_PAGE);
  // A director who also heads a CCA counts as its head: draft-stage comments
  // there stay in their count. Strict read, no catch.
  const headed = new Set(
    (
      await db.ccaHead.findMany({
        where: { userID, ccaID: { in: ccaIDs } },
        select: { ccaID: true },
      })
    ).map((h) => h.ccaID),
  );
  const unread = await unreadCounts(
    db,
    userID,
    page.map((r) => r.id),
    new Set(page.filter((r) => headed.has(r.ccaID)).map((r) => r.id)),
  );
  return {
    items: page.map((r) => ({
      ...r,
      ccaName: ccaRows.find((c) => c.ccaID === r.ccaID)?.ccaName ?? null,
      unread: unread.get(r.id) ?? 0,
    })),
    nextCursor:
      rows.length > QUEUE_PAGE && page.length > 0
        ? cursorOf(page[page.length - 1]!)
        : null,
  };
}

/**
 * Whether to draw the navigation entry: both switches on and the caller
 * directs at least one CCA, by the strict guard. Off or not a director is a
 * plain `false`. A guard read that throws is NOT false: it refuses, so the
 * entry is hidden by an error the screen can tell from "not a director".
 */
export async function getDirectorEntry(
  db: PrismaClient,
  userID: string,
): Promise<{ show: boolean }> {
  if (!(await isProposalsEnabled(db))) return { show: false };
  const ccaIDs = await directedCcasOrRefuse(db, userID);
  return { show: ccaIDs.length > 0 };
}
