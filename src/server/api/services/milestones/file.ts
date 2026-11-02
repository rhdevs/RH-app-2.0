import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import type { z } from "zod";

import { milestoneKey, type MilestoneRef } from "~/lib/milestones/open";
import {
  EVIDENCE_ATTACH_MAX_AGE_MS,
  MILESTONE_MAX_EVIDENCE,
  type milestoneAttachInput,
  type milestoneDetachInput,
  type milestoneSaveRatingInput,
} from "~/lib/schemas/milestone";
import type { EvidenceStorage } from "~/server/api/services/milestoneBlob";
import { assertMilestoneHead } from "./access";
import { resolveMilestone, type ResolvedMilestone } from "./candidates";
import {
  assertOpen,
  conflict,
  EVIDENCE_ALREADY_ATTACHED,
  EVIDENCE_ATTACH_CONFLICT,
  EVIDENCE_TOO_OLD,
  evidenceNotFound,
  MILESTONE_FROZEN,
  MILESTONE_NOT_OPEN,
  MILESTONE_TOO_MANY_PHOTOS,
  notFound,
} from "./errors";
import { assertMilestonesEnabled } from "./flag";
import { assertWithinLimit } from "./limits";
import type { EvidenceDb } from "./write";

/**
 * The HEAD's side of a milestone (merge proposal 4.10): save a self-rating,
 * attach photos, remove photos. Who may act comes from access.ts, a current
 * `CcaHead` row for the milestone's CCA read strictly on every call, never the
 * session's roles and never a body field: the CCA comes from the stored Event
 * or proposal.
 *
 * Every write names the version of the filing it read, and applies only if
 * that version is still current AND the filing is not frozen, in one
 * compare-and-set (`updateMany` with both in the filter). Two heads saving at
 * once: one applies, the other is refused (CONFLICT `MILESTONE_CONFLICT`) and
 * reloads, so no write is lost silently. After a director has rated
 * (`frozenAt` set in the director's transaction) nothing here applies:
 * CONFLICT `MILESTONE_FROZEN`.
 *
 * This file catches nothing (a source scan keeps it so); the router maps a
 * unique-index race and a transaction write conflict to CONFLICT.
 */

export type MilestoneDb = EvidenceDb &
  Pick<
    PrismaClient,
    | "milestoneSubmission"
    | "milestoneAssessment"
    | "event"
    | "proposal"
    | "$transaction"
  >;

/** The common first steps of every head write, in order. */
async function openForHead(
  db: MilestoneDb,
  userID: string,
  ref: MilestoneRef,
  now: Date,
): Promise<ResolvedMilestone> {
  await assertMilestonesEnabled(db);
  const m = await resolveMilestone(db, ref, now);
  if (m === null) throw notFound();
  await assertMilestoneHead(db, userID, m.ccaID, true);
  assertOpen(m);
  return m;
}

const refColumns = (ref: MilestoneRef) =>
  ref.kind === "event"
    ? { eventID: ref.eventID, proposalID: null }
    : { eventID: null, proposalID: ref.proposalID.toLowerCase() };

/** Read why a compare-and-set that matched nothing did not apply. */
async function whyRefused(
  tx: Pick<Prisma.TransactionClient, "milestoneSubmission">,
  id: string,
): Promise<TRPCError> {
  const row = await tx.milestoneSubmission.findUnique({
    where: { id },
    select: { frozenAt: true },
  });
  return row?.frozenAt ? conflict(MILESTONE_FROZEN) : conflict();
}

/**
 * Take the filing for a write: create it (the caller saw none), or
 * compare-and-set its version (the caller saw one). Returns the filing's id.
 * Throws CONFLICT when the version moved or the filing is frozen, and writes
 * nothing then. Runs inside the caller's transaction.
 */
