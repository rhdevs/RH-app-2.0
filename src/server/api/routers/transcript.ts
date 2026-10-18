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
import {
  isBeforeFirstYear,
  isLater,
  normaliseYearStatus,
} from "~/lib/transcript/lifecycle";
import { userIDInput } from "~/lib/transcript/manageInput";
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
import { listFreezes } from "~/server/api/services/transcript/freeze";
import { loadTranscriptInput } from "~/server/api/services/transcript/loader";
import {
  getPeriod,
  listPeriods,
  listPublishedYears,
  openTranscripts,
  upsertDownloadBy,
} from "~/server/api/services/transcript/periods";
// The repo's builders with the transcript kill switch added (procedures.ts).
import {
  transcriptIdentifiedProcedure as identifiedProcedure,
  transcriptRoleManagerProcedure as roleManagerProcedure,
} from "~/server/api/services/transcript/procedures";
import { createTRPCRouter } from "~/server/api/trpc";

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
   * Academic-year control, one step: Open transcripts (locks every CCA's
   * member list for the year, then opens it to residents). See
   * services/transcript/periods.ts.
   */
  periods: createTRPCRouter({
    list: managerProcedure.query(async ({ ctx }) => {
      const periods = await listPeriods(ctx.db);
      const label = await actorLabels(
        ctx.db,
        periods.map((p) => p.publishedBy),
      );
      return {
        currentAcademicYear: currentAcademicYear(new Date()),
        // Who opened a year, as a name (the key only if no name).
        periods: periods.map((p) => ({
          ...p,
          publishedByName: label(p.publishedBy),
        })),
      };
    }),

    setDownloadBy: managerProcedure
      .input(z.object({ academicYear, downloadBy: isoDate.nullable() }))
      .mutation(({ ctx, input }) =>
        upsertDownloadBy(
          ctx.db,
          input.academicYear,
          input.downloadBy ? sgDateToInstant(input.downloadBy) : null,
        ),
      ),

    /**
     * OPEN TRANSCRIPTS: locks every CCA's member list for the year as it is,
     * then opens the year to residents. If any CCA fails, the year stays
     * collecting and the failures are returned; running it again finishes.
     * Only the CURRENT academic year: refused here, and again by openBlocker
     * inside openTranscripts.
     */
    open: managerProcedure
      .input(z.object({ academicYear }))
      .mutation(({ ctx, input }) => {
        const now = new Date();
        const current = currentAcademicYear(now);
        // A year before transcripts began gets its own refusal from the service.
        if (
          input.academicYear !== current &&
          !isBeforeFirstYear(input.academicYear)
        ) {
          const code = isLater(input.academicYear, current)
            ? "YEAR_NOT_STARTED"
            : "YEAR_ENDED";
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: code });
        }
        return openTranscripts(
          ctx.db,
          input.academicYear,
          ctx.session.user.userID,
          now,
        );
      }),
  }),

  /** Each CCA's member list for a year: whether it was saved when it opened. */
  freezes: createTRPCRouter({
    list: managerProcedure
      .input(z.object({ academicYear }))
      .query(({ ctx, input }) => listFreezes(ctx.db, input.academicYear)),
  }),

  /**
   * A manager's look at one resident's transcript. Nothing is recorded. It is
   * assembled exactly as the resident's own is: the locked lists once the year
   * is open, else each CCA's current list. Manager-only. It is NOT the only
   * procedure that takes a userID from the client: heads name residents in
   * roster.upsert, participants.set, volunteer.people.set and
   * volunteer.attendance.save, and managers in corrections.*, awards.assign,
   * jcrc.saveFor and the award import. Every one is validated: `userIDInput`
   * (only the characters a canonical key can have; the import's identifiers go
   * through the bulk importer's own resolver instead), then resolved on the
   * server to the resident's canonical key (or refused), and checked against
   * the caller's rights for that CCA and year.
   */
  preview: managerProcedure
    .input(z.object({ userID: userIDInput, academicYear }))
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
        transcript: assembleTranscript(data, input.academicYear),
      };
    }),

  mine: createTRPCRouter({
    /** The years a resident can open: the published (open) ones. */
    years: identifiedProcedure.query(({ ctx }) => listPublishedYears(ctx.db)),

    /**
     * The signed-in resident's own transcript, assembled from the data on every
     * view. The identity comes ONLY from the session (`identifiedProcedure`
     * guarantees a canonical userID); there is no way to ask for anyone else's.
     * A collecting year has nothing to open; a published (open) one is the
     * transcript. This is a read: it writes nothing (see `markOpened`).
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
        // A hold shows the resident nothing but the hold, and records no
        // opening, so the Ready badge is not cleared either.
        if (view === "on_hold") {
          return { status: "on_hold" as const, academicYear: year };
        }
        const data = await loadTranscriptInput(ctx.db, userID, year, {});
        const transcript = assembleTranscript(data, year);
        // Reading never writes: noting the opening is `markOpened`, a mutation.
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
     * The resident has the transcript on screen: note it in TranscriptAccess,
     * which drives the "Ready" badge. Identity comes only from the session. Only
     * an open (published) year that is not on hold is noted.
     */
    markOpened: identifiedProcedure
      .input(z.object({ academicYear }))
      .mutation(async ({ ctx, input }) => {
        const userID = ctx.session.user.userID;
        const period = await getPeriod(ctx.db, input.academicYear);
        if (normaliseYearStatus(period?.status) !== "published") {
          return { recorded: false as const };
        }
        if (await isWithheld(ctx.db, input.academicYear, userID)) {
          return { recorded: false as const };
        }
        await recordAccess(ctx.db, input.academicYear, userID);
        return { recorded: true as const };
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
