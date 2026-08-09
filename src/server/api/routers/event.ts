import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { del } from "@vercel/blob";
import type { Event, PrismaClient } from "@prisma/client";

import {
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
  roleManagerProcedure,
  oversightProcedure,
  requireMatric,
} from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { assertScrcEnabled } from "~/server/api/services/scrcFlag";
import { writeAudit } from "~/server/api/routers/admin";
import {
  assertEventsEnabled,
  nextEventId,
  withEventLock,
} from "~/server/api/services/events";
import {
  nextBookingId,
  resolveFacility,
  withFacilityLock,
} from "~/server/api/services/booking";
import { canonicalUserID } from "~/lib/identity";
import {
  createDraftInput,
  updateDraftInput,
  updatePublicContentInput,
  decideInput,
  eventIdInput,
  ccaIdInput,
  normalizeStatus,
  EVENT_STATUSES,
  PROPOSAL_EDITABLE,
  PUBLIC_EDITABLE,
} from "~/lib/schemas/event";

/**
 * The Events feature.
 *
 * FOUR authorization CLASSES live here, deliberately in one router because they
 * are one feature, but each procedure states which it uses:
 *
 *   - HEAD-scoped (identifiedProcedure + assertHeadsCca on the event's ccaID):
 *     create/edit/publish/cancel/monitor. Same rule as cca.ts — every procedure
 *     that reaches an event MUST authorise via the event's ccaID, never a role
 *     string. `cca_head` is scope-free.
 *   - REVIEWER (roleManagerProcedure = admin + jcrc): the JCRC review queue and
 *     approve/reject. `decide` additionally re-reads roles live (I-5).
 *   - OVERSIGHT (oversightProcedure = admin + jcrc + scrc): READ-ONLY. The hall
 *     office watching the pipeline — listForOversight / getForOversight, every
 *     status, no attendee data. It is additionally behind the `scrc.enabled`
 *     kill switch, so the whole class can be turned off in 15s without a
 *     redeploy, and it DELIBERATELY DOES NOT REACH `decide`: approve/reject is
 *     REVIEWER-only, stays on roleManagerProcedure, and re-checks `reviewEvents`
 *     live. Watching the queue and deciding it are separate powers; do not adopt
 *     this builder for anything that writes.
 *   - RESIDENT (protectedProcedure, + requireMatric for signup): the public
 *     timeline, detail and signup. getPublic NEVER returns proposalUrl or the
 *     internal proposal description.
 *
 * EVERY procedure calls assertEventsEnabled first — the kill switch is the
 * boundary, the page guards are cosmetic.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Load an event and prove the caller heads its CCA. The head-facing counterpart
 * to assertHeadsCca: the ccaID comes from the STORED event, never the client, so
 * a head cannot act on another CCA's event by supplying a foreign ccaID.
 */
async function loadHeadedEvent(
  db: PrismaClient,
  userID: string,
  roles: readonly string[],
  eventID: number,
) {
  const event = await db.event.findUnique({ where: { eventID } });
  if (!event) {
    throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
  }
  await assertHeadsCca(db, { userID, roles }, event.ccaID);
  return event;
}

type ResolvedAttendee = {
  userID: string;
  displayName: string | null;
  matric: string | null;
  block: number | null;
  telegramHandle: string | null;
};

/**
 * Resolve canonical userIDs to attendee detail for the export and the by-block
 * stat. matric comes from UserMatric (canonical-keyed, reliable). name/block/
 * telegram come from User, which has no reverse canonical lookup, so — exactly
 * like cca.listHeads — we guess the @u.nus.edu email AND match the stored
 * User.userID, then key by canonicalUserID(email) with a stored-key fallback.
 */
async function resolveAttendees(
  db: PrismaClient,
  userIDs: string[],
): Promise<Map<string, ResolvedAttendee>> {
  const out = new Map<string, ResolvedAttendee>();
  if (userIDs.length === 0) return out;

  const guessedEmails = userIDs.map((k) => `${k.toLowerCase()}@u.nus.edu`);
  const [users, matrics] = await Promise.all([
    db.user.findMany({
      where: {
        OR: [
          { email: { in: guessedEmails, mode: "insensitive" } },
          { userID: { in: userIDs } },
        ],
      },
      // Never a bare read: passwordHash must not leave the server (I-2).
      select: {
        email: true,
        displayName: true,
        telegramHandle: true,
        block: true,
        userID: true,
      },
    }),
    db.userMatric.findMany({
      where: { userID: { in: userIDs } },
      select: { userID: true, matric: true },
    }),
  ]);

  const matricByKey = new Map(matrics.map((m) => [m.userID, m.matric]));
  const profileByKey = new Map<
    string,
    { displayName: string | null; telegramHandle: string | null; block: number | null }
  >();
  for (const u of users) {
    const cid = canonicalUserID(u.email);
    const value = {
      displayName: u.displayName,
      telegramHandle: u.telegramHandle,
      block: u.block,
    };
    if (cid && !profileByKey.has(cid)) profileByKey.set(cid, value);
    if (u.userID && !profileByKey.has(u.userID)) profileByKey.set(u.userID, value);
  }

  for (const userID of userIDs) {
    const p = profileByKey.get(userID);
    out.set(userID, {
      userID,
      displayName: p?.displayName ?? null,
      matric: matricByKey.get(userID) ?? null,
      block: p?.block ?? null,
      telegramHandle: p?.telegramHandle ?? null,
    });
  }
  return out;
}

