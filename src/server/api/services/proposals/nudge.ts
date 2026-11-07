import { Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { directorProposalHref } from "~/lib/proposals/links";
import { sgtDayKey } from "~/lib/time/sgt";
import {
  NOTIFICATIONS_DISABLED,
  notify,
} from "~/server/api/services/notifications";
import { assertCcaHead, directorsOrRefuse } from "./access";
import { PROPOSAL_NOT_FOUND } from "./drafts";
import { assertWithinLimit } from "./limits";

/**
 * A head's nudge to the CCA's directors about a submitted proposal (F21).
 *
 * A nudge is an inbox notice, not a new kind of record: `notify` writes one
 * `Notification` row per director, and its `once` scope gives each row a
 * notice key (proposal, person, Singapore day) that a partial unique index
 * holds to one. A repeat the same day is told it was already sent, and writes
 * nothing.
 *
 * WHO MAY NUDGE: a head of the proposal's CCA now, by the strict read, with the
 * CCA taken from the STORED proposal. Anyone else, directors included, gets
 * the same NOT_FOUND a missing id gets.
 *
 * WHO IS NUDGED is worked out when the nudge is pressed, from the strict
 * director guard on the transaction client: the CCA's current directors, minus
 * the head if they are one. A director who left yesterday is not nudged and
 * one who joined this morning is. A failed read refuses the nudge and writes
 * nothing.
 *
 * Only a proposal that is `in_review` can be nudged (CONFLICT otherwise): that
 * is the status where a director has something to do. If the CCA has no
 * director to tell, the result says so ("no_director") instead of pretending
 * it went. The result never carries a person id.
 *
 * Nothing here assumes a proposal in a shared list or count: the nudge notice
 * stands alone, so a nudge about a disposable request (PR 13 and 14) can use
 * the same `once` mechanism with no proposal at all.
 */

export const PROPOSAL_NOT_IN_REVIEW = "PROPOSAL_NOT_IN_REVIEW";

export type NudgeResult =
  | { status: "sent"; sent: number; alreadySent: number }
  | { status: "already_sent"; sent: 0; alreadySent: number }
  | { status: "no_director"; sent: 0; alreadySent: 0 };

const nudgeScope = (proposalID: string, now: Date) =>
  `proposal.nudge:${proposalID}:${sgtDayKey(now)}`;

export const NUDGE_TRY_AGAIN = "NUDGE_TRY_AGAIN";

const prismaCode = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null;

export async function nudgeDirectors(
  db: PrismaClient,
  userID: string,
  proposalID: string,
): Promise<NudgeResult> {
  const row = await db.proposal.findUnique({
    where: { id: proposalID },
    select: { id: true, ccaID: true, status: true },
  });
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: PROPOSAL_NOT_FOUND });
  }
  await assertCcaHead(db, userID, row.ccaID, { hideExistence: true });
  await assertWithinLimit("nudge", userID);
  if (row.status !== "in_review") {
    throw new TRPCError({ code: "CONFLICT", message: PROPOSAL_NOT_IN_REVIEW });
  }

  const scope = nudgeScope(row.id, new Date());
  const attempt = () =>
    db.$transaction(async (tx) => {
      // Re-read inside the transaction: the status may have moved since.
      const current = await tx.proposal.findUnique({
        where: { id: row.id },
        select: { ccaID: true, status: true, title: true },
      });
      if (!current) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: PROPOSAL_NOT_FOUND,
        });
      }
      if (current.status !== "in_review") {
        throw new TRPCError({
          code: "CONFLICT",
          message: PROPOSAL_NOT_IN_REVIEW,
        });
      }
      const directors = (await directorsOrRefuse(tx, current.ccaID)).filter(
        (id) => id !== userID,
      );
      if (directors.length === 0) {
        return { status: "no_director", sent: 0, alreadySent: 0 } as const;
      }
      const result = await notify(tx, {
        recipients: directors,
        kind: "proposal.nudge",
        title: "A head asked you to look at a proposal",
        body: current.title,
        href: directorProposalHref(row.id),
        once: scope,
      });
      if (result.alreadySent === undefined) {
        // notify writes nothing while notifications.enabled is off, and says
        // nothing about it: a nudge that reached nobody must not look sent.
        throw new TRPCError({
          code: "FORBIDDEN",
          message: NOTIFICATIONS_DISABLED,
        });
      }
      return result.written > 0
        ? ({
            status: "sent",
            sent: result.written,
            alreadySent: result.alreadySent,
          } as const)
        : ({
            status: "already_sent",
            sent: 0,
            alreadySent: result.alreadySent,
          } as const);
    });

  // Two nudges at once, or a write conflict: try once more. The second pass
  // reads the keys the first left, so it sends to whoever is still missing.
  try {
    return await attempt();
  } catch (first) {
    const code = prismaCode(first);
    if (code !== "P2002" && code !== "P2034") throw first;
  }
  try {
    return await attempt();
  } catch (err) {
    const code = prismaCode(err);
    if (code === "P2002") {
      // The unique key itself says these were sent.
      const taken = await db.notification.count({
        where: { noticeKey: { startsWith: `${scope}|` } },
      });
      if (taken > 0) {
        return { status: "already_sent", sent: 0, alreadySent: taken };
      }
    }
    if (code === "P2002" || code === "P2034") {
      // Never read a conflict as "already sent": ask the head to press again.
      throw new TRPCError({ code: "CONFLICT", message: NUDGE_TRY_AGAIN });
    }
    throw err;
  }
}
