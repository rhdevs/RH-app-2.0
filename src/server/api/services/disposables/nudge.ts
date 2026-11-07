import { Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { DISPOSABLES_HREF } from "~/lib/disposables/links";
import { sgtDayKey } from "~/lib/time/sgt";
import { currentSocialDirectorIDs } from "~/server/api/services/directorGuard";
import {
  NOTIFICATIONS_DISABLED,
  notify,
} from "~/server/api/services/notifications";
import { DISPOSABLE_NOT_FOUND, loadViewer } from "./access";
import { assertWithinLimit } from "./limits";

/**
 * A head's nudge to the Social director about a disposable request (F21, B59):
 * the same inbox-notice mechanism as the proposal nudge. `notify`'s `once`
 * scope `request.nudge:<request>:<Singapore day>` gives each row a notice key,
 * so a second press the same day, from any tab, writes nothing.
 *
 * WHO MAY NUDGE: a head of the request's CCA now, by the strict read, with the
 * CCA taken from the STORED request; for a request with no CCA (a hall-wide
 * event) the person who filed it. Anyone else, the Social director and every
 * other JCRC member included, gets the same NOT_FOUND a missing id gets. Only a
 * PENDING request can be nudged: that is the state where the director has
 * something to do.
 *
 * WHO IS NUDGED is worked out when the nudge is pressed, from the strict guard
 * on the transaction client. If nobody can currently decide, the result says so
 * ("no_director") rather than pretending it went. The result never carries a
 * person id.
 */

export const DISPOSABLE_NOT_PENDING = "DISPOSABLE_NOT_PENDING";
export const DISPOSABLE_NUDGE_TRY_AGAIN = "DISPOSABLE_NUDGE_TRY_AGAIN";

export type DisposableNudgeResult =
  | { status: "sent"; sent: number; alreadySent: number }
  | { status: "already_sent"; sent: 0; alreadySent: number }
  | { status: "no_director"; sent: 0; alreadySent: 0 };

const nudgeScope = (id: string, now: Date) =>
  `request.nudge:${id}:${sgtDayKey(now)}`;

const prismaCode = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null;

const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: DISPOSABLE_NOT_FOUND });

export async function nudgeSocialDirector(
  db: PrismaClient,
  userID: string,
  requestID: string,
  now: Date = new Date(),
): Promise<DisposableNudgeResult> {
  const viewer = await loadViewer(db, userID);
  const row = await db.disposableRequest.findUnique({
    where: { id: requestID },
    select: { ccaID: true, createdBy: true, status: true },
  });
  const mayNudge =
    row !== null &&
    (row.ccaID === null
      ? row.createdBy === userID
      : viewer.headedCcaIDs.includes(row.ccaID));
  if (!row || !mayNudge) throw notFound();
  await assertWithinLimit("nudge", userID);
  if (row.status !== "pending") {
    throw new TRPCError({ code: "CONFLICT", message: DISPOSABLE_NOT_PENDING });
  }

  const scope = nudgeScope(requestID, now);
  const attempt = () =>
    db.$transaction(async (tx) => {
      // Re-read inside the transaction: the request may have been decided.
      const current = await tx.disposableRequest.findUnique({
        where: { id: requestID },
        select: { status: true, title: true },
      });
      if (!current) throw notFound();
      if (current.status !== "pending") {
        throw new TRPCError({
          code: "CONFLICT",
          message: DISPOSABLE_NOT_PENDING,
        });
      }
      const directors = (await currentSocialDirectorIDs(tx, now)).filter(
        (id) => id !== userID,
      );
      if (directors.length === 0) {
        return { status: "no_director", sent: 0, alreadySent: 0 } as const;
      }
      const result = await notify(tx, {
        recipients: directors,
        kind: "disposable.nudge",
        title: "A head asked you to look at a disposables request",
        body: current.title.slice(0, 1000),
        href: DISPOSABLES_HREF,
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
      const taken = await db.notification.count({
        where: { noticeKey: { startsWith: `${scope}|` } },
      });
      if (taken > 0) {
        return { status: "already_sent", sent: 0, alreadySent: taken };
      }
    }
    if (code === "P2002" || code === "P2034") {
      // Never read a conflict as "already sent": ask the head to press again.
      throw new TRPCError({
        code: "CONFLICT",
        message: DISPOSABLE_NUDGE_TRY_AGAIN,
      });
    }
    throw err;
  }
}