/** Count signups per event without groupBy (Mongo-safe; hall-scale volumes). */
async function signupCounts(
  db: PrismaClient,
  eventIDs: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (eventIDs.length === 0) return counts;
  const rows = await db.eventSignup.findMany({
    where: { eventID: { in: eventIDs } },
    select: { eventID: true },
  });
  for (const r of rows) counts.set(r.eventID, (counts.get(r.eventID) ?? 0) + 1);
  return counts;
}

/** Public-safe projection — the ONLY fields a resident may ever see. */
function toPublicCard(e: {
  eventID: number;
  ccaID: number;
  title: string | null;
  publicDescription: string | null;
  bannerUrl: string | null;
  photoUrls: string[];
  startTime: number | null;
  endTime: number | null;
  location: string | null;
  capacity: number | null;
  status: string | null;
}) {
  return {
    eventID: e.eventID,
    ccaID: e.ccaID,
    title: e.title,
    publicDescription: e.publicDescription,
    bannerUrl: e.bannerUrl,
    photoUrls: e.photoUrls,
    startTime: e.startTime,
    endTime: e.endTime,
    location: e.location,
    capacity: e.capacity,
    status: normalizeStatus(e.status),
  };
}

async function attachCcaNames(
  db: PrismaClient,
  ccaIDs: number[],
): Promise<Map<number, string | null>> {
  const byID = new Map<number, string | null>();
  if (ccaIDs.length === 0) return byID;
  const rows = await db.cCA.findMany({
    where: { ccaID: { in: [...new Set(ccaIDs)] } },
    select: { ccaID: true, ccaName: true },
  });
  for (const r of rows) byID.set(r.ccaID, r.ccaName);
  return byID;
}

/**
 * Fields `event.getForOversight` BLANKS for the hall office (the non-manager
 * branch of the OVERSIGHT tier). Requirement 5 was "view events, read-only",
 * which is a question about STATUS and SCHEDULE, not about the proposal or the
 * reviewer's private notes:
 *
 *   description     the head's INTERNAL proposal text, written for the JCRC.
 *                   getPublic already withholds it from residents for the same
 *                   reason; the public-facing copy is `publicDescription`.
 *   proposalUrl     the proposal PDF. prisma/schema.prisma states outright:
 *                   reviewers + owning head only.
 *   decisionReason  the reviewer's private feedback to the head on a rejection.
 *
 * AND EVERY CANONICAL-ID FIELD ON THE RECORD, which is a different reason and
 * the one that is easy to miss. `createdBy`, `decidedBy` and `updatedBy` all
 * hold a canonical E-format userID, and a canonical id IS an email address one
 * derivation later (`E1234567` -> `e1234567@u.nus.edu`) — the same mistake that
 * was made in cca.listHeads. A hall-office caller can page every event in the
 * hall, so leaving any of the three in place hands over a directory of every
 * head who has ever proposed an event and every reviewer who has ever decided
 * one:
 *
 *   createdBy       the proposing head.
 *   decidedBy       WHICH jcrc decided. That an event was approved is oversight;
 *                   which individual signed it off is the JCRC's own business,
 *                   and naming them invites exactly the pressure the separation
 *                   exists to avoid.
 *   updatedBy       whoever last touched the row.
 *
 * `ccaID` stays: it names an organisation, not a person, and the hall office
 * already has the full CCA list. `decidedAt`, `publishedAt`, `createdAt` and
 * `updatedAt` stay — "when did this move" is a pipeline fact and is the whole
 * point of watching the pipeline.
 *
 * Blanked to null rather than deleted, so the response SHAPE is identical for
 * both tiers and no client has to branch on field presence.
 *
 * An OBJECT spread over the record, not a list of keys assigned in a loop:
 * `createdBy` is non-nullable in the schema (`String`, not `String?`), so a
 * loop writing null could not typecheck without a cast, and a cast here would
 * be a cast on precisely the line that decides what leaves the server. The
 * `satisfies` clause still checks every key against `keyof Event`, so a typo or
 * a renamed column fails the build instead of silently redacting nothing.
 *
 * TO RE-ENABLE A FIELD: delete its line here. That is the whole toggle.
 */
