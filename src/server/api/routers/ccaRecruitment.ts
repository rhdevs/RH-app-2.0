import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, roleManagerProcedure } from "~/server/api/trpc";
import { writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import {
  RECRUITMENT_FLAG_KEY,
  readRecruitmentRow,
  resetRecruitmentCache,
  type RecruitmentState,
} from "~/server/api/services/ccaRecruitment";

/**
 * The JCRC's hall-wide recruitment switch.
 *
 * A router of its own rather than more procedures in admin.ts (whose subject is
 * roles, and which is already ~4,000 lines) or in ccaAdmin.ts (adminProcedure
 * only and behind `cca.management.enabled`, so a jcrc could not reach their own
 * control there at all).
 *
 * Two procedures, both `roleManagerProcedure` (admin + jcrc) and both
 * ADDITIONALLY asserting `manageCcaRecruitment` against a LIVE role read. The
 * builder answers "may you reach this surface"; the capability answers "may you
 * do this thing" — the belt-and-braces shape every other admin surface in this
 * codebase uses. The live read is I-5: a manager demoted a minute ago must not
 * still be able to freeze the hall on the strength of a stale session.
 *
 * roleManagerProcedure also narrows `session.user.userID` to non-null as its
 * last middleware, so `ctx.session.user.userID` inside both bodies is a real
 * canonical id and never an absent identity being spent as if it were one. Do
 * NOT rebuild these on `protectedProcedure`.
 *
 * THE WRITE HERE IS THE ONLY WRITER of the `cca.recruitment` SystemFlag row
 * from application code. scripts/remediation/set-cca-recruitment.mjs is the
 * break-glass second one, and it stamps a `script:` prefix into `updatedBy` so
 * the two stay distinguishable on the panel.
 *
 * NOTE WHAT THIS ROUTER DOES NOT DO: it does not ENFORCE the freeze. The gate
 * is five calls to assertRecruitmentOpen in the applications routers — two in
 * ccaApplications.submitApplication and two in ccaApplications.bookSlot (each a
 * fail-fast check before withCcaLock plus the load-bearing one inside it), and
 * one on the accepted branch of ccaApplicationsHead.decide — and this router
 * cannot reach any of them. Holding `manageCcaRecruitment` lets you change the
 * flag; it does not exempt you from it.
 */
export const ccaRecruitmentRouter = createTRPCRouter({
  /**
   * Current state plus the context a JCRC needs to decide, in one round trip.
   *
   * Reads the row UNCACHED (readRecruitmentRow, not isRecruitmentOpen): the
   * panel must show what is STORED, or a JCRC who clicks Stop watches the card
   * say OPEN for fifteen seconds and concludes the button is broken. The
   * propagation delay across the other lambdas is real and is stated in the
   * panel's copy instead of hidden.
   *
   * The counts are hall-wide and unfiltered by CCA — they answer "how much is
   * in flight right now", which is the number that makes a freeze decision
   * different from a coin flip. Four collection counts, cheap enough to run on
   * every load of one admin screen; do NOT grow this into a per-CCA breakdown
   * without moving it to its own procedure.
   */
  status: roleManagerProcedure.query(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    const roles = await getUserRoles(ctx.db, userID); // I-5 live read
    if (!computeCapabilities(roles).manageCcaRecruitment) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "CAPABILITY_REQUIRED:manageCcaRecruitment",
      });
    }

    const [row, submitted, scheduled, interviewed, ccaCount] =
      await Promise.all([
        readRecruitmentRow(ctx.db),
        ctx.db.ccaApplication.count({ where: { status: "submitted" } }),
        ctx.db.ccaApplication.count({
          where: { status: "interview_scheduled" },
        }),
        ctx.db.ccaApplication.count({ where: { status: "interviewed" } }),
        ctx.db.cCA.count(),
      ]);

    // `updatedBy` is a canonical userID (E-format, or an EXT pin) when a human
    // flipped it, and a `script:...` literal when the break-glass script did.
    // Resolve only the former, and only to a DISPLAY NAME — the same
    // guess-the-email approach cca.listHeads uses, because there is no reverse
    // canonical->User index and the canonical id is derived from the address.
    //
    // The startsWith("script:") test is what keeps the `:` charset invariant
    // load-bearing here: a canonical id can never contain a colon, so a
    // `script:` value can never collide with a real person's key.
    let updatedByName: string | null = null;
    if (row.updatedBy && !row.updatedBy.startsWith("script:")) {
      const u = await ctx.db.user.findFirst({
        where: {
          OR: [
            {
              email: {
                equals: `${row.updatedBy.toLowerCase()}@u.nus.edu`,
                mode: "insensitive",
              },
            },
            { userID: row.updatedBy },
          ],
        },
        // NEVER a bare User read — passwordHash must not be selected (I-2).
        select: { displayName: true },
      });
      updatedByName = u?.displayName ?? null;
    }

    return {
      state: row.state,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      updatedByName,
      flagKey: RECRUITMENT_FLAG_KEY,
      counts: {
        submitted,
        scheduled,
        interviewed,
        /** Everything non-terminal — the number the confirm dialog quotes. */
        openApplications: submitted + scheduled + interviewed,
        ccas: ccaCount,
      },
    };
  }),

  /**
   * Flip the switch.
   *
   * Idempotent: setting the state it already holds rewrites the row and writes
   * an audit line, which is correct — "the JCRC re-confirmed the freeze at
   * 14:02" is a fact worth having, and refusing a no-op would make the button's
   * failure mode depend on a race with another manager holding the same tab
   * open.
   */
  setState: roleManagerProcedure
    .input(
      z.object({
        state: z.enum(["open", "closed"]),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      // I-5: the ACTOR's roles come from the database, not the session, so a
      // manager demoted a minute ago cannot still freeze the hall.
      const roles = await getUserRoles(ctx.db, actorUserID);
      if (!computeCapabilities(roles).manageCcaRecruitment) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "CAPABILITY_REQUIRED:manageCcaRecruitment",
        });
      }

      const state: RecruitmentState = input.state;
      const now = new Date();

      // A plain Prisma upsert, exactly as admin.setEnforcementMode does on the
      // same collection. Safe HERE where a userCCA.create would not be:
      // SystemFlag carries NO $jsonSchema validator (see prisma/schema.prisma's
      // model comment) and has no Int field, so neither the silent code-121
      // rejection nor the long-vs-int32 trap that forces $runCommandRaw on
      // UserCCA applies. Do not copy this shape onto a validated collection.
      await ctx.db.systemFlag.upsert({
        where: { key: RECRUITMENT_FLAG_KEY },
        create: {
          key: RECRUITMENT_FLAG_KEY,
          value: state,
          updatedAt: now,
          updatedBy: actorUserID,
        },
        update: { value: state, updatedAt: now, updatedBy: actorUserID },
      });

      // Drop THIS lambda's cache so the operator's own next request — including
      // the `status` refetch the panel fires immediately after — sees the new
      // state without waiting out the TTL. It does NOTHING for the other
      // lambdas: they carry their own 15s cache, and that window is accepted
      // and stated in the UI copy. Do not mistake this for a global
      // invalidation, and do not shorten FLAG_TTL_MS to "fix" it — the number
      // is shared reasoning across five services.
      resetRecruitmentCache();

      // Audited AFTER the write, and on `ctx.db` rather than any transaction
      // client (I-15). `rolesAfter` carries the new state because RoleAuditLog
      // has no column for a flag value — the same squeeze admin.setEnforcementMode
      // makes. No targetCcaID: the switch is hall-wide.
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaRecruitment.set",
        rolesAfter: [state],
        reason: input.reason,
      });

      return { state, updatedAt: now };
    }),
});
