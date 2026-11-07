import { TRPCError } from "@trpc/server";
import type { z } from "zod";

import { milestoneKey } from "~/lib/milestones/open";
import type { milestoneRateInput } from "~/lib/schemas/milestone";
import { assertMilestoneDirector } from "./access";
import { resolveMilestone } from "./candidates";
import {
  assertOpen,
  conflict,
  MILESTONE_ALREADY_RATED,
  MILESTONE_NOTHING_TO_RATE,
  notFound,
} from "./errors";
import type { MilestoneDb } from "./file";
import { seenToken } from "./view";
import { assertMilestonesEnabled } from "./flag";
import { assertWithinLimit } from "./limits";

/**
 * The DIRECTOR's side (merge proposal 4.10, Q15): one independent rating per
 * filing. Who may rate: a director of the milestone's CCA by the strict guard
 * (access.ts), read on this call. An admin, an RF, a JCRC member without the
 * position, a holder of another position and a director of another CCA are all
 * refused (as one NOT_FOUND, so an id cannot be probed).
 *
 * A director who also heads the CCA may rate it (the same rule as approving
 * their own proposal, 4.2): the rating is stored with `selfRated: true` and the
 * screens show that label. Recorded as B138.
 *
 * One transaction: a compare-and-set sets the filing's `frozenAt` only if it
 * is still null (this is what freezes the head's filing, and what makes two
 * directors rating at once safe: one applies, the other is refused with
 * `MILESTONE_ALREADY_RATED`), then the assessment row is written. The unique
 * index on the assessment's submission is the backstop. There is nothing to
 * rate until the head has attached at least one photo.
 *
 * This file catches nothing (a source scan keeps it so).
 */
export async function rateMilestone(
  db: MilestoneDb,
  userID: string,
  input: z.infer<typeof milestoneRateInput>,
  now: Date = new Date(),
): Promise<{ rated: true }> {
  await assertMilestonesEnabled(db);
  const m = await resolveMilestone(db, input.ref, now);
  if (m === null) throw notFound();
  await assertMilestoneDirector(db, userID, m.ccaID, true);
  assertOpen(m);
  await assertWithinLimit("rate", userID);

  const filing = await db.milestoneSubmission.findUnique({
    where: { milestoneKey: milestoneKey(input.ref) },
    select: { id: true, frozenAt: true, version: true },
  });
  if (filing === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: MILESTONE_NOTHING_TO_RATE,
    });
  }
  if (filing.frozenAt !== null) throw conflict(MILESTONE_ALREADY_RATED);
  // The rating is of the filing the director looked at (B151).
  if (input.seen !== seenToken(filing.id, filing.version)) throw conflict();

  await db.$transaction(async (tx) => {
    const frozen = await tx.milestoneSubmission.updateMany({
      where: { id: filing.id, frozenAt: null, version: filing.version },
      data: { frozenAt: now, version: { increment: 1 } },
    });
    if (frozen.count !== 1) {
      const now2 = await tx.milestoneSubmission.findUnique({
        where: { id: filing.id },
        select: { frozenAt: true },
      });
      throw now2?.frozenAt ? conflict(MILESTONE_ALREADY_RATED) : conflict();
    }
    // After the freeze, so a head's detach that just won cannot leave a rating
    // of nothing: the count is read in the same transaction.
    const photos = await tx.milestoneEvidence.count({
      where: { submissionID: filing.id },
    });
    if (photos === 0) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: MILESTONE_NOTHING_TO_RATE,
      });
    }
    // Strict, no catch: a failed read rolls the whole rating back.
    const alsoHead =
      (await tx.ccaHead.findFirst({
        where: { userID, ccaID: m.ccaID },
        select: { id: true },
      })) !== null;
    await tx.milestoneAssessment.create({
      data: {
        submissionID: filing.id,
        ccaID: m.ccaID,
        score: input.score,
        text: input.text,
        assessedBy: userID,
        selfRated: alsoHead,
      },
    });
  });
  return { rated: true };
}
