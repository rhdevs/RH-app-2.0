import {
  milestoneAttachInput,
  milestoneDetachInput,
  milestoneGetInput,
  milestoneRateInput,
  milestoneSaveRatingInput,
  milestoneYearInput,
} from "~/lib/schemas/milestone";
import {
  createTRPCRouter,
  identifiedProcedure,
  mapUniqueViolation,
  mapWriteConflict,
  protectedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import { evidenceStorage } from "~/server/api/services/milestoneBlob";
import { MILESTONE_CONFLICT } from "~/server/api/services/milestones/errors";
import {
  attachEvidence,
  detachEvidence,
  saveHeadRating,
} from "~/server/api/services/milestones/file";
import {
  assertMilestonesEnabled,
  isMilestonesEnabled,
} from "~/server/api/services/milestones/flag";
import { rateMilestone } from "~/server/api/services/milestones/rate";
import { getMilestone } from "~/server/api/services/milestones/view";
import { myMilestones } from "~/server/api/services/milestones/waiting";
import { getYear } from "~/server/api/services/milestones/year";

/**
 * Milestones (merge proposal 4.10), behind `milestones.enabled`: a head files a
 * self-rating and photos for an event that has ended, a director rates it
 * independently, and each CCA has a yearly view.
 *
 * Every procedure but `enabled` checks the flag first, through one gated
 * builder. Who may act is decided in the services from stored rows (strict
 * head and director reads), never from the session's roles or a body field;
 * the CCA always comes from the stored Event or proposal. Responses are built
 * so a hidden rating is absent (services/milestones/view.ts). A unique-index
 * race on the filing, or a transaction write conflict, becomes a CONFLICT the
 * screen answers by reloading. Errors pass through `sanitizeErrors`.
 */
const gated = identifiedProcedure
  .use(sanitizeErrors)
  .use(mapUniqueViolation("milestone_submission_key", MILESTONE_CONFLICT))
  .use(mapWriteConflict(MILESTONE_CONFLICT))
  .use(async ({ ctx, next }) => {
    await assertMilestonesEnabled(ctx.db);
    return next();
  });

export const milestoneRouter = createTRPCRouter({
  /** The screens ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isMilestonesEnabled(ctx.db),
  })),

  /** The home entries: my CCAs and what is waiting in each. */
  mine: gated.query(({ ctx }) =>
    myMilestones(ctx.db, ctx.session.user.userID, new Date()),
  ),

  get: gated
    .input(milestoneGetInput)
    .query(({ ctx, input }) =>
      getMilestone(ctx.db, ctx.session.user.userID, input),
    ),

  year: gated
    .input(milestoneYearInput)
    .query(({ ctx, input }) => getYear(ctx.db, ctx.session.user.userID, input)),

  saveRating: gated
    .input(milestoneSaveRatingInput)
    .mutation(({ ctx, input }) =>
      saveHeadRating(ctx.db, ctx.session.user.userID, input),
    ),

  attach: gated
    .input(milestoneAttachInput)
    .mutation(({ ctx, input }) =>
      attachEvidence(ctx.db, ctx.session.user.userID, input),
    ),

  detach: gated
    .input(milestoneDetachInput)
    .mutation(({ ctx, input }) =>
      detachEvidence(ctx.db, evidenceStorage, ctx.session.user.userID, input),
    ),

  rate: gated
    .input(milestoneRateInput)
    .mutation(({ ctx, input }) =>
      rateMilestone(ctx.db, ctx.session.user.userID, input),
    ),
});
