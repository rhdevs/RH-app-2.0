import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { clientIp, rateLimit } from "~/lib/rateLimit";
import {
  currentAcademicYear,
  isValidAcademicYear,
} from "~/lib/transcript/academicYear";
import { assembleTranscript } from "~/lib/transcript/assemble";
import { canManageTranscriptPeriods } from "~/lib/transcript/permissions";
import { getUserRoles } from "~/server/api/services/access";
import {
  issueForResident,
  verifyCode,
} from "~/server/api/services/transcript/issue";
import { loadTranscriptInput } from "~/server/api/services/transcript/loader";
import {
  STATUS_PUBLISHED,
  getPeriod,
  listPeriods,
  publish,
  reopen,
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
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

const VERIFY_LIMIT = 30;
const VERIFY_WINDOW_MS = 10 * 60 * 1000;

export const transcriptRouter = createTRPCRouter({
  /**
   * Academic-year control. Publishing freezes the roster; reopening supersedes
   * every issued transcript of the year. Edits are locked while published
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
          input.sem2Start ? new Date(`${input.sem2Start}T00:00:00Z`) : null,
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
   * A manager's look at one resident's transcript. NEVER creates an issue. It
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
    /**
     * The signed-in resident's own transcript. The identity comes ONLY from the
     * session (`identifiedProcedure` guarantees a canonical userID); there is
     * no way to ask for anyone else's. While the year is collecting there is
     * nothing to download.
     */
    get: identifiedProcedure
      .input(z.object({ academicYear: academicYear.optional() }).optional())
      .query(async ({ ctx, input }) => {
        const year = input?.academicYear ?? currentAcademicYear(new Date());
        try {
          const issued = await issueForResident(
            ctx.db,
            ctx.session.user.userID,
            year,
          );
          return { status: "ready" as const, ...issued };
        } catch (error) {
          if (error instanceof TRPCError && error.message === "NOT_PUBLISHED") {
            return { status: "not_open" as const, academicYear: year };
          }
          throw error;
        }
      }),
  }),

  /**
   * PUBLIC. Anyone holding a paper copy may check a code, so it is
   * rate-limited per client IP with the repo's atomic limiter. Returns
   * valid | revoked | superseded | not_found and, for valid/superseded, the
   * issued record with the matric masked.
   */
  verify: publicProcedure
    .input(z.object({ code: z.string().max(64) }))
    .query(async ({ ctx, input }) => {
      const limited = await rateLimit(
        `transcript-verify:${clientIp(new Request("http://localhost", { headers: ctx.headers }))}`,
        VERIFY_LIMIT,
        VERIFY_WINDOW_MS,
      );
      if (!limited.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `RATE_LIMITED:${limited.retryAfter}`,
        });
      }
      return verifyCode(ctx.db, input.code);
    }),
});
