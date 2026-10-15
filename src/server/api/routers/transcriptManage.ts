import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { rateLimit } from "~/lib/rateLimit";

import {
  academicYearInput,
  awardCreateInput,
  ccaIDInput,
  idInput,
  jcrcSaveForInput,
  jcrcSaveMineInput,
  rosterScope,
  rosterUpsertInput,
  searchQueryInput,
  userIDInput,
  volunteerCreateInput,
} from "~/lib/transcript/manageInput";
import {
  requireCca,
  requireCcaAccess,
  requireJcrcSelf,
  requireManager,
  requireManagerOrVolunteeringHead,
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
    /** A manager, or the head of a volunteering CCA (to log hours for anyone). */
    search: identifiedProcedure
      .input(z.object({ query: searchQueryInput }))
      .query(async ({ ctx, input }) => {
        const userID = ctx.session.user.userID;
        const access = await requireManagerOrVolunteeringHead(ctx.db, userID);
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
        const [list, profile] = await Promise.all([
          rosterList(ctx.db, input.ccaID, input.academicYear),
          ctx.db.ccaProfile.findUnique({
            where: { ccaID: input.ccaID },
            select: { isVolunteering: true },
          }),
        ]);
        return { ...list, isVolunteering: profile?.isVolunteering === true };
      }),

    upsert: identifiedProcedure
      .input(rosterUpsertInput)
      .mutation(async ({ ctx, input }) => {
        await requireCcaAccess(ctx.db, ctx.session.user.userID, input.ccaID);
        await requireCca(ctx.db, input.ccaID);
        return rosterUpsert(ctx.db, ctx.session.user.userID, input);
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
