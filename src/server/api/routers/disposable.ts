import {
  disposableCreateInput,
  disposableDecideInput,
  disposableDeleteInput,
  disposableIdInput,
  disposableListInput,
  disposableProposalChoicesInput,
  disposableUpdateInput,
} from "~/lib/schemas/disposable";
import {
  createTRPCRouter,
  identifiedProcedure,
  mapUniqueViolation,
  protectedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import { DISPOSABLE_PROPOSAL_INDEX } from "~/lib/disposables/indexes";
import { DISPOSABLE_PROPOSAL_TAKEN } from "~/server/api/services/disposables/write";
import {
  assertDisposablesEnabled,
  isDisposablesEnabled,
} from "~/server/api/services/disposables/flag";
import { collectionDigest } from "~/server/api/services/disposables/digest";
import { nudgeSocialDirector } from "~/server/api/services/disposables/nudge";
import {
  getEntry,
  getRequest,
  headCcaChoices,
  listRequests,
  proposalChoices,
} from "~/server/api/services/disposables/read";
import {
  createRequest,
  decideRequest,
  deleteRequest,
  updateRequest,
} from "~/server/api/services/disposables/write";

/**
 * Disposable requests (merge proposal 4.9), behind `disposables.enabled`.
 *
 * EVERY procedure but `enabled` and `entry` checks the flag first, through one
 * gated builder, so a new procedure cannot forget it. Who may act is decided
 * inside the services from stored rows, by the CCA a stored request belongs to
 * or the CCA id the browser sent, never from the session's roles:
 *  - create / headCcas / proposalChoices: a head of that CCA only;
 *  - list / get: that CCA's heads, and every JCRC member for all (a head of
 *    another CCA is refused even the read);
 *  - update / approve / reject / delete: the Social director only (the holder of the
 *    exactly-one handlesDisposables position), by the strict guard;
 *  - digest: the Social director only, by the same guard;
 *  - nudge: a head of the request's CCA (anyone else gets NOT_FOUND).
 * An admin who is none of these is refused. Status is never an input and never
 * written here: the services call `transition.ts`, the only status writer.
 * A race for one proposal's single request ends in DISPOSABLE_PROPOSAL_TAKEN,
 * mapped from the partial unique index's violation (mapUniqueViolation).
 * Every write carries a per-person hourly ceiling
 * (services/disposables/limits.ts). Errors pass through `sanitizeErrors`, so a
 * database error reaches the caller as "Something went wrong.".
 */
const gated = identifiedProcedure
  .use(sanitizeErrors)
  .use(mapUniqueViolation(DISPOSABLE_PROPOSAL_INDEX, DISPOSABLE_PROPOSAL_TAKEN))
  .use(async ({ ctx, next }) => {
    await assertDisposablesEnabled(ctx.db);
    return next();
  });

export const disposableRouter = createTRPCRouter({
  /** The screens ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isDisposablesEnabled(ctx.db),
  })),

  /**
   * Whether the navigation shows the Disposables entry. NOT gated: off and
   * "can read nothing" are both a plain `{ show: false }`. A failed guard read
   * is an error, which the header treats as "hide it".
   */
  entry: identifiedProcedure
    .use(sanitizeErrors)
    .query(({ ctx }) => getEntry(ctx.db, ctx.session.user.userID)),

  list: gated
    .input(disposableListInput)
    .query(({ ctx, input }) =>
      listRequests(ctx.db, ctx.session.user.userID, input),
    ),

  get: gated
    .input(disposableIdInput)
    .query(({ ctx, input }) =>
      getRequest(ctx.db, ctx.session.user.userID, input.id),
    ),

  headCcas: gated.query(({ ctx }) =>
    headCcaChoices(ctx.db, ctx.session.user.userID),
  ),

  proposalChoices: gated
    .input(disposableProposalChoicesInput)
    .query(({ ctx, input }) =>
      proposalChoices(ctx.db, ctx.session.user.userID, input.ccaID),
    ),

  create: gated
    .input(disposableCreateInput)
    .mutation(({ ctx, input }) =>
      createRequest(ctx.db, ctx.session.user.userID, input),
    ),

  update: gated
    .input(disposableUpdateInput)
    .mutation(({ ctx, input }) =>
      updateRequest(ctx.db, ctx.session.user.userID, input),
    ),

  approve: gated
    .input(disposableDecideInput)
    .mutation(({ ctx, input }) =>
      decideRequest(ctx.db, ctx.session.user.userID, "approved", input),
    ),

  reject: gated
    .input(disposableDecideInput)
    .mutation(({ ctx, input }) =>
      decideRequest(ctx.db, ctx.session.user.userID, "rejected", input),
    ),

  /**
   * Today's approved collections, for the Social director only (F19). A plain
   * query: it writes nothing. Anyone else is refused by the strict guard.
   */
  digest: gated.query(({ ctx }) =>
    collectionDigest(ctx.db, ctx.session.user.userID),
  ),

  /** A head nudges the Social director about a pending request (F21, B59). */
  nudge: gated
    .input(disposableIdInput)
    .mutation(({ ctx, input }) =>
      nudgeSocialDirector(ctx.db, ctx.session.user.userID, input.id),
    ),

  delete: gated
    .input(disposableDeleteInput)
    .mutation(({ ctx, input }) =>
      deleteRequest(ctx.db, ctx.session.user.userID, input.id),
    ),
});
