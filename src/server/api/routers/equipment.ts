import {
  draftInput,
  itemCreateInput,
  itemDeleteInput,
  itemRetireInput,
  itemUpdateInput,
  loanActInput,
  loanApproveInput,
  loanCheckInput,
  loanCreateInput,
  loanDirectorCancelInput,
  loanIdInput,
  loanListInput,
  loanNoteInput,
  loanRejectInput,
  loanReturnInput,
} from "~/lib/schemas/equipment";
import {
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import { evidenceStorage } from "~/server/api/services/milestoneBlob";
import { assertBoardReader } from "~/server/api/services/equipment/access";
import {
  approveLoan,
  cancelLoan,
  collectLoan,
  noteLoan,
  rejectLoan,
  returnLoan,
} from "~/server/api/services/equipment/decide";
import {
  assertEquipmentEnabled,
  isEquipmentEnabled,
} from "~/server/api/services/equipment/flag";
import {
  createItem,
  deleteItem,
  listItems,
  retireItem,
  updateItem,
} from "~/server/api/services/equipment/items";
import {
  canFileForEvent,
  draftFor,
  getEntry,
  getLoan,
  listLoans,
} from "~/server/api/services/equipment/read";
import { fileLoan, previewLoan } from "~/server/api/services/equipment/write";

/**
 * Equipment loans for events (merge proposal 14b), behind `equipment.enabled`.
 *
 * EVERY procedure but `enabled` and `entry` checks the flag first, through one
 * gated builder, so a new procedure cannot forget it. Who may act is decided
 * inside the services from stored rows, by the CCA the stored event or loan
 * belongs to (the browser never sends a CCA), never from the session roles:
 *  - items.*: the Social director only (the strict guard; admins are refused);
 *    the list is read by every board reader;
 *  - create / check: whoever disposables lets file for the event;
 *  - approve / reject: the Social director only. Approval is the stock check:
 *    it refuses a shortage at any instant of the window and runs in one
 *    transaction that also writes the items it names;
 *  - cancel / collect / markReturned: the event leaders or the Social director;
 *  - note: the Social director only, on a returned loan;
 *  - list / get: the board readers (every CCA head, every live JCRC holder,
 *    the Social director and admins). The photo is served by its own route
 *    (api/equipment-return/[id]), which only the director and the leaders pass.
 * Status is never an input and never written here: the services call
 * `transition.ts`, the only status writer. Every write carries a per-person
 * hourly ceiling (services/equipment/limits.ts). Errors pass through
 * `sanitizeErrors`, so a database error reaches the caller as "Something went
 * wrong.".
 */
const gated = identifiedProcedure
  .use(sanitizeErrors)
  .use(async ({ ctx, next }) => {
    await assertEquipmentEnabled(ctx.db);
    return next();
  });

export const equipmentRouter = createTRPCRouter({
  /** The screens ask this. Never throws on off. */
  enabled: protectedProcedure.query(async ({ ctx }) => ({
    enabled: await isEquipmentEnabled(ctx.db),
  })),

  /**
   * Whether the navigation shows the Equipment entry. NOT gated: off and "can
   * read nothing" are both a plain `{ show: false }`. A failed guard read is an
   * error, which the header treats as "hide it".
   */
  entry: identifiedProcedure
    .use(sanitizeErrors)
    .query(({ ctx }) => getEntry(ctx.db, ctx.session.user.userID)),

  list: gated
    .input(loanListInput)
    .query(({ ctx, input }) =>
      listLoans(ctx.db, ctx.session.user.userID, input),
    ),

  get: gated
    .input(loanIdInput)
    .query(({ ctx, input }) =>
      getLoan(ctx.db, ctx.session.user.userID, input.id),
    ),

  /** The equipment list, for the board's readers; only the director may edit it. */
  items: gated.query(async ({ ctx }) => {
    const viewer = await assertBoardReader(ctx.db, ctx.session.user.userID);
    return {
      items: await listItems(ctx.db),
      isDirector: viewer.isDirector,
    };
  }),

  /** Whether this person may file for this event now (the event page link). */
  canFile: gated
    .input(draftInput)
    .query(({ ctx, input }) =>
      canFileForEvent(ctx.db, ctx.session.user.userID, input.eventID),
    ),

  /** What the new-loan form starts with: the event and its times. */
  draft: gated
    .input(draftInput)
    .query(({ ctx, input }) =>
      draftFor(ctx.db, ctx.session.user.userID, input.eventID),
    ),

  /** The form's live "looks short" preview. Writes nothing. */
  check: gated
    .input(loanCheckInput)
    .query(({ ctx, input }) =>
      previewLoan(ctx.db, ctx.session.user.userID, input),
    ),

  create: gated
    .input(loanCreateInput)
    .mutation(({ ctx, input }) =>
      fileLoan(ctx.db, ctx.session.user.userID, input),
    ),

  approve: gated
    .input(loanApproveInput)
    .mutation(({ ctx, input }) =>
      approveLoan(ctx.db, ctx.session.user.userID, input),
    ),

  reject: gated
    .input(loanRejectInput)
    .mutation(({ ctx, input }) =>
      rejectLoan(ctx.db, ctx.session.user.userID, input),
    ),

  cancel: gated
    .input(loanDirectorCancelInput)
    .mutation(({ ctx, input }) =>
      cancelLoan(ctx.db, ctx.session.user.userID, input),
    ),

  collect: gated
    .input(loanActInput)
    .mutation(({ ctx, input }) =>
      collectLoan(ctx.db, ctx.session.user.userID, input),
    ),

  markReturned: gated
    .input(loanReturnInput)
    .mutation(({ ctx, input }) =>
      returnLoan(ctx.db, evidenceStorage, ctx.session.user.userID, input),
    ),

  /** The Social director sets or replaces the note on a returned loan. */
  note: gated
    .input(loanNoteInput)
    .mutation(({ ctx, input }) =>
      noteLoan(ctx.db, ctx.session.user.userID, input),
    ),

  createItem: gated
    .input(itemCreateInput)
    .mutation(({ ctx, input }) =>
      createItem(ctx.db, ctx.session.user.userID, input),
    ),

  updateItem: gated
    .input(itemUpdateInput)
    .mutation(({ ctx, input }) =>
      updateItem(ctx.db, ctx.session.user.userID, input),
    ),

  retireItem: gated
    .input(itemRetireInput)
    .mutation(({ ctx, input }) =>
      retireItem(ctx.db, ctx.session.user.userID, input),
    ),

  deleteItem: gated
    .input(itemDeleteInput)
    .mutation(({ ctx, input }) =>
      deleteItem(ctx.db, ctx.session.user.userID, input.id),
    ),
});
