import { createHash } from "node:crypto";

import type { z } from "zod";

import { MILESTONE_MAX_EVIDENCE } from "~/lib/schemas/milestone";
import type { milestoneGetInput } from "~/lib/schemas/milestone";
import {
  neededFrom,
  visibleParts,
  type AssessmentParts,
  type SubmissionParts,
} from "~/lib/milestones/visibility";
import { milestoneKey, type MilestoneRef } from "~/lib/milestones/open";
import { assertMilestoneParty } from "./access";
import { resolveMilestone } from "./candidates";
import { notFound, MILESTONE_NOT_OPEN } from "./errors";
import type { MilestoneDb } from "./file";
import { assertMilestonesEnabled } from "./flag";
import { assertWithinLimit } from "./limits";
import { TRPCError } from "@trpc/server";

/**
 * One milestone as a person is allowed to see it (merge proposal Q15, A55).
 *
 * THE RESPONSE IS BUILT FROM `visibleParts`: a field the viewer may not see is
 * not in the object at all. A director who has not rated gets no `head` key, no
 * `version`, and nothing that says whether the head has rated; a head who has
 * not rated gets no `assessment` key. Evidence is in both, because it is what
 * is rated. `locked` is the one thing a head learns before rating: the filing
 * can no longer change. Who may read: a head or a director of the milestone's
 * CCA now, by strict reads; anyone else, a missing row and a milestone that
 * can never carry one are one NOT_FOUND.
 */

export type EvidenceItem = {
  id: string;
  contentType: string;
  size: number;
  createdAt: Date;
};

/**
 * An opaque token for "the filing as this director loaded it": it changes when
 * the head saves, attaches or removes a photo. It carries no count and says
 * nothing about whether the head has rated (B151).
 */
export const seenToken = (id: string, version: number): string =>
  createHash("sha256").update(`${id}:${version}`).digest("hex").slice(0, 16);

export type MilestoneView = {
  ref: MilestoneRef;
  title: string;
  ccaID: number;
  endedAt: number | null;
  /**
   * `open`; `canceled` (a published event canceled later: the filing stays and
   * nothing more is accepted); or `closed` (not ended, or no longer a
   * candidate, with a filing still on record).
   */
  state: "open" | "canceled" | "closed";
  viewer: { head: boolean; director: boolean };
  evidence: EvidenceItem[];
  locked: boolean;
  /** Heads only: the filing's version, to send back with a save. */
  version?: number | null;
  /** Directors only, when a filing exists: send it back with the rating. */
  seen?: string;
  head?: { score: number; text: string; ratedAt: Date | null } | null;
  assessment?: AssessmentParts;
  canFile: boolean;
  canRate: boolean;
};

export async function getMilestone(
  db: MilestoneDb,
  userID: string,
  input: z.infer<typeof milestoneGetInput>,
  now: Date = new Date(),
): Promise<MilestoneView> {
  await assertMilestonesEnabled(db);
  const m = await resolveMilestone(db, input.ref, now);
  if (m === null) throw notFound();
  const roles = await assertMilestoneParty(db, userID, m.ccaID, true);
  await assertWithinLimit("browse", userID);

  const sub = await db.milestoneSubmission.findUnique({
    where: { milestoneKey: milestoneKey(input.ref) },
    select: {
      id: true,
      headScore: true,
      headText: true,
      headRatedAt: true,
      version: true,
      frozenAt: true,
    },
  });
  // Not open yet and nothing filed: there is nothing to show a party.
  if (m.state === "closed" && sub === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: MILESTONE_NOT_OPEN,
    });
  }
  const assessmentRow = sub
    ? await db.milestoneAssessment.findUnique({
        where: { submissionID: sub.id },
        select: { score: true, text: true, selfRated: true, createdAt: true },
      })
    : null;
  const evidence = sub
    ? await db.milestoneEvidence.findMany({
        where: { submissionID: sub.id },
        orderBy: { createdAt: "asc" },
        take: MILESTONE_MAX_EVIDENCE,
        select: { id: true, contentType: true, size: true, createdAt: true },
      })
    : [];

  const parts: SubmissionParts | null = sub
    ? {
        headScore: sub.headScore ?? null,
        headText: sub.headText ?? null,
        headRatedAt: sub.headRatedAt ?? null,
        frozen: sub.frozenAt !== null && sub.frozenAt !== undefined,
      }
    : null;
  const seen = visibleParts(roles, parts, assessmentRow);
  const open = m.state === "open";
  const needs = neededFrom(roles, parts, evidence.length, assessmentRow);

  const view: MilestoneView = {
    ref: input.ref,
    title: m.title,
    ccaID: m.ccaID,
    endedAt: m.endedAt,
    state: m.state,
    viewer: { head: roles.head, director: roles.director },
    evidence,
    locked: seen.locked,
    canFile: open && needs.includes("file"),
    canRate: open && needs.includes("rate"),
  };
  if (roles.head) view.version = sub?.version ?? null;
  if (roles.director && sub) view.seen = seenToken(sub.id, sub.version);
  if (seen.headVisible) view.head = seen.head ?? null;
  if (seen.assessment) view.assessment = seen.assessment;
  return view;
}
