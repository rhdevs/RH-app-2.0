import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";

import { eventStateOf } from "~/lib/disposables/events";
import { shortMessage } from "~/lib/equipment/stock";
import type {
  loanApproveInput,
  loanDirectorCancelInput,
  loanRejectInput,
  loanReturnInput,
} from "~/lib/schemas/equipment";
import type { EvidenceStorage } from "~/server/api/services/milestoneBlob";
import {
  assertDirector,
  directorOrLeader,
  NOT_EVENT_LEADER,
  type EquipmentAccessDb,
} from "./access";
import { assertWithinLimit } from "./limits";
import { noticeDecision, noticeReturned } from "./notices";
import { checkReturnPhoto } from "./photo";
import { loadLoan } from "./read";
import { stockProblems } from "./stock";
import { moveLoan, type LoanRow } from "./transition";
import { EQUIPMENT_BAD_ITEM, EQUIPMENT_ITEM_RETIRED } from "./write";

/**
 * The moves after filing: approve, reject, cancel, collect, return. Who may
 * make each is checked here, from stored rows (the strict guard for the Social
 * director; disposables' `mayFile` rule, on the CCA stored on the loan, for the
 * event leaders), BEFORE the budget is spent and before the loan is moved. The
 * move itself, and the only write of `status`, is transition.ts.
 *
 * Notices are sent after the move has committed, best effort (notices.ts).
 */

export const EQUIPMENT_BAD_WINDOW = "EQUIPMENT_BAD_WINDOW";
export const EQUIPMENT_EVENT_CLOSED = "EQUIPMENT_EVENT_CLOSED";

type DecideDb = EquipmentAccessDb & PrismaClient;

const bad = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

/** The title of the event for a notice. */
async function titleOf(
  db: Pick<PrismaClient, "event">,
  eventID: number,
): Promise<string | null> {
  const event = await db.event.findUnique({
    where: { eventID },
    select: { title: true },
  });
  return (event?.title?.trim() ?? "") || null;
}

/**
 * Run INSIDE the approval transaction. Refuses a bad window, an event that is
 * no longer happening, a missing or retired item, and a shortage at any instant
 * of the window (naming the item and the loans holding it); then writes every
 * item the loan names (version + 1) so a concurrent approval that shares an
 * item conflicts with this one instead of passing the same check.
 */
async function approvalGuard(
  tx: Prisma.TransactionClient,
  loan: LoanRow,
): Promise<void> {
  if (
    !Number.isInteger(loan.collectAt) ||
    !Number.isInteger(loan.returnAt) ||
    loan.returnAt <= loan.collectAt
  ) {
    throw bad(EQUIPMENT_BAD_WINDOW);
  }
  const event = await tx.event.findUnique({
    where: { eventID: loan.eventID },
    select: { status: true },
  });
  if (eventStateOf(event) !== "ok") throw bad(EQUIPMENT_EVENT_CLOSED);

  const ids = loan.lines.map((l) => l.itemID);
  const rows = await tx.equipmentItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, quantity: true, retired: true },
  });
  const items = new Map(rows.map((r) => [r.id, r]));
  for (const line of loan.lines) {
    const item = items.get(line.itemID);
    if (!item) throw bad(EQUIPMENT_BAD_ITEM);
    if (item.retired) throw bad(EQUIPMENT_ITEM_RETIRED);
  }
  const problems = await stockProblems(tx, {
    excludeLoanID: loan.id,
    lines: loan.lines,
    window: { collectAt: loan.collectAt, returnAt: loan.returnAt },
    items,
  });
  if (problems[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: shortMessage(problems[0]),
    });
  }
  const bumped = await tx.equipmentItem.updateMany({
    where: { id: { in: ids } },
    data: { version: { increment: 1 } },
  });
  if (bumped.count !== ids.length) throw bad(EQUIPMENT_BAD_ITEM);
}

export async function approveLoan(
  db: DecideDb,
  userID: string,
  input: z.infer<typeof loanApproveInput>,
): Promise<{ id: string }> {
  await assertDirector(db, userID);
  await assertWithinLimit("approve", userID);
  const loan = await loadLoan(db, input.id);
  const moved = await moveLoan(
    db,
    {
      id: input.id,
      expectedVersion: input.version,
      expectedCcaID: loan.ccaID,
      from: "requested",
      to: "approved",
      actorID: userID,
      decision: { reason: null, directorNote: input.directorNote },
    },
    { guard: approvalGuard, retryConflicts: true },
  );
  await noticeDecision(
    db,
    "approved",
    moved,
    await titleOf(db, moved.eventID),
    userID,
    input.directorNote,
  );
  return { id: moved.id };
}

