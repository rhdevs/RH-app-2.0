import {
  evidenceListInput,
  evidenceRecordInput,
  evidenceRemoveInput,
} from "~/lib/schemas/milestoneEvidence";
import {
  createTRPCRouter,
  identifiedProcedure,
  mapUniqueViolation,
  protectedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import { evidenceStorage } from "~/server/api/services/milestoneBlob";
import {
  assertMilestonesEnabled,
  isMilestonesEnabled,
} from "~/server/api/services/milestones/flag";
import { listEvidence } from "~/server/api/services/milestones/read";
import {
  EVIDENCE_DUPLICATE,
  recordEvidence,
  removeEvidence,
} from "~/server/api/services/milestones/write";

/**
 * Private evidence photos (merge proposal F21), behind `milestones.enabled`.
 *
 * EVERY procedure but `enabled` checks the flag first, through one gated
 * builder, so a new procedure cannot forget it. Who may act is decided inside
 * the services from stored rows, never from the session's roles: a CURRENT HEAD
 * of the owning CCA lists, records and removes. The browser sends only a CCA
 * (to check) and the address its upload returned (parsed and verified against
 * the private store); it never receives a store address, only evidence ids,
 * which the serving route (api/milestone-evidence/[id]) checks on every view.
 * Errors pass through `sanitizeErrors`.
 */
const gated = identifiedProcedure
  .use(sanitizeErrors)
  .use(async ({ ctx, next }) => {
    await assertMilestonesEnabled(ctx.db);
    return next();
  });

export const milestoneEvidenceRouter = createTRPCRouter({
  /** The screens ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isMilestonesEnabled(ctx.db),
  })),

  list: gated
    .input(evidenceListInput)
    .query(({ ctx, input }) =>
      listEvidence(ctx.db, ctx.session.user.userID, input.ccaID),
    ),

  record: gated
    // Two records of one file racing past the pre-check meet the unique index.
    .use(mapUniqueViolation("milestone_evidence_pathname", EVIDENCE_DUPLICATE))
    .input(evidenceRecordInput)
    .mutation(({ ctx, input }) =>
      recordEvidence(ctx.db, evidenceStorage, ctx.session.user.userID, input),
    ),

  remove: gated
    .input(evidenceRemoveInput)
    .mutation(({ ctx, input }) =>
      removeEvidence(
        ctx.db,
        evidenceStorage,
        ctx.session.user.userID,
        input.id,
      ),
    ),
});
