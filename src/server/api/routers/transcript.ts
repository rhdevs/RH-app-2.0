import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  currentAcademicYear,
  isRealIsoDate,
  isValidAcademicYear,
} from "~/lib/transcript/academicYear";
import { assembleTranscript } from "~/lib/transcript/assemble";
import { instantToSgDate, sgDateToInstant } from "~/lib/transcript/sgDate";
import { residentViewOf } from "~/lib/transcript/corrections";
import { normaliseYearStatus } from "~/lib/transcript/lifecycle";
import { canManageTranscriptPeriods } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import {
  actorLabels,
  requireResident,
} from "~/server/api/services/transcript/residents";
import {
  readiness,
  recordAccess,
} from "~/server/api/services/transcript/access";
import { isWithheld } from "~/server/api/services/transcript/residentManage";
import {
  listFreezes,
  unfreezeCca,
} from "~/server/api/services/transcript/freeze";
import { loadTranscriptInput } from "~/server/api/services/transcript/loader";
import {
  STATUS_CLOSED,
  STATUS_PUBLISHED,
  backToCollecting,
  closeYear,
  countUnfrozen,
  getPeriod,
  listPeriods,
  listViewableYears,
  publish,
  reopen,
  upsertDownloadBy,
  upsertSem2Start,
} from "~/server/api/services/transcript/periods";
import {
  createTRPCRouter,
  identifiedProcedure,
  roleManagerProcedure,
} from "~/server/api/trpc";

const academicYear = z
  .string()
  .max(16)
  .refine(isValidAcademicYear, "INVALID_ACADEMIC_YEAR");

/** "2027-01-11" -> midnight UTC, the instant the validators compare against. */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealIsoDate, "INVALID_DATE");

/**
 * The year-control surface: admin + jcrc.
 *
 * `roleManagerProcedure` answers "may you reach the manager surface" from the
 * session and narrows `userID` to non-null; the extra middleware answers "may
 * you do THIS" from a LIVE role read (I-5), so a manager demoted a minute ago
 * cannot publish on the strength of a stale session. scrc never gets past the
 * builder.
 */
const managerProcedure = roleManagerProcedure.use(async ({ ctx, next }) => {
  const roles = await getUserRoles(ctx.db, ctx.session.user.userID);
  if (!canManageTranscriptPeriods(roles)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "INSUFFICIENT_ROLE" });
  }
  return next();
});