async function takeFiling(
  tx: Prisma.TransactionClient,
  m: ResolvedMilestone,
  expectedVersion: number | null,
  first: { headScore: number; headText: string; userID: string } | null,
  now: Date,
): Promise<{ id: string; version: number }> {
  const existing = await tx.milestoneSubmission.findUnique({
    where: { milestoneKey: m.key },
    select: { id: true },
  });
  if (expectedVersion === null) {
    if (existing !== null) throw conflict();
    const created = await tx.milestoneSubmission.create({
      data: {
        milestoneKey: m.key,
        ccaID: m.ccaID,
        ...refColumns(m.ref),
        headScore: first?.headScore ?? null,
        headText: first?.headText ?? null,
        headBy: first?.userID ?? null,
        headRatedAt: first ? now : null,
        version: 1,
        frozenAt: null,
      },
      select: { id: true, version: true },
    });
    return created;
  }
  if (existing === null) throw conflict();
  return { id: existing.id, version: expectedVersion + 1 };
}

/**
 * After a proposal's FIRST filing commits, read the proposal again. If an
 * Event was claimed meanwhile (the Create event button wrote its claim before
 * it looked for this filing), take the new filing back out and refuse: the
 * two writes cannot both stand (B149). The Event side checks for the filing
 * after its own claim, so whichever lands second sees the other.
 */
async function backOutIfEventClaimed(
  db: MilestoneDb,
  m: ResolvedMilestone,
  created: { id: string } | null,
): Promise<void> {
  if (created === null || m.ref.kind !== "proposal") return;
  const p = await db.proposal.findUnique({
    where: { id: m.ref.proposalID.toLowerCase() },
    select: { eventID: true },
  });
  if (p?.eventID === null || p?.eventID === undefined) return;
  const filingID = created.id;
  await db.$transaction([
    db.milestoneEvidence.updateMany({
      where: { submissionID: filingID },
      data: { submissionID: null },
    }),
    db.milestoneSubmission.deleteMany({
      where: { id: filingID, frozenAt: null },
    }),
  ]);
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: MILESTONE_NOT_OPEN,
  });
}

/** Save (or replace) the head's self-rating. */
export async function saveHeadRating(
  db: MilestoneDb,
  userID: string,
  input: z.infer<typeof milestoneSaveRatingInput>,
  now: Date = new Date(),
): Promise<{ version: number }> {
  const m = await openForHead(db, userID, input.ref, now);
  await assertWithinLimit("file", userID);
  const out = await db.$transaction(async (tx) => {
    const filing = await takeFiling(
      tx,
      m,
      input.expectedVersion,
      { headScore: input.score, headText: input.text, userID },
      now,
    );
    if (input.expectedVersion === null) {
      return { version: filing.version, created: { id: filing.id } };
    }
    const applied = await tx.milestoneSubmission.updateMany({
      where: {
        id: filing.id,
        version: input.expectedVersion,
        frozenAt: null,
      },
      data: {
        headScore: input.score,
        headText: input.text,
        headBy: userID,
        headRatedAt: now,
        version: { increment: 1 },
      },
    });
    if (applied.count !== 1) throw await whyRefused(tx, filing.id);
    return { version: filing.version, created: null };
  });
  await backOutIfEventClaimed(db, m, out.created);
  return { version: out.version };
}

/**
 * Attach unattached photos of this CCA to the filing. The checks that name a
 * reason run first; the write is then a compare-and-set on each photo's
 * unattached state, inside the transaction that also takes the filing's
 * version, so a photo attaches to one filing only, and a photo near its
 * cleanup age is never attached (B127).
 */
