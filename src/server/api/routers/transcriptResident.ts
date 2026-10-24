import {
  activityOptionsInput,
  awardsOfInput,
  historyInput,
  jcrcRefInput,
  manualListInput,
  manualRefInput,
  manualSaveInput,
  participationRemoveInput,
  participationSetInput,
  relockInput,
  releaseInput,
  residentScope,
  unlockInput,
  withholdInput,
} from "~/lib/transcript/residentInput";
import { requireManager } from "~/server/api/services/transcript/manageAccess";
import {
  jcrcGet,
  jcrcRemove,
  jcrcRestore,
} from "~/server/api/services/transcript/manageRecords";
import {
  activityOptions,
  awardsOf,
  participationList,
  participationRemove,
  participationSet,
  volunteerOf,
} from "~/server/api/services/transcript/residentData";
import {
  manualRemove,
  manualRestore,
  manualSave,
  residentMemberships,
} from "~/server/api/services/transcript/residentManual";
import {
  relockResident,
  releaseResident,
  residentHistory,
  residentPanel,
  unlockResident,
  withholdResident,
} from "~/server/api/services/transcript/residentManage";
import { requireResident } from "~/server/api/services/transcript/residents";
// The repo's builders with the transcript kill switch added (procedures.ts).
import { transcriptRoleManagerProcedure as roleManagerProcedure } from "~/server/api/services/transcript/procedures";
import { createTRPCRouter } from "~/server/api/trpc";

/**
 * PER-RESIDENT CORRECTIONS: admin and jcrc only. Every procedure names one
 * resident and one academic year, and the role is re-read live (I-5).
 *
 * This router holds the pieces that exist only for corrections (the unlock and
 * withhold switches, the history, manual CCA entries and the one-resident reads
 * and edits). The edits that already have a procedure elsewhere (roster
 * upsert, volunteer attendance save, award update/remove/restore/assign, JCRC
 * saveFor) are reused as they are: each runs the per-resident write guard.
 */
const managerProcedure = roleManagerProcedure.use(async ({ ctx, next }) => {
  await requireManager(ctx.db, ctx.session.user.userID);
  return next();
});

export const transcriptResidentRouter = createTRPCRouter({
  /** The status line: Draft / Published / Withheld, and whether it is unlocked. */
  panel: managerProcedure
    .input(residentScope)
    .query(({ ctx, input }) => residentPanel(ctx.db, input)),

  unlock: managerProcedure
    .input(unlockInput)
    .mutation(({ ctx, input }) =>
      unlockResident(ctx.db, ctx.session.user.userID, input),
    ),

  relock: managerProcedure
    .input(relockInput)
    .mutation(({ ctx, input }) =>
      relockResident(ctx.db, ctx.session.user.userID, input),
    ),

  withhold: managerProcedure
    .input(withholdInput)
    .mutation(({ ctx, input }) =>
      withholdResident(ctx.db, ctx.session.user.userID, input),
    ),

  release: managerProcedure
    .input(releaseInput)
    .mutation(({ ctx, input }) =>
      releaseResident(ctx.db, ctx.session.user.userID, input),
    ),

  history: managerProcedure
    .input(historyInput)
    .query(({ ctx, input }) => residentHistory(ctx.db, input)),

  /** CCA memberships: roster entries and manual entries. */
  memberships: createTRPCRouter({
    list: managerProcedure
      .input(manualListInput)
      .query(({ ctx, input }) => residentMemberships(ctx.db, input)),

    saveManual: managerProcedure
      .input(manualSaveInput)
      .mutation(({ ctx, input }) =>
        manualSave(ctx.db, ctx.session.user.userID, input),
      ),

    removeManual: managerProcedure
      .input(manualRefInput)
      .mutation(({ ctx, input }) =>
        manualRemove(ctx.db, ctx.session.user.userID, input),
      ),

    restoreManual: managerProcedure
      .input(manualRefInput)
      .mutation(({ ctx, input }) =>
        manualRestore(ctx.db, ctx.session.user.userID, input),
      ),
  }),

  /** The CCA activities the resident takes part in (of any CCA). */
  participation: createTRPCRouter({
    list: managerProcedure
      .input(residentScope)
      .query(({ ctx, input }) => participationList(ctx.db, input)),

    options: managerProcedure
      .input(activityOptionsInput)
      .query(({ ctx, input }) => activityOptions(ctx.db, input)),

    set: managerProcedure
      .input(participationSetInput)
      .mutation(({ ctx, input }) =>
        participationSet(ctx.db, ctx.session.user.userID, input),
      ),

    remove: managerProcedure
      .input(participationRemoveInput)
      .mutation(({ ctx, input }) =>
        participationRemove(ctx.db, ctx.session.user.userID, input),
      ),
  }),

  /** The resident's volunteer hours, a cell per session (saved with attendance.save). */
  volunteer: managerProcedure
    .input(residentScope)
    .query(({ ctx, input }) => volunteerOf(ctx.db, input)),

  /** The resident's awards for the year, removed ones on request. */
  awards: managerProcedure
    .input(awardsOfInput)
    .query(({ ctx, input }) => awardsOf(ctx.db, input)),

  /** The resident's JCRC page (saved with jcrc.saveFor). */
  jcrc: createTRPCRouter({
    get: managerProcedure.input(jcrcRefInput).query(async ({ ctx, input }) => {
      const resident = await requireResident(ctx.db, input.userID);
      return jcrcGet(ctx.db, resident.key, input.academicYear);
    }),

    remove: managerProcedure
      .input(jcrcRefInput)
      .mutation(({ ctx, input }) =>
        jcrcRemove(ctx.db, ctx.session.user.userID, input),
      ),

    restore: managerProcedure
      .input(jcrcRefInput)
      .mutation(({ ctx, input }) =>
        jcrcRestore(ctx.db, ctx.session.user.userID, input),
      ),
  }),
});
