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
import { assertCanFile, DISPOSABLE_NOT_FOUND } from "./access";
import {
  assertTaggable,
  resolveTarget,
  tagIfProposalGotAnEvent,
} from "./eventTag";
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
 * One proposal has at most one request. The partial unique index is the
 * backstop for two writers at once.
 */
async function assertProposalFree(
  db: PrismaClient,
  proposalID: string | null,
): Promise<void> {
  if (proposalID === null) return;
  const taken = await db.disposableRequest.findFirst({
    where: { proposalID },
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
 * File a request, tagged to an event or to a proposal that has no event yet
 * (A66). The CCA is read from the STORED event (else the proposal), never from
 * the input. Who may file is decided by a strict read once that CCA is known
 * (A67): a CCA's event or proposal, a current head of that CCA and nobody else;
 * a hall-wide event (null CCA), a live JCRC member or an admin. The order is:
 * resolve the tag, authorize, spend the budget, then refuse a tag that is not
 * allowed (a canceled, declined, ended or untitled event; a proposal that
 * already has an event, or is a draft or canceled; a proposal not matching the
 * event), so a stranger
 * learns nothing about an event beyond "no such one".
 *
 * NO `status` is written here: the schema default ("pending") applies, so
 * `transition.ts` stays the only code that names a status. Every optional
 * column is written as an explicit null because on MongoDB a missing key does
 * not match a `null` filter. Several requests may share one event; a proposal
 * has at most one.
 *
 * After a proposal-only request commits, the proposal is read again: the Event
 * may have been claimed between the check and the commit, when the move of the
 * proposal's request would have found nothing. If it now has an Event, the
 * request is tagged with it rather than refused; that step is best effort too,
 * so a failure there is logged and the saved request is still returned. The
 * Social director is told afterwards, best effort.
 */
export async function createRequest(
  db: PrismaClient,
  userID: string,
  input: DisposableCreateInput,
  now: Date = new Date(),
): Promise<{ id: string; version: number }> {
  const target = await resolveTarget(db, input);
  await assertCanFile(db, userID, target.ccaID);
  await assertWithinLimit("create", userID);
  if (target.problem !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: target.problem });
  }
  assertTaggable(target, now);
  assertNotPast(input.collectionDay, now);
  await assertProposalFree(db, target.proposalID);
  const made = await db.disposableRequest.create({
    data: {
      ccaID: target.ccaID,
      eventID: target.eventID,
      eventTitle: target.eventTitle,
      createdBy: userID,
      title: input.title,
      description: input.description,
      proposalID: target.proposalID,
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
  if (target.eventID === null) {
    // Best effort, like the notice: the request is saved, so a failed re-read
    // is logged by error name and the saved request is still returned (an
    // error answer would invite a retry that hits DISPOSABLE_PROPOSAL_TAKEN).
    // An untagged request stays on its proposal and moves with the Event.
    try {
      await tagIfProposalGotAnEvent(db, made.id, target);
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "disposable_tag_failed",
          error: err instanceof Error ? err.name : typeof err,
        }),
      );
    }
  }
  // After the save, best effort: it never throws and never fails the filing.
  await noticeFiled(db, { id: made.id, title: input.title }, userID);
  return made;
}

/**
 * Edit a request: the Social director only, at any time (A9, 4.9: a head
 * creates and reads, nothing more). The event and proposal a request is tagged
 * to are NOT editable here (the input has neither): to retag, delete the
 * request and file it again. Everyone else, the CCA's own head
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
