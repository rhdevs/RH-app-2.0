import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { rateLimit } from "~/lib/rateLimit";
import {
  awardImportCommitInput,
  awardImportPreviewInput,
} from "~/lib/transcript/awardImport";
import { currentAcademicYear } from "~/lib/transcript/academicYear";

import {
  academicYearInput,
  activityCreateInput,
  activityListInput,
  activityRefInput,
  activityUpdateInput,
  awardBatchUndoInput,
  awardBatchesListInput,
  awardTypeCreateInput,
  awardTypeUpdateInput,
  awardTypesListInput,
  awardUpdateInput,
  awardsAssignInput,
  awardsBulkInput,
  awardsListInput,
  ccaIDInput,
  idInput,
  jcrcSaveForInput,
  jcrcSaveMineInput,
  participantsSetInput,
  rosterScope,
  rosterUpsertInput,
  searchQueryInput,
  userIDInput,
  volunteerActivityCreateInput,
  volunteerActivityRefInput,
  volunteerActivityUpdateInput,
  volunteerAttendanceSaveInput,
  volunteerPeopleSetInput,
  volunteerSessionAddInput,
  volunteerSessionRefInput,
  volunteerSessionUpdateInput,
} from "~/lib/transcript/manageInput";
import {
  activitiesList,
  activityCreate,
  activityRemove,
  activityRestore,
  activityUpdate,
  activityYear,
  participantsSet,
} from "~/server/api/services/transcript/activities";
import {
  assertCanEditCcaYear,
  editRefusalFor,
} from "~/server/api/services/transcript/editRights";
import { freezeCca, termYearOf } from "~/server/api/services/transcript/freeze";
import {
  awardImportCommit,
  awardImportPreview,
} from "~/server/api/services/transcript/awardImport";
import {
  awardBatchUndo,
  awardBatchesList,
  awardRemove,
  awardRestore,
  awardTypeArchive,
  awardTypeCreate,
  awardTypeRestore,
  awardTypeUpdate,
  awardTypesList,
  awardUpdate,
  awardsAssign,
  awardsBulkRemove,
  awardsBulkRestore,
  awardsList,
} from "~/server/api/services/transcript/manageAwards";
import {
  requireCca,
  requireCcaAccess,
  requireJcrcSelf,
  requireManager,
  requireManagerOrHead,
} from "~/server/api/services/transcript/manageAccess";
import {
  ccaTagsList,
  jcrcGet,
  jcrcSave,
  jcrcSaveFor,
  setVolunteering,
} from "~/server/api/services/transcript/manageRecords";
import {
  rosterList,
  rosterUpsert,
} from "~/server/api/services/transcript/manageRoster";
import {
  volunteerActivitiesList,
  volunteerActivityCreate,
  volunteerActivityGet,
  volunteerActivityRemove,
  volunteerActivityRestore,
  volunteerActivityUpdate,
  volunteerAttendanceSave,
  volunteerPeopleSet,
  volunteerSessionAdd,
  volunteerSessionRemove,
  volunteerSessionRestore,
  volunteerSessionUpdate,
} from "~/server/api/services/transcript/manageVolunteer";
import { searchResidents } from "~/server/api/services/transcript/residents";
import { transcriptResidentRouter } from "./transcriptResident";
import {
  createTRPCRouter,
  identifiedProcedure,
  roleManagerProcedure,
} from "~/server/api/trpc";

/**
 * Transcript MANAGEMENT: the edits behind the head, JCRC and admin screens.
 * Opening, publishing and issuing live in the `transcript` router.
 *
 * THREE KINDS OF CALLER, each decided from a LIVE role read (I-5):
 *  - manager (admin or jcrc): `roleManagerProcedure` reaches the surface and
 *    `requireManager` re-checks live. Awards, JCRC records for anyone,
 *    volunteering tags, resident search.
 *  - a head of THIS CCA, or a manager: `identifiedProcedure` plus
 *    `requireCcaAccess` (assertHeadsCca). The scope-free `cca_head` role string
 *    is never used; the head of another CCA gets FORBIDDEN.
 *  - a JCRC member, for their OWN record: `identifiedProcedure` plus
 *    `requireJcrcSelf`. The identity is the session's; no userID is accepted.
 *
 * EVERY WRITE to a year's data runs one guard: `assertCanEditCcaYear` for a
 * CCA's own records, or `assertCanEditForResidents` for a write that names
 * residents (a published year then only for a manager correcting UNLOCKED
 * residents). The volunteering tag belongs to no year.
 */
