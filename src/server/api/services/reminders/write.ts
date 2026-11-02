import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { REMINDERS_HREF } from "~/lib/reminders/links";
import type { ReminderCreateInput } from "~/lib/schemas/reminder";
import { sgtDayKey } from "~/lib/time/sgt";
import { notify } from "~/server/api/services/notifications";
import {
  assertDirectsAll,
  directedOrRefuse,
  headedOrRefuse,
  headsOfOrRefuse,
  REMINDER_NOT_FOUND,
} from "./access";
import { assertWithinLimit } from "./limits";

export const REMINDER_DEADLINE_PAST = "REMINDER_DEADLINE_PAST";
export const REMINDER_CANCELLED = "REMINDER_CANCELLED";

/** "active" until a director cancels; this file is the only writer of it. */
export const BROADCAST_ACTIVE = "active";
export const BROADCAST_CANCELLED = "cancelled";

const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: REMINDER_NOT_FOUND });

export type SendResult = { id: string; targets: number; notified: number };

/**
 * Send a broadcast. The caller must direct EVERY chosen CCA (strict guard):
 * one that is not theirs refuses the whole send and nothing is written. The
 * CCA ids from the browser only name what to check; the sender is the caller.
 * Who is told is the CCAs' CURRENT heads (Q13), read inside the transaction,
 * and the broadcast, its targets and every inbox row commit together or not at
 * all (A45): one write for the targets, one for the notices, no queue. The
 * sender is not told about their own broadcast. The guard is read again inside
 * the transaction so a position that ended a moment ago cannot send.
 */
export async function sendBroadcast(
  db: PrismaClient,
  userID: string,
  input: ReminderCreateInput,
  now: Date = new Date(),
): Promise<SendResult> {
  await assertDirectsAll(db, userID, input.ccaIDs);
  await assertWithinLimit("send", userID);
  if (input.deadline < sgtDayKey(now)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: REMINDER_DEADLINE_PAST,
    });
  }
  return db.$transaction(async (tx) => {
    await assertDirectsAll(tx, userID, input.ccaIDs);
    const heads = (await headsOfOrRefuse(tx, input.ccaIDs)).filter(
      (id) => id !== userID,
    );
    const broadcast = await tx.reminderBroadcast.create({
      data: {
        createdBy: userID,
        title: input.title,
        message: input.message,
        deadline: input.deadline,
        cancelledAt: null,
        cancelledBy: null,
      },
      select: { id: true },
    });
    await tx.reminderTarget.createMany({
      data: input.ccaIDs.map((ccaID) => ({
        broadcastID: broadcast.id,
        ccaID,
        doneAt: null,
        doneBy: null,
      })),
    });
    const sent = await notify(tx, {
      recipients: heads,
      kind: "reminder.broadcast",
      title: `Due ${input.deadline}: ${input.title}`.slice(0, 200),
      ...(input.message !== "" && { body: input.message }),
      href: REMINDERS_HREF,
    });
    return {
      id: broadcast.id,
      targets: input.ccaIDs.length,
      notified: sent.written,
    };
  });
}

/**
 * Cancel a broadcast: a soft cancel that stops its nudges and takes it off the
 * heads' list. Allowed to a current director of EVERY CCA it addresses, by the
 * strict guard, and to nobody else: the sender gets no standing through having
 * sent it, so one who has lost the position is refused. A missing broadcast and
 * one you may not touch give the same NOT_FOUND, and the guard is read first, so
 * a failed read refuses the same way for both. Cancelling twice is harmless.
 */
export async function cancelBroadcast(
  db: PrismaClient,
  userID: string,
  id: string,
  now: Date = new Date(),
): Promise<{ status: "cancelled"; changed: boolean }> {
  const directed = new Set(await directedOrRefuse(db, userID));
  const targets = await db.reminderTarget.findMany({
    where: { broadcastID: id },
    select: { ccaID: true },
  });
  const exists =
    targets.length > 0
      ? await db.reminderBroadcast.findUnique({
          where: { id },
          select: { id: true },
        })
      : null;
  if (!exists || !targets.every((t) => directed.has(t.ccaID))) {
    throw notFound();
  }
  await assertWithinLimit("cancel", userID);
  const res = await db.reminderBroadcast.updateMany({
    where: { id, status: BROADCAST_ACTIVE },
    data: {
      status: BROADCAST_CANCELLED,
      cancelledAt: now,
      cancelledBy: userID,
    },
  });
  return { status: "cancelled", changed: res.count === 1 };
}

/**
 * A head marks their OWN CCA's part done. A head of another CCA, a director who
 * is not also a head, and a missing row all get the same NOT_FOUND, so the
 * answer never says whether the broadcast exists. The first mark wins (a
 * compare-and-set on `doneAt` being null); a second is a harmless no-op.
 */
export async function markDone(
  db: PrismaClient,
  userID: string,
  input: { broadcastID: string; ccaID: number },
  now: Date = new Date(),
): Promise<{ alreadyDone: boolean }> {
  const headed = await headedOrRefuse(db, userID);
  const target = headed.includes(input.ccaID)
    ? await db.reminderTarget.findUnique({
        where: {
          broadcastID_ccaID: {
            broadcastID: input.broadcastID,
            ccaID: input.ccaID,
          },
        },
        select: { id: true },
      })
    : null;
  if (!target) throw notFound();
  await assertWithinLimit("markDone", userID);
  const broadcast = await db.reminderBroadcast.findUnique({
    where: { id: input.broadcastID },
    select: { status: true },
  });
  if (!broadcast) throw notFound();
  if (broadcast.status !== BROADCAST_ACTIVE) {
    throw new TRPCError({ code: "CONFLICT", message: REMINDER_CANCELLED });
  }
  const res = await db.reminderTarget.updateMany({
    where: {
      broadcastID: input.broadcastID,
      ccaID: input.ccaID,
      doneAt: null,
    },
    data: { doneAt: now, doneBy: userID },
  });
  return { alreadyDone: res.count === 0 };
}
