import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import {
  createTRPCRouter,
  identifiedProcedure,
  requireMatric,
} from "~/server/api/trpc";
import { writeAudit } from "~/server/api/routers/admin";
import { membershipKeysFor } from "~/server/api/services/ccaMembers";
import { canonicalUserID } from "~/lib/identity";
import {
  APPLICATION_COUNTER_KEY,
  assertApplicationsEnabled,
  nextCounter,
  withCcaLock,
} from "~/server/api/services/ccaApplications";
import {
  applyInput,
  applicationTargetInput,
  bookSlotInput,
  ccaTargetInput,
  isTerminalStatus,
} from "~/lib/schemas/ccaApplication";

/**
 * Resident-facing side of the CCA membership-application workflow.
 *
 * Every procedure is `identifiedProcedure` (a non-null canonical userID is the
 * applicant key) and asserts `cca.applications.enabled` first — the whole
 * surface is inert until that switch is on. Unlike cca.ts these are NOT
 * object-scoped by headship: a resident acts on THEIR OWN applications, so the
 * guard is OWNERSHIP (app.userID === caller), and a mismatch returns NOT_FOUND
 * rather than FORBIDDEN so an applicationID is not an existence oracle.
 *
 * The head-facing half (review, open slots, decide) lives in
 * ccaApplicationsHead.ts, guarded by assertHeadsCca — the same split, and for
 * the same reason, as cca.ts vs ccaAdmin.ts.
 *
 * Times are UNIX epoch SECONDS (Int), matching Bookings and CcaInterviewSlot.
 */

/** Load the caller's own application, or 404 — never leak another's existence. */
async function ownApplicationOr404(
  db: PrismaClient,
  applicationID: number,
  userID: string,
) {
  const app = await db.ccaApplication.findUnique({
    where: { applicationID },
    select: {
      applicationID: true,
      ccaID: true,
      userID: true,
      status: true,
      interviewSlotID: true,
    },
  });
  if (!app || app.userID !== userID) {
    throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_APPLICATION" });
  }
  return app;
}

/**
 * Return a slot to the open pool, but ONLY if it is still this resident's — a
 * conditional updateMany, so a slot the head already reassigned or canceled is
 * never clobbered. Idempotent: a no-op if the slot moved on.
 */
async function releaseSlotIfMine(
  db: PrismaClient,
  slotID: number,
  userID: string,
): Promise<void> {
  await db.ccaInterviewSlot.updateMany({
    where: { slotID, bookedByUserID: userID },
    data: { bookedByUserID: null, bookedApplicationID: null, bookedAt: null },
  });
}

export type HeadContact = {
  userID: string;
  displayName: string | null;
  telegramHandle: string | null;
};

/**
 * Resolve a CCA's head userIDs to display name + Telegram, so a member viewing
 * their CCA can see who runs it and how to reach them. Same guess-email +
 * stored-key approach as cca.listHeads; selects fields explicitly (never a bare
 * User read — I-2). This is the ONLY head info exposed to a non-head: name and
 * Telegram, both already shown publicly on that person's bookings/profile.
 */
async function resolveHeadContacts(
  db: PrismaClient,
  userIDs: readonly string[],
): Promise<HeadContact[]> {
  const keys = [...new Set(userIDs)];
  if (keys.length === 0) return [];
  const guessed = keys.map((k) => `${k.toLowerCase()}@u.nus.edu`);
  const select = {
    email: true,
    displayName: true,
    telegramHandle: true,
    userID: true,
  } as const;
  const [byEmail, byStored] = await Promise.all([
    db.user.findMany({
      where: { email: { in: guessed, mode: "insensitive" } },
      select,
    }),
    db.user.findMany({ where: { userID: { in: keys } }, select }),
  ]);
  const byKey = new Map<
    string,
    { displayName: string | null; telegramHandle: string | null }
  >();
  for (const u of byEmail) {
    const cid = canonicalUserID(u.email);
    if (cid && !byKey.has(cid)) {
      byKey.set(cid, { displayName: u.displayName, telegramHandle: u.telegramHandle });
    }
  }
  for (const u of byStored) {
    if (u.userID && !byKey.has(u.userID)) {
      byKey.set(u.userID, { displayName: u.displayName, telegramHandle: u.telegramHandle });
    }
  }
  return keys.map((k) => ({
    userID: k,
    displayName: byKey.get(k)?.displayName ?? null,
    telegramHandle: byKey.get(k)?.telegramHandle ?? null,
  }));
}

