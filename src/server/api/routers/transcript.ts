import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  currentAcademicYear,
  isRealIsoDate,
  isValidAcademicYear,
} from "~/lib/transcript/academicYear";
import { assembleTranscript } from "~/lib/transcript/assemble";
import { instantToSgDate, sgDateToInstant } from "~/lib/transcript/sgDate";
import { canManageTranscriptPeriods } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import {
  readiness,
  recordAccess,
} from "~/server/api/services/transcript/access";
import { loadTranscriptInput } from "~/server/api/services/transcript/loader";
import {
  STATUS_PUBLISHED,
  getPeriod,
  listPeriods,
  listPublishedYears,
  publish,
  reopen,
  upsertDownloadBy,
  upsertSem2Start,
} from "~/server/api/services/transcript/periods";
import {
  createTRPCRouter,
  identifiedProcedure,
  publicProcedure,
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
   * Academic-year control. Publishing freezes the roster; reopening is a plain
   * status change. Edits are locked while published
   * (services/transcript/periods.ts `assertCollecting`).
   */
  periods: createTRPCRouter({
    list: managerProcedure.query(async ({ ctx }) => {
      return {
        currentAcademicYear: currentAcademicYear(new Date()),
        periods: await listPeriods(ctx.db),
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

    publish: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) =>
        publish(ctx.db, input.academicYear, ctx.session.user.userID),
      ),

    reopen: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) =>
        reopen(ctx.db, input.academicYear, ctx.session.user.userID),
      ),
  }),

  /**
   * A manager's look at one resident's transcript. Nothing is recorded. It
   * shows what the resident will get: the frozen roster once the year is
   * published, the live roster before. The ONLY procedure that takes a userID
   * from the client, which is why it is manager-only.
   */
  preview: managerProcedure
    .input(z.object({ userID: z.string().min(1).max(100), academicYear }))
    .query(async ({ ctx, input }) => {
      const period = await getPeriod(ctx.db, input.academicYear);
      const mode = period?.status === STATUS_PUBLISHED ? "frozen" : "live";
      const data = await loadTranscriptInput(
        ctx.db,
        input.userID,
        input.academicYear,
        { mode },
      );
      return {
        mode,
        transcript: assembleTranscript(data, input.academicYear),
      };
    }),

  mine: createTRPCRouter({
    /** Which academic years are open to download. Names only. */
    years: identifiedProcedure.query(({ ctx }) => listPublishedYears(ctx.db)),

    /**
     * The signed-in resident's own transcript, assembled from the data on every
     * view. The identity comes ONLY from the session (`identifiedProcedure`
     * guarantees a canonical userID); there is no way to ask for anyone else's.
     * While the year is not published there is nothing to open. A ready view is
     * noted in TranscriptAccess, which drives the "Ready" badge.
     */
    get: identifiedProcedure
      .input(z.object({ academicYear: academicYear.optional() }).optional())
      .query(async ({ ctx, input }) => {
        const year = input?.academicYear ?? currentAcademicYear(new Date());
        const userID = ctx.session.user.userID;
        const period = await getPeriod(ctx.db, year);
        if (period?.status !== STATUS_PUBLISHED) {
          return { status: "not_open" as const, academicYear: year };
        }
        const data = await loadTranscriptInput(ctx.db, userID, year, {
          mode: "frozen",
        });
        const transcript = assembleTranscript(data, year);
        await recordAccess(ctx.db, year, userID);
        return {
          status: "ready" as const,
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
