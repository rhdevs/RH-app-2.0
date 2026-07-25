import { TRPCError } from "@trpc/server";
import { del } from "@vercel/blob";
import type { PrismaClient } from "@prisma/client";

import {
  createTRPCRouter,
  identifiedProcedure,
  protectedProcedure,
  roleManagerProcedure,
  requireMatric,
} from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { writeAudit } from "~/server/api/routers/admin";
import {
  assertEventsEnabled,
  nextEventId,
  withEventLock,
} from "~/server/api/services/events";
import { canonicalUserID } from "~/lib/identity";
import {
  createDraftInput,
  updateDraftInput,
  updatePublicContentInput,
  decideInput,
  eventIdInput,
  ccaIdInput,
  normalizeStatus,
  PROPOSAL_EDITABLE,
  PUBLIC_EDITABLE,
} from "~/lib/schemas/event";

/**
 * The Events feature.
 *
 * THREE authorization CLASSES live here, deliberately in one router because they
 * are one feature, but each procedure states which it uses:
 *
 *   - HEAD-scoped (identifiedProcedure + assertHeadsCca on the event's ccaID):
 *     create/edit/publish/cancel/monitor. Same rule as cca.ts — every procedure
 *     that reaches an event MUST authorise via the event's ccaID, never a role
 *     string. `cca_head` is scope-free.
 *   - REVIEWER (roleManagerProcedure = admin + jcrc): the JCRC review queue and
 *     approve/reject. `decide` additionally re-reads roles live (I-5).
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
          location: input.location ?? null,
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
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
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
      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID,
        targetEventID: event.eventID,
        action: input.decision === "approve" ? "event.approve" : "event.reject",
        reason: input.reason ?? undefined,
      });
      return { status: nextStatus as "approved" | "rejected" };
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