export const ccaApplicationsRouter = createTRPCRouter({
  /**
   * Browse every CCA with the caller's own status against each: are they a
   * member, and do they have an application in flight. This is the /ccas grid.
   */
  browse: identifiedProcedure.query(async ({ ctx }) => {
    await assertApplicationsEnabled(ctx.db);
    const userID = ctx.session.user.userID;
    const keys = membershipKeysFor({
      email: ctx.session.user.email ?? "",
      userID,
    });

    const [ccas, profiles, memberships, myApps] = await Promise.all([
      ctx.db.cCA.findMany({
        select: { ccaID: true, ccaName: true, category: true },
      }),
      ctx.db.ccaProfile.findMany({
        select: { ccaID: true, description: true, logoUrl: true },
      }),
      ctx.db.userCCA.findMany({
        where: { userID: { in: keys } },
        select: { ccaID: true },
      }),
      // Applications are always written under the CANONICAL key, so one key
      // suffices here (unlike membership, which is mixed-format).
      ctx.db.ccaApplication.findMany({
        where: { userID },
        select: { ccaID: true, status: true },
        orderBy: { applicationID: "desc" },
      }),
    ]);

    const profileByID = new Map(profiles.map((p) => [p.ccaID, p]));
    const memberOf = new Set(memberships.map((m) => m.ccaID));
    // First (most recent) application per CCA is the one the badge reflects.
    const appByCca = new Map<number, string | null>();
    for (const a of myApps) {
      if (!appByCca.has(a.ccaID)) appByCca.set(a.ccaID, a.status);
    }

    const rows = ccas.map((c) => {
      const status = appByCca.get(c.ccaID) ?? null;
      return {
        ccaID: c.ccaID,
        ccaName: c.ccaName,
        category: c.category,
        description: profileByID.get(c.ccaID)?.description ?? null,
        logoUrl: profileByID.get(c.ccaID)?.logoUrl ?? null,
        isMember: memberOf.has(c.ccaID),
        // The status of the caller's most recent application, if any.
        applicationStatus: status,
      };
    });

    rows.sort(
      (a, b) =>
        (a.category ?? "￿").localeCompare(b.category ?? "￿") ||
        a.ccaName.localeCompare(b.ccaName),
    );
    return { ccas: rows };
  }),

  /**
   * One CCA's detail for the /ccas/[ccaID] page: profile, the caller's own
   * membership + latest application, and whether they may apply right now.
   */
  getCca: identifiedProcedure
    .input(ccaTargetInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const keys = membershipKeysFor({
        email: ctx.session.user.email ?? "",
        userID,
      });
      const now = Math.floor(Date.now() / 1000);

      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true, ccaName: true, category: true },
      });
      if (!cca) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });
      }

      const [profile, membership, apps, futureSlots, headRows, memberRows] =
        await Promise.all([
        ctx.db.ccaProfile.findUnique({
          where: { ccaID: input.ccaID },
          select: { description: true, logoUrl: true, bannerUrl: true },
        }),
        ctx.db.userCCA.findFirst({
          where: { ccaID: input.ccaID, userID: { in: keys } },
          select: { id: true },
        }),
        ctx.db.ccaApplication.findMany({
          where: { ccaID: input.ccaID, userID },
          select: {
            applicationID: true,
            status: true,
            notes: true,
            interviewSlotID: true,
            decisionReason: true,
          },
          orderBy: { applicationID: "desc" },
        }),
        // Fetch future slots and count the open ones in JS — a `bookedByUserID:
        // null` / `canceledAt: null` filter would miss slots where those fields
        // are ABSENT (Prisma+Mongo's null filter only matches a stored null),
        // which is every freshly-opened slot. See the note in
        // ccaApplicationsHead.listSlots.
        ctx.db.ccaInterviewSlot.findMany({
          where: { ccaID: input.ccaID, endTime: { gt: now } },
          select: { bookedByUserID: true, canceledAt: true },
        }),
        ctx.db.ccaHead.findMany({
          where: { ccaID: input.ccaID },
          select: { userID: true },
        }),
        // Row count, not distinct people (UserCCA is mixed-key); labelled
        // "members" in the UI, close enough for a member's overview.
        ctx.db.userCCA.findMany({
          where: { ccaID: input.ccaID },
          select: { id: true },
        }),
      ]);

      const openSlotCount = futureSlots.filter(
        (s) => s.bookedByUserID === null && s.canceledAt === null,
      ).length;
      const latest = apps[0] ?? null;
      const hasOpenApplication =
        latest !== null && !isTerminalStatus(latest.status);
      const isMember = membership !== null;
      const heads = await resolveHeadContacts(
        ctx.db,
        headRows.map((h) => h.userID),
      );

      return {
        ccaID: cca.ccaID,
        ccaName: cca.ccaName,
        category: cca.category,
        description: profile?.description ?? null,
        logoUrl: profile?.logoUrl ?? null,
        bannerUrl: profile?.bannerUrl ?? null,
        isMember,
        application: latest,
        // The client still shows an Apply button and the server re-checks — this
        // just drives the default affordance.
        canApply: !isMember && !hasOpenApplication,
        openSlotCount,
        heads,
        memberCount: memberRows.length,
      };
    }),

  /**
   * The CCAs the caller is a MEMBER of — the resident's read-only "My CCAs"
   * dashboard. Membership only (heads/managers use /cca); a CCA the caller both
   * belongs to and heads is flagged `isHead` so the UI can link across.
   *
   * NOT a management surface: it returns display data only, and every write path
   * this router exposes is scoped to the caller's own applications.
   */
  myMemberships: identifiedProcedure.query(async ({ ctx }) => {
    await assertApplicationsEnabled(ctx.db);
    const userID = ctx.session.user.userID;
    const keys = membershipKeysFor({
      email: ctx.session.user.email ?? "",
      userID,
    });

    const memberships = await ctx.db.userCCA.findMany({
      where: { userID: { in: keys } },
      select: { ccaID: true },
    });
    const ccaIDs = [...new Set(memberships.map((m) => m.ccaID))];
    if (ccaIDs.length === 0) return { ccas: [] };

    const [ccas, profiles, headRows] = await Promise.all([
      ctx.db.cCA.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, ccaName: true, category: true },
      }),
      ctx.db.ccaProfile.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, description: true, logoUrl: true },
      }),
      ctx.db.ccaHead.findMany({
        where: { ccaID: { in: ccaIDs }, userID },
        select: { ccaID: true },
      }),
    ]);

    const profileByID = new Map(profiles.map((p) => [p.ccaID, p]));
    const iHead = new Set(headRows.map((h) => h.ccaID));

    const rows = ccas.map((c) => ({
      ccaID: c.ccaID,
      ccaName: c.ccaName,
      category: c.category,
      description: profileByID.get(c.ccaID)?.description ?? null,
      logoUrl: profileByID.get(c.ccaID)?.logoUrl ?? null,
      isHead: iHead.has(c.ccaID),
    }));
    rows.sort(
      (a, b) =>
        (a.category ?? "￿").localeCompare(b.category ?? "￿") ||
        a.ccaName.localeCompare(b.ccaName),
    );
    return { ccas: rows };
  }),

  /**
   * The caller's applications across all CCAs, with the CCA name and — for a
   * scheduled interview — the booked slot's time. Drives /ccas/applications.
   */
  myApplications: identifiedProcedure.query(async ({ ctx }) => {
    await assertApplicationsEnabled(ctx.db);
    const userID = ctx.session.user.userID;

    const apps = await ctx.db.ccaApplication.findMany({
      where: { userID },
      select: {
        applicationID: true,
        ccaID: true,
        status: true,
        notes: true,
        interviewSlotID: true,
        decisionReason: true,
        createdAt: true,
        decidedAt: true,
      },
      orderBy: { applicationID: "desc" },
    });
    if (apps.length === 0) return { applications: [] };

    const ccaIDs = [...new Set(apps.map((a) => a.ccaID))];
    const slotIDs = apps
      .map((a) => a.interviewSlotID)
      .filter((s): s is number => s !== null);

    const [ccas, slots] = await Promise.all([
      ctx.db.cCA.findMany({
        where: { ccaID: { in: ccaIDs } },
        select: { ccaID: true, ccaName: true },
      }),
      slotIDs.length > 0
        ? ctx.db.ccaInterviewSlot.findMany({
            where: { slotID: { in: slotIDs } },
            select: {
              slotID: true,
              startTime: true,
              endTime: true,
              location: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const ccaName = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));
    const slotByID = new Map(slots.map((s) => [s.slotID, s]));

    return {
      applications: apps.map((a) => ({
        ...a,
        ccaName: ccaName.get(a.ccaID) ?? null,
        slot:
          a.interviewSlotID !== null
            ? (slotByID.get(a.interviewSlotID) ?? null)
            : null,
      })),
    };
  }),

  /**
   * Apply to join a CCA. matric-gated (applying is an onboarding-complete
   * action, like booking) via requireMatric, which is a no-op until
   * rbac.matric.enforcement is turned on.
   *
   * The three refusals — already a member, an application already open, the
   * caller heads this CCA — plus the create run INSIDE withCcaLock so two
   * concurrent applies cannot both pass the "no open application" check.
   */
  // NB: named `submitApplication`, not `apply` — tRPC reserves `apply` as a
  // router key (it collides with Function.prototype.apply) and the build fails
  // with "Reserved words used in router({}) call: apply".
  submitApplication: identifiedProcedure
    .use(requireMatric)
    .input(applyInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const email = ctx.session.user.email ?? "";

      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });
      }

      // Policy: a head does not apply to their own CCA (they are already inside
      // it). Checked before the lock — it needs no serialization.
      const heads = await ctx.db.ccaHead.findUnique({
        where: { userID_ccaID: { userID, ccaID: input.ccaID } },
        select: { id: true },
      });
      if (heads) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "HEAD_CANNOT_APPLY",
        });
      }

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const keys = membershipKeysFor({ email, userID });
        const member = await ctx.db.userCCA.findFirst({
          where: { ccaID: input.ccaID, userID: { in: keys } },
          select: { id: true },
        });
        if (member) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "ALREADY_MEMBER",
          });
        }

        // Any NON-terminal application for this person+CCA blocks a new one.
        // Filtered in code (not `notIn`) so a null/unknown status is handled
        // explicitly rather than by Mongo's null semantics.
        const existing = await ctx.db.ccaApplication.findMany({
          where: { ccaID: input.ccaID, userID },
          select: { status: true },
        });
        if (existing.some((a) => !isTerminalStatus(a.status))) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "APPLICATION_OPEN",
          });
        }

        const applicationID = await nextCounter(
          ctx.db,
          APPLICATION_COUNTER_KEY,
        );
        const now = new Date();
        await ctx.db.ccaApplication.create({
          data: {
            applicationID,
            ccaID: input.ccaID,
            userID,
            notes: input.notes,
            status: "submitted",
            createdAt: now,
            updatedAt: now,
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: ctx.session.user.roles,
          targetCcaID: input.ccaID,
          action: "ccaApplication.submit",
          reason: `application #${applicationID} (${input.notes.length} chars of notes)`,
        });

        return { applicationID, status: "submitted" as const };
      });
    }),

  /**
   * Open, future, unclaimed interview slots for a CCA — only visible to a
   * resident who has a live (non-terminal) application there. Also reports the
   * slot the caller currently holds, so the UI can offer a rebook.
   */
  availableSlots: identifiedProcedure
    .input(ccaTargetInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const now = Math.floor(Date.now() / 1000);

      const apps = await ctx.db.ccaApplication.findMany({
        where: { ccaID: input.ccaID, userID },
        select: { status: true, interviewSlotID: true },
        orderBy: { applicationID: "desc" },
      });
      const live = apps.find((a) => !isTerminalStatus(a.status));
      if (!live) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "NO_OPEN_APPLICATION",
        });
      }

      // Open + future slots. `bookedByUserID`/`canceledAt` are filtered in JS,
      // not the query: their null filter would miss slots where the field is
      // ABSENT (every freshly-opened one). See ccaApplicationsHead.listSlots.
      const candidates = await ctx.db.ccaInterviewSlot.findMany({
        where: { ccaID: input.ccaID, endTime: { gt: now } },
        select: {
          slotID: true,
          startTime: true,
          endTime: true,
          location: true,
          bookedByUserID: true,
          canceledAt: true,
        },
        orderBy: { startTime: "asc" },
      });
      const slots = candidates
        .filter((s) => s.bookedByUserID === null && s.canceledAt === null)
        .map((s) => ({
          slotID: s.slotID,
          startTime: s.startTime,
          endTime: s.endTime,
          location: s.location,
        }));

      return { slots, mySlotID: live.interviewSlotID };
    }),

  /**
   * Book an open slot against one's own live application. Rebooking is allowed
   * and releases the previously held slot in the same locked section, so the two
   * cannot both end up claimed.
   */
  bookSlot: identifiedProcedure
    .input(bookSlotInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;

      // Read once outside the lock to learn the ccaID to lock on; everything is
      // re-read and re-checked inside.
      const pre = await ownApplicationOr404(ctx.db, input.applicationID, userID);

      return withCcaLock(ctx.db, pre.ccaID, async () => {
        const app = await ownApplicationOr404(
          ctx.db,
          input.applicationID,
          userID,
        );
        if (isTerminalStatus(app.status)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "APPLICATION_CLOSED",
          });
        }

        const now = Math.floor(Date.now() / 1000);
        const slot = await ctx.db.ccaInterviewSlot.findUnique({
          where: { slotID: input.slotID },
          select: {
            slotID: true,
            ccaID: true,
            endTime: true,
            canceledAt: true,
            bookedByUserID: true,
          },
        });
        if (!slot || slot.ccaID !== app.ccaID || slot.canceledAt !== null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_SLOT" });
        }
        if (slot.endTime !== null && slot.endTime <= now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "SLOT_IN_PAST" });
        }
        if (slot.bookedByUserID !== null) {
          throw new TRPCError({ code: "CONFLICT", message: "SLOT_TAKEN" });
        }

        // Rebook: free the old slot first (only if still ours).
        if (app.interviewSlotID !== null && app.interviewSlotID !== input.slotID) {
          await releaseSlotIfMine(ctx.db, app.interviewSlotID, userID);
        }

        await ctx.db.ccaInterviewSlot.update({
          where: { slotID: input.slotID },
          data: {
            bookedByUserID: userID,
            bookedApplicationID: app.applicationID,
            bookedAt: new Date(),
          },
        });
        await ctx.db.ccaApplication.update({
          where: { applicationID: app.applicationID },
          data: {
            status: "interview_scheduled",
            interviewSlotID: input.slotID,
            updatedAt: new Date(),
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: ctx.session.user.roles,
          targetCcaID: app.ccaID,
          action: "ccaApplication.bookSlot",
          reason: `application #${app.applicationID} → slot #${input.slotID}`,
        });

        return { applicationID: app.applicationID, slotID: input.slotID };
      });
    }),

  /** Cancel one's booked interview, releasing the slot and reverting to submitted. */
  cancelSlot: identifiedProcedure
    .input(applicationTargetInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const pre = await ownApplicationOr404(ctx.db, input.applicationID, userID);

      return withCcaLock(ctx.db, pre.ccaID, async () => {
        const app = await ownApplicationOr404(
          ctx.db,
          input.applicationID,
          userID,
        );
        if (app.status !== "interview_scheduled" || app.interviewSlotID === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "NO_SCHEDULED_INTERVIEW",
          });
        }

        await releaseSlotIfMine(ctx.db, app.interviewSlotID, userID);
        await ctx.db.ccaApplication.update({
          where: { applicationID: app.applicationID },
          data: {
            status: "submitted",
            interviewSlotID: null,
            updatedAt: new Date(),
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: ctx.session.user.roles,
          targetCcaID: app.ccaID,
          action: "ccaApplication.cancelSlot",
          reason: `application #${app.applicationID} released slot #${app.interviewSlotID}`,
        });

        return { applicationID: app.applicationID };
      });
    }),

  /** Withdraw an application entirely. Frees any booked slot; terminal. */
  withdraw: identifiedProcedure
    .input(applicationTargetInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const pre = await ownApplicationOr404(ctx.db, input.applicationID, userID);

      return withCcaLock(ctx.db, pre.ccaID, async () => {
        const app = await ownApplicationOr404(
          ctx.db,
          input.applicationID,
          userID,
        );
        if (isTerminalStatus(app.status)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "ALREADY_CLOSED",
          });
        }

        if (app.interviewSlotID !== null) {
          await releaseSlotIfMine(ctx.db, app.interviewSlotID, userID);
        }
        await ctx.db.ccaApplication.update({
          where: { applicationID: app.applicationID },
          data: {
            status: "withdrawn",
            interviewSlotID: null,
            withdrawnAt: new Date(),
            updatedAt: new Date(),
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: ctx.session.user.roles,
          targetCcaID: app.ccaID,
          action: "ccaApplication.withdraw",
          reason: `application #${app.applicationID}`,
        });

        return { applicationID: app.applicationID };
      });
    }),
});