export const transcriptRouter = createTRPCRouter({
  /**
   * Academic-year control: close (freezes every CCA not frozen yet), publish,
   * reopen for review, and back to collecting. See services/transcript/periods.ts.
   */
  periods: createTRPCRouter({
    list: managerProcedure.query(async ({ ctx }) => {
      const periods = await listPeriods(ctx.db);
      const label = await actorLabels(
        ctx.db,
        periods.flatMap((p) => [p.publishedBy, p.reopenedBy]),
      );
      return {
        currentAcademicYear: currentAcademicYear(new Date()),
        // Who published or reopened a year, as a name (the key only if no name).
        periods: periods.map((p) => ({
          ...p,
          publishedByName: label(p.publishedBy),
          reopenedByName: label(p.reopenedBy),
        })),
      };
    }),

    setSem2Start: managerProcedure
      .input(z.object({ academicYear, sem2Start: isoDate.nullable() }))
      .mutation(({ ctx, input }) =>
        upsertSem2Start(
          ctx.db,
          input.academicYear,
          input.sem2Start ? sgDateToInstant(input.sem2Start) : null,
        ),
      ),

    setDownloadBy: managerProcedure
      .input(z.object({ academicYear, downloadBy: isoDate.nullable() }))
      .mutation(({ ctx, input }) =>
        upsertDownloadBy(
          ctx.db,
          input.academicYear,
          input.downloadBy ? sgDateToInstant(input.downloadBy) : null,
        ),
      ),

    /** How many CCAs a Close year would freeze, for its confirmation. */
    unfrozenCount: managerProcedure
      .input(z.object({ academicYear }))
      .query(({ ctx, input }) => countUnfrozen(ctx.db, input.academicYear)),

    close: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) =>
        closeYear(ctx.db, input.academicYear, ctx.session.user.userID),
      ),

    publish: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) =>
        publish(ctx.db, input.academicYear, ctx.session.user.userID),
      ),

    /** Published -> closed (back to review). */
    reopen: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) =>
        reopen(ctx.db, input.academicYear, ctx.session.user.userID),
      ),

    backToCollecting: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) =>
        backToCollecting(ctx.db, input.academicYear, ctx.session.user.userID),
      ),
  }),

  /** Each CCA's member list for a year: frozen or not, and undoing a freeze. */
  freezes: createTRPCRouter({
    list: managerProcedure
      .input(z.object({ academicYear }))
      .query(({ ctx, input }) => listFreezes(ctx.db, input.academicYear)),

    unfreeze: managerProcedure
      .input(
        z.object({
          academicYear,
          ccaID: z.number().int().positive().max(1_000_000),
          reason: z.string().trim().min(3, "REQUIRED").max(500),
        }),
      )
      .mutation(({ ctx, input }) =>
        unfreezeCca(ctx.db, {
          ...input,
          actorUserID: ctx.session.user.userID,
        }),
      ),
  }),

  /**
   * A manager's look at one resident's transcript. Nothing is recorded. It is
   * assembled exactly as the resident's own is: each CCA's frozen list if it has
   * one, else its current list when this is its working year. The ONLY procedure that takes a userID
   * from the client, which is why it is manager-only.
   */
  preview: managerProcedure
    .input(z.object({ userID: z.string().min(1).max(100), academicYear }))
    .query(async ({ ctx, input }) => {
      const period = await getPeriod(ctx.db, input.academicYear);
      const data = await loadTranscriptInput(
        ctx.db,
        input.userID,
        input.academicYear,
        {},
      );
      const resident = await requireResident(ctx.db, input.userID);
      return {
        status: normaliseYearStatus(period?.status),
        // The resident sees "on hold" instead; the preview still shows the document.
        withheld: await isWithheld(ctx.db, input.academicYear, resident.key),
        transcript: assembleTranscript(data, input.academicYear, {
          draft: period?.status === STATUS_CLOSED,
        }),
      };
    }),

  mine: createTRPCRouter({
    /** The years a resident can open: published ones, and closed ones as drafts. */
    years: identifiedProcedure.query(({ ctx }) => listViewableYears(ctx.db)),

    /**
     * The signed-in resident's own transcript, assembled from the data on every
     * view. The identity comes ONLY from the session (`identifiedProcedure`
     * guarantees a canonical userID); there is no way to ask for anyone else's.
     * A collecting year has nothing to open; a closed one opens as a DRAFT; a
     * published one is the real thing, and opening it is noted in
     * TranscriptAccess, which drives the "Ready" badge.
     */
    get: identifiedProcedure
      .input(z.object({ academicYear: academicYear.optional() }).optional())
      .query(async ({ ctx, input }) => {
        const year = input?.academicYear ?? currentAcademicYear(new Date());
        const userID = ctx.session.user.userID;
        const period = await getPeriod(ctx.db, year);
        const status = normaliseYearStatus(period?.status);
        const view = residentViewOf(
          status,
          status !== "collecting" && (await isWithheld(ctx.db, year, userID)),
        );
        if (view === "not_open" || !period) {
          return { status: "not_open" as const, academicYear: year };
        }
        // A hold shows the resident nothing but the hold, draft or published,
        // and records no opening, so the Ready badge is not cleared either.
        if (view === "on_hold") {
          return { status: "on_hold" as const, academicYear: year };
        }
        const data = await loadTranscriptInput(ctx.db, userID, year, {});
        // While the year is closed this is a DRAFT: nothing is recorded as
        // opened (no Ready badge is cleared) and there is no download-by banner.
        if (status === "closed") {
          return {
            status: "ready" as const,
            draft: true as const,
            academicYear: year,
            transcript: assembleTranscript(data, year, { draft: true }),
            downloadBy: null,
          };
        }
        const transcript = assembleTranscript(data, year);
        await recordAccess(ctx.db, year, userID);
        return {
          status: "ready" as const,
          draft: false as const,
          academicYear: year,
          transcript,
          // A Singapore calendar date, "2027-12-31", or null.
          downloadBy: period.downloadBy
            ? instantToSgDate(period.downloadBy)
            : null,
        };
      }),

    /**
     * Is there a published year the resident has not opened yet? Cheap (two
     * small reads); drives the badge and the dot in the app header.
     */
    readiness: identifiedProcedure.query(({ ctx }) =>
      readiness(ctx.db, ctx.session.user.userID),
    ),
  }),
});