/** Resident search: 60 requests per signed-in user per 10 minutes. */
const SEARCH_LIMIT = 60;
const SEARCH_WINDOW_MS = 10 * 60 * 1000;

const managerProcedure = roleManagerProcedure.use(async ({ ctx, next }) => {
  await requireManager(ctx.db, ctx.session.user.userID);
  return next();
});

export const transcriptManageRouter = createTRPCRouter({
  ccaTags: createTRPCRouter({
    list: managerProcedure.query(({ ctx }) => ccaTagsList(ctx.db)),

    setVolunteering: managerProcedure
      .input(z.object({ ccaID: ccaIDInput, isVolunteering: z.boolean() }))
      .mutation(({ ctx, input }) =>
        setVolunteering(
          ctx.db,
          ctx.session.user.userID,
          input.ccaID,
          input.isVolunteering,
        ),
      ),
  }),

  /** The award catalogue: not year-bound, so no year check. */
  awardTypes: createTRPCRouter({
    list: managerProcedure
      .input(awardTypesListInput)
      .query(({ ctx, input }) =>
        awardTypesList(ctx.db, input.includeArchived ?? false),
      ),

    create: managerProcedure
      .input(awardTypeCreateInput)
      .mutation(({ ctx, input }) =>
        awardTypeCreate(ctx.db, ctx.session.user.userID, input),
      ),

    update: managerProcedure
      .input(awardTypeUpdateInput)
      .mutation(({ ctx, input }) =>
        awardTypeUpdate(ctx.db, ctx.session.user.userID, input),
      ),

    archive: managerProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        awardTypeArchive(ctx.db, ctx.session.user.userID, input.id),
      ),

    restore: managerProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        awardTypeRestore(ctx.db, ctx.session.user.userID, input.id),
      ),
  }),

  /** Awards of a year. Every write needs the year not to be published. */
  awards: createTRPCRouter({
    list: managerProcedure
      .input(awardsListInput)
      .query(({ ctx, input }) => awardsList(ctx.db, input)),

    assign: managerProcedure
      .input(awardsAssignInput)
      .mutation(({ ctx, input }) =>
        awardsAssign(ctx.db, ctx.session.user.userID, input),
      ),

    update: managerProcedure
      .input(awardUpdateInput)
      .mutation(({ ctx, input }) =>
        awardUpdate(ctx.db, ctx.session.user.userID, input),
      ),

    remove: managerProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        awardRemove(ctx.db, ctx.session.user.userID, input.id),
      ),

    restore: managerProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        awardRestore(ctx.db, ctx.session.user.userID, input.id),
      ),

    bulkRemove: managerProcedure
      .input(awardsBulkInput)
      .mutation(({ ctx, input }) =>
        awardsBulkRemove(ctx.db, ctx.session.user.userID, input.ids),
      ),

    bulkRestore: managerProcedure
      .input(awardsBulkInput)
      .mutation(({ ctx, input }) =>
        awardsBulkRestore(ctx.db, ctx.session.user.userID, input.ids),
      ),
  }),

  /** The awards CSV import: preview, then commit (which re-checks everything). */
  awardImport: createTRPCRouter({
    preview: managerProcedure
      .input(awardImportPreviewInput)
      .mutation(({ ctx, input }) => awardImportPreview(ctx.db, input)),

    commit: managerProcedure
      .input(awardImportCommitInput)
      .mutation(({ ctx, input }) =>
        awardImportCommit(ctx.db, ctx.session.user.userID, input),
      ),
  }),

  /** Uploads of awards, so one can be undone as a whole. */
  awardBatches: createTRPCRouter({
    list: managerProcedure
      .input(awardBatchesListInput)
      .query(({ ctx, input }) => awardBatchesList(ctx.db, input.academicYear)),

    undo: managerProcedure
      .input(awardBatchUndoInput)
      .mutation(({ ctx, input }) =>
        awardBatchUndo(ctx.db, ctx.session.user.userID, input.batchId),
      ),
  }),

  jcrc: createTRPCRouter({
    /** A manager saves anyone's JCRC record. */
    saveFor: managerProcedure
      .input(jcrcSaveForInput)
      .mutation(({ ctx, input }) =>
        jcrcSaveFor(ctx.db, ctx.session.user.userID, input),
      ),

    /** A JCRC member's own record, for the year. */
    mine: identifiedProcedure
      .input(z.object({ academicYear: academicYearInput }))
      .query(async ({ ctx, input }) => {
        await requireJcrcSelf(ctx.db, ctx.session.user.userID);
        return jcrcGet(ctx.db, ctx.session.user.userID, input.academicYear);
      }),

    /** Save your own. Blocked once the year is published. */
    saveMine: identifiedProcedure
      .input(jcrcSaveMineInput)
      .mutation(async ({ ctx, input }) => {
        await requireJcrcSelf(ctx.db, ctx.session.user.userID);
        const me = ctx.session.user.userID;
        return jcrcSave(ctx.db, me, me, input);
      }),
  }),

  /** Per-resident corrections (admin and jcrc): see transcriptResident.ts. */
  corrections: transcriptResidentRouter,

  residents: createTRPCRouter({
    /** A manager, or the head of any CCA (hours for anyone, activity participants). */
    search: identifiedProcedure
      .input(z.object({ query: searchQueryInput }))
      .query(async ({ ctx, input }) => {
        const userID = ctx.session.user.userID;
        const access = await requireManagerOrHead(ctx.db, userID);
        const limited = await rateLimit(
          `transcript-search:${userID}`,
          SEARCH_LIMIT,
          SEARCH_WINDOW_MS,
        );
        if (!limited.allowed) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `RATE_LIMITED:${limited.retryAfter}`,
          });
        }
        return searchResidents(ctx.db, input.query, {
          nameOnly: !access.isManager,
        });
      }),
  }),

  roster: createTRPCRouter({
    list: identifiedProcedure
      .input(rosterScope)
      .query(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        const [list, refusal, profile] = await Promise.all([
          rosterList(ctx.db, input.ccaID, input.academicYear),
          editRefusalFor(
            ctx.db,
            ctx.session.user.userID,
            input.ccaID,
            input.academicYear,
          ),
          ctx.db.ccaProfile.findUnique({
            where: { ccaID: input.ccaID },
            select: { isVolunteering: true },
          }),
        ]);
        return {
          ...list,
          isVolunteering: profile?.isVolunteering === true,
          // Why this person cannot edit the year (null when they can).
          editRefusal: refusal,
        };
      }),

    /** The year this CCA is working on, for the handover warning and the tab. */
    term: identifiedProcedure
      .input(z.object({ ccaID: ccaIDInput }))
      .query(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        const now = new Date();
        return {
          termAcademicYear: await termYearOf(ctx.db, input.ccaID, now),
          currentAcademicYear: currentAcademicYear(now),
        };
      }),

    /** Head (or manager) locks the member list early. Edits stay open until close. */
    lock: identifiedProcedure
      .input(z.object({ ccaID: ccaIDInput }))
      .mutation(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        return freezeCca(ctx.db, {
          ccaID: input.ccaID,
          reason: "lock",
          actorUserID: ctx.session.user.userID,
        });
      }),

    upsert: identifiedProcedure
      .input(rosterUpsertInput)
      .mutation(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        // The edit guard runs inside, once the member is known.
        return rosterUpsert(ctx.db, ctx.session.user.userID, input);
      }),
  }),

  /**
   * A CCA's activities for a year, and who took part. Same access as the roster
   * (the head of THIS CCA or a manager); every write runs the one edit guard, on
   * the year the activity belongs to.
   */
  activities: createTRPCRouter({
    list: identifiedProcedure
      .input(activityListInput)
      .query(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        return activitiesList(
          ctx.db,
          input.ccaID,
          input.academicYear,
          input.includeRemoved ?? false,
        );
      }),

    create: identifiedProcedure
      .input(activityCreateInput)
      .mutation(async ({ ctx, input }) => {
        const actor = { userID: ctx.session.user.userID };
        await requireCcaAccess(ctx.db, actor.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        await assertCanEditCcaYear(
          ctx.db,
          actor,
          input.ccaID,
          input.academicYear,
        );
        return activityCreate(ctx.db, actor.userID, input);
      }),

    update: identifiedProcedure
      .input(activityUpdateInput)
      .mutation(async ({ ctx, input }) => {
        const actor = { userID: ctx.session.user.userID };
        await requireCcaAccess(ctx.db, actor.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        const year = await activityYear(ctx.db, input.id, input.ccaID);
        await assertCanEditCcaYear(ctx.db, actor, input.ccaID, year);
        return activityUpdate(ctx.db, actor.userID, input);
      }),

    /** Soft: the activity leaves every transcript but can be restored. */
    remove: identifiedProcedure
      .input(activityRefInput)
      .mutation(async ({ ctx, input }) => {
        const actor = { userID: ctx.session.user.userID };
        await requireCcaAccess(ctx.db, actor.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        const year = await activityYear(ctx.db, input.id, input.ccaID);
        await assertCanEditCcaYear(ctx.db, actor, input.ccaID, year);
        return activityRemove(ctx.db, actor.userID, input.id, input.ccaID);
      }),

    restore: identifiedProcedure
      .input(activityRefInput)
      .mutation(async ({ ctx, input }) => {
        const actor = { userID: ctx.session.user.userID };
        await requireCcaAccess(ctx.db, actor.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        const year = await activityYear(ctx.db, input.id, input.ccaID);
        await assertCanEditCcaYear(ctx.db, actor, input.ccaID, year);
        return activityRestore(ctx.db, actor.userID, input.id, input.ccaID);
      }),
  }),

  participants: createTRPCRouter({
    /** Replace the activity's participants with exactly this list. */
    set: identifiedProcedure
      .input(participantsSetInput)
      .mutation(async ({ ctx, input }) => {
        const actor = { userID: ctx.session.user.userID };
        await requireCcaAccess(ctx.db, actor.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        // The edit guard runs inside, on the residents the change touches.
        return participantsSet(ctx.db, actor.userID, input);
      }),
  }),

  /**
   * Volunteer hours, by ACTIVITY: an activity has sessions, people and a tick
   * (attendance) for each person in each session. Reads need the head of THIS
   * CCA or a manager; every write runs the one edit guard for the activity's own
   * year and needs the CCA to be tagged as volunteering (see manageVolunteer).
   */
  volunteer: createTRPCRouter({
    activities: createTRPCRouter({
      list: identifiedProcedure
        .input(activityListInput)
        .query(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerActivitiesList(
            ctx.db,
            input.ccaID,
            input.academicYear,
            input.includeRemoved ?? false,
          );
        }),

      /** One activity with its sessions, people and ticks, for the grid. */
      get: identifiedProcedure
        .input(volunteerActivityRefInput)
        .query(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerActivityGet(ctx.db, input.id, input.ccaID);
        }),

      create: identifiedProcedure
        .input(volunteerActivityCreateInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerActivityCreate(
            ctx.db,
            ctx.session.user.userID,
            input,
          );
        }),

      update: identifiedProcedure
        .input(volunteerActivityUpdateInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerActivityUpdate(
            ctx.db,
            ctx.session.user.userID,
            input,
          );
        }),

      remove: identifiedProcedure
        .input(volunteerActivityRefInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerActivityRemove(
            ctx.db,
            ctx.session.user.userID,
            input.id,
            input.ccaID,
          );
        }),

      restore: identifiedProcedure
        .input(volunteerActivityRefInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerActivityRestore(
            ctx.db,
            ctx.session.user.userID,
            input.id,
            input.ccaID,
          );
        }),
    }),

    /** Sessions of a regular activity (a one-off has exactly one). */
    sessions: createTRPCRouter({
      add: identifiedProcedure
        .input(volunteerSessionAddInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerSessionAdd(ctx.db, ctx.session.user.userID, input);
        }),

      update: identifiedProcedure
        .input(volunteerSessionUpdateInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerSessionUpdate(ctx.db, ctx.session.user.userID, input);
        }),

      remove: identifiedProcedure
        .input(volunteerSessionRefInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerSessionRemove(
            ctx.db,
            ctx.session.user.userID,
            input.sessionID,
            input.ccaID,
          );
        }),

      restore: identifiedProcedure
        .input(volunteerSessionRefInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerSessionRestore(
            ctx.db,
            ctx.session.user.userID,
            input.sessionID,
            input.ccaID,
          );
        }),
    }),

    people: createTRPCRouter({
      /** Replace the activity's people with exactly this list. */
      set: identifiedProcedure
        .input(volunteerPeopleSetInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerPeopleSet(ctx.db, ctx.session.user.userID, input);
        }),
    }),

    attendance: createTRPCRouter({
      /** A batch of ticks and un-ticks, applied in one transaction. */
      save: identifiedProcedure
        .input(volunteerAttendanceSaveInput)
        .mutation(async ({ ctx, input }) => {
          await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
          await requireCca(ctx.db, input.ccaID);
          return volunteerAttendanceSave(
            ctx.db,
            ctx.session.user.userID,
            input,
          );
        }),
    }),
  }),
});
