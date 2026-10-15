import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { rateLimit } from "~/lib/rateLimit";
import { currentAcademicYear } from "~/lib/transcript/academicYear";

import {
  academicYearInput,
  activityCreateInput,
  activityListInput,
  activityRefInput,
  activityUpdateInput,
  awardCreateInput,
  ccaIDInput,
  idInput,
  jcrcSaveForInput,
  jcrcSaveMineInput,
  participantsSetInput,
  rosterScope,
  rosterUpsertInput,
  searchQueryInput,
  userIDInput,
  volunteerCreateInput,
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
  requireCca,
  requireCcaAccess,
  requireJcrcSelf,
  requireManager,
  requireManagerOrHead,
} from "~/server/api/services/transcript/manageAccess";
import {
  awardCreate,
  awardVoid,
  awardsList,
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
  volunteerCreate,
  volunteerList,
  volunteerVoid,
} from "~/server/api/services/transcript/manageVolunteer";
import { searchResidents } from "~/server/api/services/transcript/residents";
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
 * EVERY WRITE to a year's data needs that year to be collecting
 * (`assertWritable`; PRECONDITION_FAILED once it is published). The one
 * exception is the volunteering tag, which belongs to no year.
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

  awards: createTRPCRouter({
    list: managerProcedure
      .input(
        z.object({
          academicYear: academicYearInput,
          userID: userIDInput.optional(),
          includeVoided: z.boolean().optional(),
        }),
      )
      .query(({ ctx, input }) =>
        awardsList(
          ctx.db,
          input.academicYear,
          input.userID,
          input.includeVoided ?? false,
        ),
      ),

    create: managerProcedure
      .input(awardCreateInput)
      .mutation(({ ctx, input }) =>
        awardCreate(ctx.db, ctx.session.user.userID, input),
      ),

    void: managerProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        awardVoid(ctx.db, ctx.session.user.userID, input.id),
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
        await assertCanEditCcaYear(
          ctx.db,
          { userID: ctx.session.user.userID },
          input.ccaID,
          input.academicYear,
        );
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
        const year = await activityYear(ctx.db, input.id, input.ccaID);
        await assertCanEditCcaYear(ctx.db, actor, input.ccaID, year);
        return participantsSet(ctx.db, actor.userID, input);
      }),
  }),

  volunteer: createTRPCRouter({
    list: identifiedProcedure
      .input(rosterScope)
      .query(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        return volunteerList(ctx.db, input.ccaID, input.academicYear);
      }),

    create: identifiedProcedure
      .input(volunteerCreateInput)
      .mutation(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        return volunteerCreate(ctx.db, ctx.session.user.userID, input);
      }),

    /** The head of the record's CCA, or a manager. */
    void: identifiedProcedure
      .input(idInput)
      .mutation(({ ctx, input }) =>
        volunteerVoid(ctx.db, ctx.session.user.userID, input.id),
      ),
  }),
});
