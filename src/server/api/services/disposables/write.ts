import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { isDisposableStatus } from "~/lib/disposables/status";
import { sgtDayKey } from "~/lib/time/sgt";
import {
  isPastDay,
  type DisposableCreateInput,
  type DisposableDecideInput,
  type DisposableUpdateInput,
} from "~/lib/schemas/disposable";
import { assertSocialDirector } from "~/server/api/services/directorGuard";
import { assertCcaHead, DISPOSABLE_NOT_FOUND } from "./access";
import { assertWithinLimit } from "./limits";
import {
  noticeDecision,
  noticeDeleted,
  noticeEditedBySocialDirector,
  noticeFiled,
} from "./notices";
import {
  changeRequest,
  DISPOSABLE_CONFLICT,
  removeRequest,
} from "./transition";

export const DISPOSABLE_DATE_PAST = "DISPOSABLE_DATE_PAST";
export const DISPOSABLE_BAD_PROPOSAL = "DISPOSABLE_BAD_PROPOSAL";
export const DISPOSABLE_PROPOSAL_TAKEN = "DISPOSABLE_PROPOSAL_TAKEN";

const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: DISPOSABLE_NOT_FOUND });

/**
 * The collection day must not be before today in Singapore (4.9). Day level:
 * a collection later today is allowed. `now` is a seam for tests.
 */
function assertNotPast(collectionDay: string, now: Date): void {
  if (isPastDay(collectionDay, sgtDayKey(now))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: DISPOSABLE_DATE_PAST });
  }
}

/**
 * A link must name a proposal of THIS CCA (a missing id and another CCA's are
 * the same answer), and one proposal has at most one request. The partial
 * unique index is the backstop for two writers at once.
 */
async function assertProposalLinkable(
  db: PrismaClient,
  ccaID: number,
  proposalID: string | null,
  exceptRequestID?: string,
): Promise<void> {
  if (proposalID === null) return;
  const proposal = await db.proposal.findFirst({
    where: { id: proposalID, ccaID },
    select: { id: true },
  });
  if (!proposal) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: DISPOSABLE_BAD_PROPOSAL,
    });
  }
  const taken = await db.disposableRequest.findFirst({
    where: {
      proposalID,
      ...(exceptRequestID !== undefined && { NOT: { id: exceptRequestID } }),
    },
    select: { id: true },
  });
  if (taken) {
    throw new TRPCError({
      code: "CONFLICT",
      message: DISPOSABLE_PROPOSAL_TAKEN,
    });
  }
}

/**
 * File a request. The caller must head the CCA (a strict read). NO `status` is
 * written here: the schema default ("pending") applies, so `transition.ts`
 * stays the only code that names a status. Optional columns are written as
 * explicit nulls because on MongoDB a missing key does not match a `null`
 * filter. The Social director is told afterwards, best effort.
 */
export async function createRequest(
  db: PrismaClient,
  userID: string,
  input: DisposableCreateInput,
  now: Date = new Date(),
): Promise<{ id: string; version: number }> {
  await assertCcaHead(db, userID, input.ccaID);
  await assertWithinLimit("create", userID);
  assertNotPast(input.collectionDay, now);
  await assertProposalLinkable(db, input.ccaID, input.proposalID);
  const created = await db.disposableRequest.create({
    data: {
      ccaID: input.ccaID,
      createdBy: userID,
      title: input.title,
      description: input.description,
      proposalID: input.proposalID,
      plates: input.plates,
      cups: input.cups,
      bowls: input.bowls,
      forks: input.forks,
      spoons: input.spoons,
      collectionDay: input.collectionDay,
      collectionTime: input.collectionTime,
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
    },
    select: { id: true, version: true },
  });
  // After the save, best effort: it never throws and never fails the filing.
  await noticeFiled(db, { id: created.id, title: input.title }, userID);
  return created;
}