const SCRC_HIDDEN_EVENT_FIELDS = {
  description: null,
  proposalUrl: null,
  decisionReason: null,
  createdBy: null,
  decidedBy: null,
  updatedBy: null,
} as const satisfies Partial<Record<keyof Event, null>>;

/* resolveFacility lives in services/booking.ts — the interview-slot flow
 * resolves a facility the same way, and one definition is what keeps the two
 * agreeing about what a missing facility means. */

/* -------------------------------------------------------------------------- */
/* Router                                                                      */
/* -------------------------------------------------------------------------- */

export const eventRouter = createTRPCRouter({
  /* ----------------------------- HEAD: authoring ------------------------- */

  createDraft: identifiedProcedure
    .input(createDraftInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      // The CCA must exist, else the draft points at nothing and is invisible
      // everywhere (same guard as cca.updateProfile).
      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca) throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });

      // A facility choice denormalizes its name into `location`; otherwise the
      // free-text location is used as-is.
      let location: string | null = input.location ?? null;
      let facilityID: number | null = null;
      if (input.facilityID != null) {
        const f = await resolveFacility(ctx.db, input.facilityID);
        facilityID = f.facilityID;
        location = f.name;
      }

      const eventID = await nextEventId(ctx.db);
      await ctx.db.event.create({
        data: {
          eventID,
          ccaID: input.ccaID,
          createdBy: userID,
          title: input.title ?? null,
          description: input.description ?? null,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          location,
          facilityID,
          capacity: input.capacity ?? null,
          status: "draft",
          createdAt: new Date(),
        },
      });
      return { eventID };
    }),

  updateDraft: identifiedProcedure
    .input(updateDraftInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      if (!PROPOSAL_EDITABLE.includes(normalizeStatus(event.status))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "PROPOSAL_NOT_EDITABLE",
        });
      }

      // Merge-then-check: a client may send endTime alone, so validate against
      // the value on file, not only the payload (the schema can only see both
      // when both are present).
      const nextStart = input.startTime ?? event.startTime;
      const nextEnd =
        input.endTime === undefined ? event.endTime : input.endTime;
      if (nextStart != null && nextEnd != null && nextEnd <= nextStart) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "END_BEFORE_START",
        });
      }

      const data: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: userID,
      };
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.startTime !== undefined) data.startTime = input.startTime;
      if (input.endTime !== undefined) data.endTime = input.endTime;
      if (input.location !== undefined) data.location = input.location;
      if (input.capacity !== undefined) data.capacity = input.capacity;
      if (input.proposalUrl !== undefined) data.proposalUrl = input.proposalUrl;

      // Facility ↔ location. A number selects a facility (denormalize its name,
      // overriding any location text sent above); explicit null switches to
      // "Other" (keep/clear the free text); undefined leaves both untouched.
      if (input.facilityID !== undefined) {
        if (input.facilityID === null) {
          data.facilityID = null;
          data.location = input.location ?? null;
        } else {
          const f = await resolveFacility(ctx.db, input.facilityID);
          data.facilityID = f.facilityID;
          data.location = f.name;
        }
      }

      await ctx.db.event.update({ where: { eventID: input.eventID }, data });

      // Clean up a replaced proposal PDF (non-fatal, mirrors updateProfile).
      if (
        input.proposalUrl !== undefined &&
        event.proposalUrl &&
        event.proposalUrl !== input.proposalUrl
      ) {
        try {
          await del(event.proposalUrl);
        } catch (err) {
          console.error(
            JSON.stringify({
              evt: "event_blob_delete_failed",
              eventID: input.eventID,
              url: event.proposalUrl,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      return { ok: true };
    }),

  submitForReview: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      if (!PROPOSAL_EDITABLE.includes(normalizeStatus(event.status))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_SUBMITTABLE",
        });
      }
      // Completeness is enforced HERE, not on the draft, so partial saves work.
      const missing: string[] = [];
      if (!event.title?.trim()) missing.push("title");
      if (!event.description?.trim()) missing.push("description");
      if (event.startTime == null) missing.push("startTime");
      if (!event.location?.trim()) missing.push("location");
      if (!event.proposalUrl) missing.push("proposalUrl");
      // A facility can only be auto-booked with a definite end time, so require
      // it when a facility was chosen (free-text locations don't need one).
      if (event.facilityID != null && event.endTime == null) {
        missing.push("endTime");
      }
      if (missing.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `INCOMPLETE:${missing.join(",")}`,
        });
      }

      await ctx.db.event.update({
        where: { eventID: input.eventID },
        data: {
          status: "submitted",
          // Clear a prior rejection so the reviewer sees a clean submission.
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
      return { status: "submitted" as const };
    }),

  updatePublicContent: identifiedProcedure
    .input(updatePublicContentInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      if (!PUBLIC_EDITABLE.includes(normalizeStatus(event.status))) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "PUBLIC_CONTENT_LOCKED",
        });
      }

      const data: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: userID,
      };
      if (input.publicDescription !== undefined)
        data.publicDescription = input.publicDescription;
      if (input.bannerUrl !== undefined) data.bannerUrl = input.bannerUrl;
      if (input.photoUrls !== undefined) data.photoUrls = input.photoUrls;

      await ctx.db.event.update({ where: { eventID: input.eventID }, data });

      // Delete blobs this save replaced/removed (non-fatal). Every URL here was
      // proven ours by updatePublicContentInput; `event.*` came from our row.
      const replaced: string[] = [];
      if (
        input.bannerUrl !== undefined &&
        event.bannerUrl &&
        event.bannerUrl !== input.bannerUrl
      ) {
        replaced.push(event.bannerUrl);
      }
      if (input.photoUrls !== undefined) {
        const kept = new Set(input.photoUrls);
        for (const url of event.photoUrls) if (!kept.has(url)) replaced.push(url);
      }
      if (replaced.length > 0) {
        try {
          await del(replaced);
        } catch (err) {
          console.error(
            JSON.stringify({
              evt: "event_blob_delete_failed",
              eventID: input.eventID,
              urls: replaced,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      return { ok: true };
    }),

  publish: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      const status = normalizeStatus(event.status);
      if (status === "published") return { status: "published" as const };
      if (status !== "approved") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_APPROVED",
        });
      }
      // The public minimum: residents must not land on a bare event.
      const missing: string[] = [];
      if (!event.bannerUrl) missing.push("banner");
      if (!event.publicDescription?.trim()) missing.push("publicDescription");
      if (missing.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `INCOMPLETE:${missing.join(",")}`,
        });
      }

      await ctx.db.event.update({
        where: { eventID: input.eventID },
        data: {
          status: "published",
          publishedAt: new Date(),
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID,
        targetEventID: event.eventID,
        action: "event.publish",
        reason: event.title ?? undefined,
      });
      return { status: "published" as const };
    }),

  cancelEvent: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      const status = normalizeStatus(event.status);
      if (status !== "approved" && status !== "published") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_CANCELABLE",
        });
      }
      await ctx.db.event.update({
        where: { eventID: input.eventID },
        data: {
          status: "canceled",
          bookingID: null,
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });

      // Free the facility: delete the auto-created booking so the slot reopens.
      // Non-fatal — a missing booking (already deleted) is fine.
      if (event.bookingID != null) {
        try {
          await ctx.db.bookings.deleteMany({
            where: { bookingID: event.bookingID },
          });
        } catch (err) {
          console.error(
            JSON.stringify({
              evt: "event_booking_delete_failed",
              eventID: event.eventID,
              bookingID: event.bookingID,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID,
        targetEventID: event.eventID,
        action: "event.cancel",
        reason: event.title ?? undefined,
      });
      return { status: "canceled" as const };
    }),

  /* ----------------------------- HEAD: monitoring ------------------------ */

  listMineForCca: identifiedProcedure
    .input(ccaIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const events = await ctx.db.event.findMany({
        where: { ccaID: input.ccaID },
        orderBy: { createdAt: "desc" },
      });
      const counts = await signupCounts(
        ctx.db,
        events.map((e) => e.eventID),
      );
      return {
        events: events.map((e) => ({
          eventID: e.eventID,
          title: e.title,
          status: normalizeStatus(e.status),
          startTime: e.startTime,
          location: e.location,
          capacity: e.capacity,
          bannerUrl: e.bannerUrl,
          decisionReason: e.decisionReason,
          signupCount: counts.get(e.eventID) ?? 0,
        })),
      };
    }),

  getForHead: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);
      const signupCount = await ctx.db.eventSignup.count({
        where: { eventID: input.eventID },
      });
      return { event: { ...event, status: normalizeStatus(event.status) }, signupCount };
    }),

  getSignupStats: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      const signups = await ctx.db.eventSignup.findMany({
        where: { eventID: input.eventID },
        select: { userID: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });

      // Signups per calendar day (UTC date key) — the client cumulates.
      const perDay = new Map<string, number>();
      for (const s of signups) {
        const day = (s.createdAt ?? new Date()).toISOString().slice(0, 10);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      const byDay = [...perDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }));

      // By block, resolved live.
      const resolved = await resolveAttendees(
        ctx.db,
        signups.map((s) => s.userID),
      );
      const perBlock = new Map<string, number>();
      for (const s of signups) {
        const block = resolved.get(s.userID)?.block;
        const key = block == null ? "Unknown" : String(block);
        perBlock.set(key, (perBlock.get(key) ?? 0) + 1);
      }
      const byBlock = [...perBlock.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([block, count]) => ({ block, count }));

      return { total: signups.length, byDay, byBlock };
    }),

  /** Render-only attendee list for the head's monitor table (no audit). */
  getAttendees: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      const signups = await ctx.db.eventSignup.findMany({
        where: { eventID: input.eventID },
        select: { userID: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const resolved = await resolveAttendees(
        ctx.db,
        signups.map((s) => s.userID),
      );
      return {
        attendees: signups.map((s) => ({
          ...(resolved.get(s.userID) ?? {
            userID: s.userID,
            displayName: null,
            matric: null,
            block: null,
            telegramHandle: null,
          }),
          signedUpAt: s.createdAt,
        })),
      };
    }),

  /**
   * The AUDITED PII export. A mutation, not a query, so it fires exactly once
   * per download and writes an event.attendees.export audit row carrying the
   * exported count. Returns the same rows the CSV is built from client-side.
   */
  exportAttendees: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadHeadedEvent(ctx.db, userID, roles, input.eventID);

      const signups = await ctx.db.eventSignup.findMany({
        where: { eventID: input.eventID },
        select: { userID: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const resolved = await resolveAttendees(
        ctx.db,
        signups.map((s) => s.userID),
      );
      const attendees = signups.map((s) => ({
        ...(resolved.get(s.userID) ?? {
          userID: s.userID,
          displayName: null,
          matric: null,
          block: null,
          telegramHandle: null,
        }),
        signedUpAt: s.createdAt,
      }));

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID,
        targetEventID: event.eventID,
        action: "event.attendees.export",
        reason: `${attendees.length} attendee(s)`,
      });
      return { attendees, title: event.title, eventID: event.eventID };
    }),

  /* ------------------------------ REVIEWER ------------------------------- */

  listForReview: roleManagerProcedure.query(async ({ ctx }) => {
    await assertEventsEnabled(ctx.db);
    const events = await ctx.db.event.findMany({
      where: { status: "submitted" },
      orderBy: { updatedAt: "asc" }, // oldest waiting first — a queue
    });
    const names = await attachCcaNames(
      ctx.db,
      events.map((e) => e.ccaID),
    );
    return {
      events: events.map((e) => ({
        eventID: e.eventID,
        ccaID: e.ccaID,
        ccaName: names.get(e.ccaID) ?? null,
        title: e.title,
        startTime: e.startTime,
        location: e.location,
        updatedAt: e.updatedAt,
      })),
    };
  }),

  getForReview: roleManagerProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      const names = await attachCcaNames(ctx.db, [event.ccaID]);
      return {
        event: { ...event, status: normalizeStatus(event.status) },
        ccaName: names.get(event.ccaID) ?? null,
      };
    }),

  decide: roleManagerProcedure
    .input(decideInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      if (!computeCapabilities(roles).reviewEvents) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "CAPABILITY_REQUIRED:reviewEvents",
        });
      }

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      if (normalizeStatus(event.status) !== "submitted") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_UNDER_REVIEW",
        });
      }

      const nextStatus = input.decision === "approve" ? "approved" : "rejected";
      await ctx.db.event.update({
        where: { eventID: input.eventID },
        data: {
          status: nextStatus,
          decidedAt: new Date(),
          decidedBy: userID,
          decisionReason: input.reason ?? null,
        },
      });

      // On approval, if a facility was chosen, auto-create a Booking under the
      // event's head for that facility at the event's time. BEST-EFFORT: a clash
      // (the slot was taken between submit and approval) FLAGS the event instead
      // of blocking approval or double-booking. Reuses the same
      // withFacilityLock + conflict check + nextBookingId as createBooking. The
      // facility ROLE gate is intentionally skipped — JCRC approving the event IS
      // the authorization — but the physical time-conflict check is kept.
      let autoBook: "booked" | "conflict" | "none" = "none";
      if (
        input.decision === "approve" &&
        event.facilityID != null &&
        event.startTime != null &&
        event.endTime != null
      ) {
        const facilityID = event.facilityID;
        const startTime = event.startTime;
        const endTime = event.endTime;
        try {
          const result = await withFacilityLock(ctx.db, facilityID, async () => {
            const conflicts = await ctx.db.bookings.findMany({
              where: {
                facilityID,
                AND: [
                  { endTime: { gt: startTime } },
                  { startTime: { lt: endTime } },
                ],
              },
              select: { id: true },
            });
            if (conflicts.length > 0) return { booked: false as const };
            const bookingID = await nextBookingId(ctx.db);
            await ctx.db.bookings.create({
              data: {
                bookingID,
                ccaID: event.ccaID,
                facilityID,
                startTime,
                endTime,
                userID: event.createdBy,
                eventName: event.title ?? `Event #${event.eventID}`,
                description: `Auto-booked for event #${event.eventID}`,
              },
            });
            return { booked: true as const, bookingID };
          });
          if (result.booked) {
            autoBook = "booked";
            await ctx.db.event.update({
              where: { eventID: input.eventID },
              data: { bookingID: result.bookingID, autoBookFailed: false },
            });
          } else {
            autoBook = "conflict";
            await ctx.db.event.update({
              where: { eventID: input.eventID },
              data: { autoBookFailed: true },
            });
          }
        } catch (err) {
          // NEVER fail the approval on a booking error — flag it for the head to
          // book manually.
          autoBook = "conflict";
          console.error(
            JSON.stringify({
              evt: "event_autobook_failed",
              eventID: event.eventID,
              facilityID,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          await ctx.db.event
            .update({
              where: { eventID: input.eventID },
              data: { autoBookFailed: true },
            })
            .catch(() => undefined);
        }
      }

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID,
        targetEventID: event.eventID,
        action: input.decision === "approve" ? "event.approve" : "event.reject",
        reason:
          autoBook === "booked"
            ? `${input.reason ? input.reason + "; " : ""}auto-booked facility #${event.facilityID}`
            : autoBook === "conflict"
              ? `${input.reason ? input.reason + "; " : ""}facility #${event.facilityID} clash — not booked`
              : (input.reason ?? undefined),
      });
      return { status: nextStatus as "approved" | "rejected", autoBook };
    }),

  /* ----------------------------- OVERSIGHT ------------------------------- */
  /*
   * READ-ONLY, admin + jcrc + scrc, and behind `scrc.enabled` on top of
   * `events.enabled`. The pair below is the hall office's whole reach into
   * events: see the pipeline, read one record, do nothing to it.
   *
   * WHY NOT JUST WIDEN listForReview/getForReview. Two reasons, either of which
   * is sufficient. (1) They are the JCRC QUEUE: listForReview filters to
   * `status: "submitted"` because a queue is work waiting to be done, whereas
   * oversight wants drafts, approvals and cancellations too — different
   * question, different answer. (2) They sit on roleManagerProcedure, the
   * builder that also gates `decide`; widening it would hand approve/reject to
   * the hall office as a side effect of wanting a list. Two small procedures
   * cost less than that coupling.
   *
   * The gate is written out in both bodies rather than factored into a helper,
   * following `decide` above, which likewise inlines its own live capability
   * re-check. Order is fixed and load-bearing: assertEventsEnabled FIRST (the
   * file rule — the switch is the boundary), then a LIVE role read, then the
   * capability, then the scrc switch.
   */

  /**
   * Every event, newest first, optionally filtered by status. PAGED.
   *
   * Projection is listForReview's PLUS `status` (normalised — the stored column
   * is a nullable String). Nothing else: no proposalUrl, no internal proposal
   * description, no attendee data, no PII. Oversight is "what is happening", not
   * "who is going"; exportAttendees stays head-scoped. The `select` is explicit
   * so the wide fields are never even READ, rather than read and then dropped —
   * `description` and `proposalUrl` on every event in the hall is a lot of bytes
   * to pull across just to throw away.
   *
   * ORDERED BY updatedAt DESC — MOST RECENTLY TOUCHED FIRST. This is a feed of
   * what is happening, not a queue of what is waiting (that is listForReview),
   * so an event proposed a year ago and edited this morning belongs at the TOP.
   * It briefly ordered by `eventID desc` instead, on the mistaken belief that a
   * cursor needs the sort key to be unique: it does not — the cursor is on `id`
   * and only names WHERE to resume, while `orderBy` decides the sequence. This
   * is the same pairing admin.listAuditLog already runs in production
   * (`orderBy: { at: "desc" }` with `cursor: { id }`).
   *
   * The honest caveat of that pairing, which listAuditLog shares: `updatedAt` is
   * not unique, so an event edited BETWEEN two page fetches moves in the
   * ordering and can be seen twice or missed once. That is a stale-window
   * artefact of cursor paging over a mutable sort key, not a correctness bug in
   * the projection, and for a human scrolling an oversight feed it is the right
   * trade against showing them a year-stale event first.
   */
  listForOversight: oversightProcedure
    // EVENT_STATUSES is imported rather than retyped so the filter vocabulary
    // cannot drift from normalizeStatus'. Note "canceled", one l.
    .input(
      z.object({
        status: z.enum(EVENT_STATUSES).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      // I-5: LIVE read. session.user.roles is render-only and up to 30 days
      // stale, so a demoted hall-office member would otherwise keep reading.
      const roles = await getUserRoles(ctx.db, userID);
      const capabilities = computeCapabilities(roles);
      if (!capabilities.viewEventsReadOnly) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "CAPABILITY_REQUIRED:viewEventsReadOnly",
        });
      }
      // THE SWITCH GATES THE HALL OFFICE, NOT THE SURFACE. It was unconditional
      // here at first, on the reasoning that a new procedure has no existing
      // callers to break — true, and it missed that an ADMIN holds
      // reachScrcDashboard and can therefore open /scrc BEFORE rollout, at which
      // point every panel errored and the surface could not be inspected by the
      // one person entitled to inspect it. Same shape as the branch ordering in
      // assertMayViewCcaRoster: whoever could already do this is unaffected by
      // the flag, and only the tier the flag exists for is held behind it.
      if (!capabilities.reviewEvents) await assertScrcEnabled(ctx.db);

      // KNOWN AND DELIBERATE: this filters the RAW column, while the returned
      // `status` is normalizeStatus'd. Event.status is nullable with a default,
      // and normalizeStatus maps null — and anything unrecognised — to "draft",
      // so `status: "draft"` will NOT match a row stored as null even though
      // that row comes back reading "draft". Left alone on purpose: an OR on
      // `{ status: null }` would make "draft" mean something different here than
      // it means in decide's NOT_UNDER_REVIEW check and in PROPOSAL_EDITABLE.
      // The unfiltered list (no `status` input) shows every row regardless.
      const rows = await ctx.db.event.findMany({
        where: input.status ? { status: input.status } : {},
        select: {
          id: true,
          eventID: true,
          ccaID: true,
          title: true,
          startTime: true,
          location: true,
          updatedAt: true,
          status: true,
        },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { updatedAt: "desc" }, // newest activity first — a feed, not a queue
      });
      const events = rows.slice(0, input.limit);
      const nextCursor =
        rows.length > input.limit
          ? (events[events.length - 1]?.id ?? null)
          : null;

      const names = await attachCcaNames(
        ctx.db,
        events.map((e) => e.ccaID),
      );
      return {
        events: events.map((e) => ({
          eventID: e.eventID,
          ccaID: e.ccaID,
          ccaName: names.get(e.ccaID) ?? null,
          title: e.title,
          startTime: e.startTime,
          location: e.location,
          updatedAt: e.updatedAt,
          status: normalizeStatus(e.status),
        })),
        nextCursor,
      };
    }),

  /**
   * One event's record, for the oversight detail view.
   *
   * A MANAGER GETS getForReview'S ANSWER, BYTE FOR BYTE. A hall-office caller
   * gets the same record with four fields removed — see SCRC_HIDDEN_EVENT_FIELDS
   * below. The body was originally identical for both, which meant `scrc` was
   * handed `proposalUrl` (schema.prisma calls it "reviewers + owning head only")
   * and the private decision trail, from a capability whose entire description
   * is "view events, read-only".
   *
   * There is no getForOversight counterpart to `decide`: reading an event and
   * deciding it are separate powers, and only the REVIEWER tier has the second.
   */
  getForOversight: oversightProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const capabilities = computeCapabilities(roles);
      if (!capabilities.viewEventsReadOnly) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "CAPABILITY_REQUIRED:viewEventsReadOnly",
        });
      }
      // `reviewEvents` IS the manager tier for events (admin || jcrc), so it is
      // the honest discriminator here — both for the kill switch and for the
      // projection below. See listForOversight for why the switch is checked on
      // the non-manager branch only.
      if (!capabilities.reviewEvents) await assertScrcEnabled(ctx.db);

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      const names = await attachCcaNames(ctx.db, [event.ccaID]);

      const full = { ...event, status: normalizeStatus(event.status) };
      if (capabilities.reviewEvents) {
        return { event: full, ccaName: names.get(event.ccaID) ?? null };
      }

      // If the hall office is ever meant to read proposals, edit
      // SCRC_HIDDEN_EVENT_FIELDS rather than deleting this branch — the branch
      // is also what keeps the manager path provably untouched.
      return {
        event: { ...full, ...SCRC_HIDDEN_EVENT_FIELDS },
        ccaName: names.get(event.ccaID) ?? null,
      };
    }),

  /* ------------------------------ RESIDENT ------------------------------- */

  listPublished: protectedProcedure.query(async ({ ctx }) => {
    await assertEventsEnabled(ctx.db);
    const events = await ctx.db.event.findMany({
      where: { status: "published" },
      orderBy: { startTime: "asc" },
    });
    const [names, counts, mine] = await Promise.all([
      attachCcaNames(
        ctx.db,
        events.map((e) => e.ccaID),
      ),
      signupCounts(
        ctx.db,
        events.map((e) => e.eventID),
      ),
      ctx.session.user.userID
        ? ctx.db.eventSignup.findMany({
            where: {
              userID: ctx.session.user.userID,
              eventID: { in: events.map((e) => e.eventID) },
            },
            select: { eventID: true },
          })
        : Promise.resolve([] as { eventID: number }[]),
    ]);
    const mineSet = new Set(mine.map((m) => m.eventID));
    return {
      events: events.map((e) => ({
        ...toPublicCard(e),
        ccaName: names.get(e.ccaID) ?? null,
        signupCount: counts.get(e.eventID) ?? 0,
        mySignup: mineSet.has(e.eventID),
      })),
    };
  }),

  getPublic: protectedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      // Only published (or a canceled event someone still has the link to) is
      // public. draft/submitted/approved are NOT — treat as not found so their
      // existence isn't disclosed.
      const status = normalizeStatus(event?.status);
      if (!event || (status !== "published" && status !== "canceled")) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }

      const [names, signupCount, mine] = await Promise.all([
        attachCcaNames(ctx.db, [event.ccaID]),
        ctx.db.eventSignup.count({ where: { eventID: event.eventID } }),
        ctx.session.user.userID
          ? ctx.db.eventSignup.findUnique({
              where: {
                eventID_userID: {
                  eventID: event.eventID,
                  userID: ctx.session.user.userID,
                },
              },
              select: { eventID: true },
            })
          : Promise.resolve(null),
      ]);

      const nowSec = Math.floor(Date.now() / 1000);
      const started = event.startTime != null && nowSec >= event.startTime;
      const full = event.capacity != null && signupCount >= event.capacity;
      return {
        ...toPublicCard(event),
        ccaName: names.get(event.ccaID) ?? null,
        signupCount,
        mySignup: mine !== null,
        canceled: status === "canceled",
        started,
        full,
        // The client still shows the button; the server is the real gate.
        signupOpen: status === "published" && !started && !full,
      };
    }),

  signup: identifiedProcedure
    .use(requireMatric)
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
        select: { eventID: true, status: true, startTime: true, capacity: true },
      });
      if (!event || normalizeStatus(event.status) !== "published") {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (event.startTime != null && nowSec >= event.startTime) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "SIGNUP_CLOSED",
        });
      }

      return withEventLock(ctx.db, input.eventID, async () => {
        if (event.capacity != null) {
          const count = await ctx.db.eventSignup.count({
            where: { eventID: input.eventID },
          });
          // Already-signed-up callers pass (idempotent); genuinely-full block.
          if (count >= event.capacity) {
            const already = await ctx.db.eventSignup.findUnique({
              where: {
                eventID_userID: { eventID: input.eventID, userID },
              },
              select: { eventID: true },
            });
            if (!already) {
              throw new TRPCError({ code: "CONFLICT", message: "EVENT_FULL" });
            }
            return { signedUp: true as const };
          }
        }
        try {
          await ctx.db.eventSignup.create({
            data: { eventID: input.eventID, userID, createdAt: new Date() },
          });
        } catch (err) {
          // Unique index is the double-submit backstop — idempotent success.
          if (
            !(
              typeof err === "object" &&
              err !== null &&
              (err as { code?: string }).code === "P2002"
            )
          ) {
            throw err;
          }
        }
        return { signedUp: true as const };
      });
    }),

  cancelSignup: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      await ctx.db.eventSignup.deleteMany({
        where: { eventID: input.eventID, userID },
      });
      return { signedUp: false as const };
    }),

  listMySignups: identifiedProcedure.query(async ({ ctx }) => {
    await assertEventsEnabled(ctx.db);
    const userID = ctx.session.user.userID;
    const mine = await ctx.db.eventSignup.findMany({
      where: { userID },
      select: { eventID: true },
    });
    const eventIDs = mine.map((m) => m.eventID);
    if (eventIDs.length === 0) return { events: [] };

    const events = await ctx.db.event.findMany({
      where: { eventID: { in: eventIDs }, status: "published" },
      orderBy: { startTime: "asc" },
    });
    const [names, counts] = await Promise.all([
      attachCcaNames(
        ctx.db,
        events.map((e) => e.ccaID),
      ),
      signupCounts(
        ctx.db,
        events.map((e) => e.eventID),
      ),
    ]);
    return {
      events: events.map((e) => ({
        ...toPublicCard(e),
        ccaName: names.get(e.ccaID) ?? null,
        signupCount: counts.get(e.eventID) ?? 0,
        mySignup: true,
      })),
    };
  }),
});