export async function attachEvidence(
  db: MilestoneDb,
  userID: string,
  input: z.infer<typeof milestoneAttachInput>,
  now: Date = new Date(),
): Promise<{ version: number; attached: number }> {
  const m = await openForHead(db, userID, input.ref, now);
  const ids = [...new Set(input.evidenceIDs.map((i) => i.toLowerCase()))];
  const rows = await db.milestoneEvidence.findMany({
    where: { id: { in: ids } },
    select: { id: true, ccaID: true, submissionID: true, createdAt: true },
  });
  // Missing and another CCA's photo are the same answer: no probing by id.
  if (rows.length !== ids.length || rows.some((r) => r.ccaID !== m.ccaID)) {
    throw evidenceNotFound();
  }
  if (rows.some((r) => r.submissionID !== null)) {
    throw conflict(EVIDENCE_ALREADY_ATTACHED);
  }
  const cutoff = new Date(now.getTime() - EVIDENCE_ATTACH_MAX_AGE_MS);
  if (rows.some((r) => r.createdAt < cutoff)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: EVIDENCE_TOO_OLD });
  }
  await assertWithinLimit("attach", userID);

  const out = await db.$transaction(async (tx) => {
    const filing = await takeFiling(tx, m, input.expectedVersion, null, now);
    if (input.expectedVersion !== null) {
      const applied = await tx.milestoneSubmission.updateMany({
        where: {
          id: filing.id,
          version: input.expectedVersion,
          frozenAt: null,
        },
        data: { version: { increment: 1 } },
      });
      if (applied.count !== 1) throw await whyRefused(tx, filing.id);
    }
    const held = await tx.milestoneEvidence.count({
      where: { submissionID: filing.id },
    });
    if (held + ids.length > MILESTONE_MAX_EVIDENCE) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: MILESTONE_TOO_MANY_PHOTOS,
      });
    }
    const moved = await tx.milestoneEvidence.updateMany({
      where: {
        id: { in: ids },
        ccaID: m.ccaID,
        submissionID: null,
        createdAt: { gte: cutoff },
      },
      data: { submissionID: filing.id },
    });
    // Some photo was attached elsewhere, removed or aged out since the read:
    // roll the whole attach back (the filing created above goes with it).
    if (moved.count !== ids.length) {
      throw conflict(EVIDENCE_ATTACH_CONFLICT);
    }
    return {
      version: filing.version,
      attached: moved.count,
      created: input.expectedVersion === null ? { id: filing.id } : null,
    };
  });
  await backOutIfEventClaimed(db, m, out.created);
  return { version: out.version, attached: out.attached };
}

/**
 * Remove one attached photo while the filing is not frozen. ONE transaction
 * takes the version (a compare-and-set that also proves the filing is unfrozen
 * and unchanged) and deletes the row, so a director's rating either freezes the
 * filing before this (refused) or finds the photo already gone, never strips a
 * photo from a rated filing. The FILE is removed from the private store after
 * the commit, best effort; one the store missed is collected by the orphan
 * sweep (B128). This reverses the earlier storage-first order (B144) for this
 * path only. Frozen evidence is refused.
 */
export async function detachEvidence(
  db: MilestoneDb,
  storage: Pick<EvidenceStorage, "remove">,
  userID: string,
  input: z.infer<typeof milestoneDetachInput>,
  now: Date = new Date(),
): Promise<{ version: number }> {
  const m = await openForHead(db, userID, input.ref, now);
  await assertWithinLimit("detach", userID);
  const filing = await db.milestoneSubmission.findUnique({
    where: { milestoneKey: milestoneKey(input.ref) },
    select: { id: true, frozenAt: true },
  });
  if (filing === null) throw notFound();
  if (filing.frozenAt !== null) throw conflict(MILESTONE_FROZEN);
  const photo = await db.milestoneEvidence.findFirst({
    where: {
      id: input.evidenceID.toLowerCase(),
      submissionID: filing.id,
      ccaID: m.ccaID,
    },
    select: { id: true, pathname: true },
  });
  if (photo === null) throw evidenceNotFound();

  await db.$transaction(async (tx) => {
    const applied = await tx.milestoneSubmission.updateMany({
      where: {
        id: filing.id,
        version: input.expectedVersion,
        frozenAt: null,
      },
      data: { version: { increment: 1 } },
    });
    if (applied.count !== 1) throw await whyRefused(tx, filing.id);
    const gone = await tx.milestoneEvidence.deleteMany({
      where: { id: photo.id, submissionID: filing.id },
    });
    if (gone.count !== 1) throw evidenceNotFound();
  });
  if (!(await storage.remove(photo.pathname))) {
    console.error(JSON.stringify({ evt: "milestone_blob_remove_failed" }));
  }
  return { version: input.expectedVersion + 1 };
}