/**
 * Edit a request: the Social director only, at any time (A9, 4.9: a head
 * creates and reads, nothing more). Everyone else, the CCA's own head
 * included, gets the guard's refusal. Editing an APPROVED request sends it
 * back to pending (Q22) and tells the CCA's heads. The save is a
 * compare-and-set on the version the editor loaded and the status it saw, so
 * a stale tab or a race with a decision gets CONFLICT. The collection day is
 * checked against today only when it is being CHANGED, so a request whose day
 * has passed can still have its other fields corrected.
 */
export async function updateRequest(
  db: PrismaClient,
  userID: string,
  input: DisposableUpdateInput,
  now: Date = new Date(),
): Promise<{ id: string; version: number; status: string }> {
  await assertSocialDirector(db, userID);
  await assertWithinLimit("update", userID);
  const row = await db.disposableRequest.findUnique({
    where: { id: input.id },
    select: { ccaID: true, status: true, version: true, collectionDay: true },
  });
  if (!row) throw notFound();
  if (!isDisposableStatus(row.status)) throw notFound();
  if (row.version !== input.version) {
    throw new TRPCError({ code: "CONFLICT", message: DISPOSABLE_CONFLICT });
  }
  if (input.collectionDay !== row.collectionDay) {
    assertNotPast(input.collectionDay, now);
  }
  await assertProposalLinkable(db, row.ccaID, input.proposalID, input.id);

  const backToPending = row.status === "approved";
  const changed = await changeRequest(
    db,
    {
      id: input.id,
      expectedVersion: input.version,
      expectedCcaID: row.ccaID,
      from: row.status,
      to: backToPending ? "pending" : row.status,
      actorID: userID,
      content: {
        title: input.title,
        description: input.description,
        proposalID: input.proposalID,
        plates: input.plates,
        cups: input.cups,
        bowls: input.bowls,
        forks: input.forks,
        spoons: input.spoons,
        collectionDay: input.collectionDay,
        collectionTime: input.collectionTime,
      },
    },
    {
      inTransaction: (tx, changedRow) =>
        noticeEditedBySocialDirector(tx, changedRow, userID, backToPending),
    },
  );
  return { id: changed.id, version: changed.version, status: changed.status };
}

/**
 * The Social director approves or rejects a PENDING request, any CCA's. The
 * strict guard runs first (a failed read refuses), then the budget, then the
 * move. A person who is not the Social director learns nothing about the id.
 */
export async function decideRequest(
  db: PrismaClient,
  userID: string,
  decision: "approved" | "rejected",
  input: DisposableDecideInput,
): Promise<{ id: string; version: number; status: string }> {
  await assertSocialDirector(db, userID);
  await assertWithinLimit(
    decision === "approved" ? "approve" : "reject",
    userID,
  );
  const row = await db.disposableRequest.findUnique({
    where: { id: input.id },
    select: { ccaID: true, status: true, version: true },
  });
  if (!row) throw notFound();
  if (row.status !== "pending" || row.version !== input.version) {
    throw new TRPCError({ code: "CONFLICT", message: DISPOSABLE_CONFLICT });
  }
  const changed = await changeRequest(
    db,
    {
      id: input.id,
      expectedVersion: input.version,
      expectedCcaID: row.ccaID,
      from: "pending",
      to: decision,
      actorID: userID,
      decision: { note: input.note },
    },
    {
      inTransaction: (tx, changedRow) =>
        noticeDecision(tx, decision, changedRow, userID, input.note),
    },
  );
  return { id: changed.id, version: changed.version, status: changed.status };
}

/** The Social director deletes any request. */
export async function deleteRequest(
  db: PrismaClient,
  userID: string,
  id: string,
): Promise<{ id: string }> {
  await assertSocialDirector(db, userID);
  await assertWithinLimit("delete", userID);
  const row = await db.disposableRequest.findUnique({
    where: { id },
    select: { ccaID: true },
  });
  if (!row) throw notFound();
  await removeRequest(
    db,
    { id, expectedCcaID: row.ccaID },
    {
      inTransaction: (tx, removed) => noticeDeleted(tx, removed, userID),
    },
  );
  return { id };
}