export async function rejectLoan(
  db: DecideDb,
  userID: string,
  input: z.infer<typeof loanRejectInput>,
): Promise<{ id: string }> {
  await assertDirector(db, userID);
  await assertWithinLimit("reject", userID);
  const loan = await loadLoan(db, input.id);
  const moved = await moveLoan(db, {
    id: input.id,
    expectedVersion: input.version,
    expectedCcaID: loan.ccaID,
    from: "requested",
    to: "rejected",
    actorID: userID,
    decision: { reason: input.reason },
  });
  await noticeDecision(
    db,
    "rejected",
    moved,
    await titleOf(db, moved.eventID),
    userID,
    input.reason,
  );
  return { id: moved.id };
}

/** Leaders of the loan CCA or the Social director, or a refusal. */
async function assertMayAct(
  db: DecideDb,
  userID: string,
  ccaID: number | null,
): Promise<{ director: boolean }> {
  const who = await directorOrLeader(db, userID, ccaID);
  if (!who.director && !who.leader) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOT_EVENT_LEADER });
  }
  return { director: who.director };
}

/**
 * Cancel before collection: the event leaders or the Social director. When the
 * director cancels, the decision is recorded and the requester is told.
 */
export async function cancelLoan(
  db: DecideDb,
  userID: string,
  input: z.infer<typeof loanDirectorCancelInput>,
): Promise<{ id: string }> {
  const loan = await loadLoan(db, input.id);
  const { director } = await assertMayAct(db, userID, loan.ccaID);
  await assertWithinLimit("cancel", userID);
  const moved = await moveLoan(db, {
    id: input.id,
    expectedVersion: input.version,
    expectedCcaID: loan.ccaID,
    from: loan.status,
    to: "canceled",
    actorID: userID,
    ...(director && { decision: { reason: input.reason } }),
  });
  if (director) {
    await noticeDecision(
      db,
      "canceled",
      moved,
      await titleOf(db, moved.eventID),
      userID,
      input.reason,
    );
  }
  return { id: moved.id };
}

export async function collectLoan(
  db: DecideDb,
  userID: string,
  input: { id: string; version: number },
): Promise<{ id: string }> {
  const loan = await loadLoan(db, input.id);
  await assertMayAct(db, userID, loan.ccaID);
  await assertWithinLimit("collect", userID);
  const moved = await moveLoan(db, {
    id: input.id,
    expectedVersion: input.version,
    expectedCcaID: loan.ccaID,
    from: "approved",
    to: "collected",
    actorID: userID,
  });
  return { id: moved.id };
}

/**
 * Mark returned, with or without a photo. A photo is checked against the
 * store first; if the move then fails, the file is removed unless the loan
 * ended up holding it.
 */
export async function returnLoan(
  db: DecideDb,
  storage: Pick<EvidenceStorage, "host" | "head" | "remove">,
  userID: string,
  input: z.infer<typeof loanReturnInput>,
): Promise<{ id: string }> {
  const loan = await loadLoan(db, input.id);
  await assertMayAct(db, userID, loan.ccaID);
  await assertWithinLimit("return", userID);
  const photo =
    input.url === null
      ? null
      : await checkReturnPhoto(storage, loan.id, input.url);
  let moved: LoanRow;
  try {
    moved = await moveLoan(db, {
      id: input.id,
      expectedVersion: input.version,
      expectedCcaID: loan.ccaID,
      from: "collected",
      to: "returned",
      actorID: userID,
      photo,
    });
  } catch (err) {
    if (photo !== null)
      await dropUnusedPhoto(db, storage, loan.id, photo.pathname);
    throw err;
  }
  await noticeReturned(
    db,
    moved,
    await titleOf(db, moved.eventID),
    userID,
    photo !== null,
  );
  return { id: moved.id };
}

/** Remove a checked photo the move did not use, unless the loan holds it. */
async function dropUnusedPhoto(
  db: Pick<PrismaClient, "equipmentLoan">,
  storage: Pick<EvidenceStorage, "remove">,
  loanID: string,
  pathname: string,
): Promise<void> {
  const row = await db.equipmentLoan.findUnique({
    where: { id: loanID },
    select: { returnPhoto: true },
  });
  if (row?.returnPhoto !== pathname) await storage.remove(pathname);
}
