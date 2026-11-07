import {
  proposalCreateInput,
  proposalIdInput,
  proposalListInput,
  proposalSubmitInput,
  proposalUpdateInput,
} from "~/lib/schemas/proposal";
import {
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import {
  createProposal,
  updateProposal,
} from "~/server/api/services/proposals/drafts";
import {
  assertProposalsEnabled,
  isProposalsEnabled,
} from "~/server/api/services/proposals/flag";
import {
  getProposal,
  listProposals,
} from "~/server/api/services/proposals/read";
import { submitProposal } from "~/server/api/services/proposals/submit";

/**
 * Proposals (merge proposal 4.1), behind `proposals.enabled`.
 *
 * EVERY procedure but `enabled` checks the flag first, through one gated
 * builder, so a new procedure cannot forget it. Who may act is decided inside
 * the services from stored rows, by the CCA a stored proposal belongs to or
 * the CCA id the browser sent, never from the session's roles:
 *  - create / update / submit: a head of that CCA only;
 *  - get / list: that CCA's heads and directors only.
 * An admin who is neither is refused. Where the caller names a proposal id
 * (get, update, submit) a missing id and another CCA's id give the same
 * NOT_FOUND. create / update / submit also carry a per-person hourly ceiling
 * (services/proposals/limits.ts). Status is never an input and never
 * written here: submit calls `transitionProposal`, the only status writer.
 *
 * There is no head "cancel" in this PR: the proposal's 4.1 and F06 give heads
 * "write and submit", and the table already carries the canceled status for
 * the PR that gives someone the power to use it.
 */
const gated = identifiedProcedure
  // Outermost, so a failure anywhere below (a Prisma error out of a service,
  // the notices written during submit) reaches the caller as "Something went
  // wrong." and the real message goes to the server log only. Deliberate
  // refusals (FORBIDDEN, NOT_FOUND, CONFLICT, ...) pass through untouched.
  .use(sanitizeErrors)
  .use(async ({ ctx, next }) => {
    await assertProposalsEnabled(ctx.db);
    return next();
  });

export const proposalRouter = createTRPCRouter({
  /** The screens ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isProposalsEnabled(ctx.db),
  })),

  create: gated
    .input(proposalCreateInput)
    .mutation(({ ctx, input }) =>
      createProposal(ctx.db, ctx.session.user.userID, input),
    ),

  update: gated
    .input(proposalUpdateInput)
    .mutation(({ ctx, input }) =>
      updateProposal(ctx.db, ctx.session.user.userID, input),
    ),

  get: gated
    .input(proposalIdInput)
    .query(({ ctx, input }) =>
      getProposal(ctx.db, ctx.session.user.userID, input.id),
    ),

  list: gated
    .input(proposalListInput)
    .query(({ ctx, input }) =>
      listProposals(ctx.db, ctx.session.user.userID, input.ccaID),
    ),

  submit: gated
    .input(proposalSubmitInput)
    .mutation(({ ctx, input }) =>
      submitProposal(ctx.db, ctx.session.user.userID, input),
    ),
});
