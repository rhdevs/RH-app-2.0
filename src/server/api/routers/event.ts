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
  createEventInput,
  updateEventInput,
  decideInput,
  reviewerCancelInput,
  eventIdInput,
  ccaIdInput,
  normalizeStatus,
  editScope,
  EVENT_STATUSES,
  HALL_OWNER_LABEL,
} from "~/lib/schemas/event";

/**
 * The Events feature.
 *
 * FOUR authorization CLASSES live here, deliberately in one router because they
 * are one feature, but each procedure states which it uses:
 *
 *   - OWNER-scoped (identifiedProcedure + loadOwnedEvent): create/edit/submit/
 *     withdraw/cancel/duplicate/monitor. Same rule as cca.ts — every procedure
 *     that reaches an event MUST authorise via the event's STORED ccaID, never a
 *     role string, because `cca_head` is scope-free. TWO ownership shapes:
 *     ccaID != null is a CCA event (assertHeadsCca); ccaID == null is a
 *     HALL-WIDE, JCRC-owned event (the `manageHallEvents` capability). That
 *     branch lives in loadOwnedEvent and NOWHERE ELSE.
 *   - REVIEWER (roleManagerProcedure = admin + jcrc): the JCRC review queue,
 *     approve / request changes / decline, and cancelling a published event.
 *     `decide` and `reviewerCancel` additionally re-read roles live (I-5).
 *   - OVERSIGHT (oversightProcedure = admin + jcrc + scrc): READ-ONLY. The hall
 *     office watching the pipeline — listForOversight / getForOversight, every
 *     status, no attendee data. It is additionally behind the `scrc.enabled`
 *     kill switch, so the whole class can be turned off in 15s without a
 *     redeploy, and it DELIBERATELY DOES NOT REACH `decide`: approve/reject is
 *     REVIEWER-only, stays on roleManagerProcedure, and re-checks `reviewEvents`
 *     live. Watching the queue and deciding it are separate powers; do not adopt
 *     this builder for anything that writes. It likewise does NOT reach
 *     `manageHallEvents`: the hall office does not author events.
 *   - RESIDENT (protectedProcedure, + requireMatric for signup): the public
 *     timeline, detail and signup. getPublic NEVER returns the internal
 *     description the head wrote for the JCRC — residents read
 *     `publicDescription`.
 *
 * EVERY procedure calls assertEventsEnabled first — the kill switch is the
 * boundary, the page guards are cosmetic.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Load an event and prove the caller OWNS it.
 *
 * TWO ownership shapes, and the ccaID on the STORED row picks between them:
 *   ccaID != null  a CCA event -> assertHeadsCca on that ccaID (per-object, never
 *                  a role string; `cca_head` is scope-free)
 *   ccaID == null  a HALL-WIDE event -> the `manageHallEvents` capability
 *
 * The ccaID comes from the ROW, never the client, so a head cannot reach a
 * foreign event by supplying a ccaID — and cannot reach a HALL event by
 * supplying null, because they supply nothing at all.
 *
 * DO NOT INLINE THIS BRANCH ANYWHERE ELSE. A second copy is a second chance to
 * get the null case wrong, and the null case IS the authorisation case. The one
 * unavoidable second copy is in /api/event/upload/route.ts, which cannot call a
 * tRPC helper; it sits directly beside the `select` that produced the nullable
 * value, deliberately. assertHeadsCca itself must NOT learn about null — it is
 * shared with cca.updateProfile, cca.removeMembers, cca.handoverHeads,
 * cca.memberDirectory and the whole application flow, and widening it hands all
 * of that to whoever gains the new branch (see its own comment).
 */
async function loadOwnedEvent(
  db: PrismaClient,
  userID: string,
  roles: readonly string[],
  eventID: number,
) {
  const event = await db.event.findUnique({ where: { eventID } });
  if (!event) {
    throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
  }
  if (event.ccaID == null) {
    if (!computeCapabilities(roles).manageHallEvents) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "CAPABILITY_REQUIRED:manageHallEvents",
      });
    }
  } else {
    await assertHeadsCca(db, { userID, roles }, event.ccaID);
  }
  return event;
}

/**
 * Free the facility a cancelled event was holding: delete the auto-created
 * Bookings row so the slot reopens.
 *
 * NON-FATAL by design — a missing booking (already deleted, or never made
 * because the slot clashed at approval) is a normal outcome, not an error, and
 * an event must not be left half-cancelled because a cleanup delete failed. The
 * caller has ALREADY nulled Event.bookingID before calling this.
 *
 * Shared by cancelEvent and reviewerCancel. Two cancels, one cleanup: the head
 * and the reviewer must not be able to leave the room booked in different
 * circumstances.
 */
async function releaseEventBooking(
  db: PrismaClient,
  event: { eventID: number; bookingID: number | null },
): Promise<void> {
  if (event.bookingID == null) return;
  try {
    await db.bookings.deleteMany({ where: { bookingID: event.bookingID } });
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
  /** null = a hall-wide, JCRC-owned event. Passed straight through so the client
   *  can call ownerLabel(ccaID, ccaName) itself. */
  ccaID: number | null;
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
 * The `ccaName` every projection returns. A hall-wide event (ccaID null) has no
 * CCA row to name, so it resolves to the literal "Hall"; a CCA event resolves
 * through the name map and stays null when the CCA has been deleted, which the
 * client renders as `CCA #{id}`.
 *
 * KEYED ON THE ID, NEVER ON THE NAME. "Hall-wide" and "the CCA was deleted" both
 * produce a null name, and if a null NAME meant "Hall" an orphaned event would be
 * silently relabelled as a JCRC one. Same rule, same reason, as ownerLabel in
 * lib/schemas/event.ts — the client-side half of this pair.
 */
function ownerName(
  ccaID: number | null,
  names: Map<number, string | null>,
): string | null {
  return ccaID == null ? HALL_OWNER_LABEL : (names.get(ccaID) ?? null);
}

/** The ids to resolve names for. Hall events contribute nothing to the lookup. */
function nameableCcaIDs(events: { ccaID: number | null }[]): number[] {
  return events.map((e) => e.ccaID).filter((c): c is number => c != null);
}

/**
 * Fields `event.getForOversight` BLANKS for the hall office (the non-manager
 * branch of the OVERSIGHT tier). Requirement 5 was "view events, read-only",
 * which is a question about STATUS and SCHEDULE, not about the proposal or the
 * reviewer's private notes:
 *
 *   description     the head's INTERNAL text, written for the JCRC. getPublic
 *                   already withholds it from residents for the same reason; the
 *                   public-facing copy is `publicDescription`.
 *   decisionReason  the reviewer's private feedback to the head when they
 *                   requested changes or declined.
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

  /**
   * Create an event.
   *
   * `ccaID` ABSENT OR NULL MEANS HALL-WIDE, and the branch below is one of the
   * two places the null case is decided (the other is loadOwnedEvent). Branch
   * FIRST, then check the CCA exists: hoisting the cCA.findUnique above the
   * branch would refuse every hall event, because there is no CCA row to find
   * and `findUnique({ where: { ccaID: null } })` is not a meaningful query.
   */
  create: identifiedProcedure
    .input(createEventInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read

      let ccaID: number | null;
      if (input.ccaID == null) {
        if (!computeCapabilities(roles).manageHallEvents) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "CAPABILITY_REQUIRED:manageHallEvents",
          });
        }
        ccaID = null;
      } else {
        await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);
        // The CCA must exist, else the event points at nothing and is invisible
        // everywhere (same guard as cca.updateProfile).
        const cca = await ctx.db.cCA.findUnique({
          where: { ccaID: input.ccaID },
          select: { ccaID: true },
        });
        if (!cca) {
          throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_CCA" });
        }
        ccaID = input.ccaID;
      }

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
          // WRITTEN EXPLICITLY, EVEN WHEN NULL. `{ ccaID: null }` matches a
          // STORED null but NOT an absent field, and listForOwner's hall branch
          // queries exactly that. A row created without the key would be
          // invisible to the only list that can reach it — created successfully,
          // then unmanageable, with no error anywhere — while still reading back
          // fine via findUnique({ eventID }), so every single-event test passes.
          ccaID,
          createdBy: userID,
          title: input.title ?? null,
          description: input.description ?? null,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          location,
          facilityID,
          capacity: input.capacity ?? null,
          status: "draft",
          // THE FOUR INERT PHASE-2 FIELDS, WRITTEN EXPLICITLY FOR THE SAME
          // REASON AS ccaID. Nothing reads them today, so omitting them is
          // harmless TODAY — and that is exactly what makes it a landmine.
          // D-17 lands them now so the attendance and purge phases need no
          // second schema pass, which means those phases will query these very
          // rows. `where: { answersPurgedAt: null }` — the obvious way to find
          // events whose answers still need purging — matches a STORED null and
          // NOT an absent key, so every event created in Phase 1 would be
          // invisible to the purge, silently and forever. Writing them costs
          // one line each; discovering the omission costs a data-retention
          // incident.
          attendanceOpensAt: null,
          attendanceClosesAt: null,
          scannerUserIDs: [],
          answersPurgedAt: null,
          createdAt: new Date(),
        },
      });
      return { eventID };
    }),

  /**
   * Save fields. ONE procedure for every field, replacing the old
   * updateDraft / updatePublicContent pair — the split existed only because the
   * public content used to be added after approval, and it no longer is.
   *
   * WHAT IS WRITABLE IS DECIDED BY `editScope` ON THE STORED STATUS, imported
   * rather than re-derived, so the client and the server cannot drift:
   *   "all"     draft / changes_requested — every field
   *   "public"  published — bannerUrl, photoUrls, publicDescription only
   *   "none"    submitted / declined / canceled — refused with EVENT_LOCKED
   *
   * A PAYLOAD CARRYING title WHILE PUBLISHED IS NOT AN ERROR; the field is
   * silently ignored. The head's browser may hold a stale status, and erroring
   * would lose their banner edit to a race. The server states the truth; the UI
   * does not offer the fields.
   *
   * NO AUDIT ROW. Field saves are not state-machine transitions — see
   * AUDIT_ACTIONS in services/roles.ts for why.
   */
  update: identifiedProcedure
    .input(updateEventInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      const scope = editScope(normalizeStatus(event.status));
      if (scope === "none") {
        // Includes `submitted`: an event in the review queue is FROZEN so the
        // reviewer never decides text that changed underneath them. The way out
        // is event.withdraw, which is a visible transition — the client must not
        // paper over this by auto-withdrawing.
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "EVENT_LOCKED",
        });
      }

      const data: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: userID,
      };

      // Public content — writable in BOTH scopes.
      if (input.publicDescription !== undefined)
        data.publicDescription = input.publicDescription;
      if (input.bannerUrl !== undefined) data.bannerUrl = input.bannerUrl;
      if (input.photoUrls !== undefined) data.photoUrls = input.photoUrls;

      if (scope === "all") {
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

        if (input.title !== undefined) data.title = input.title;
        if (input.description !== undefined)
          data.description = input.description;
        if (input.startTime !== undefined) data.startTime = input.startTime;
        if (input.endTime !== undefined) data.endTime = input.endTime;
        if (input.location !== undefined) data.location = input.location;
        if (input.capacity !== undefined) data.capacity = input.capacity;

        // Facility <-> location. A number selects a facility (denormalize its
        // name, overriding any location text sent above); explicit null switches
        // to "Other" (keep/clear the free text); undefined leaves both untouched.
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
      }

      await ctx.db.event.update({ where: { eventID: input.eventID }, data });

      // Delete blobs this save replaced/removed (non-fatal). Every URL here was
      // proven ours by updateEventInput; `event.*` came from our row.
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

  /**
   * Hand a FINISHED event to the JCRC. The completeness check below is the
   * whole of D-3: the banner and the public description are required HERE, not
   * at some later publish step, because the reviewer's question is "may this go
   * on the hall calendar as written", not "is this proposal acceptable".
   */
  submitForReview: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      if (editScope(normalizeStatus(event.status)) !== "all") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_SUBMITTABLE",
        });
      }
      // Completeness is enforced HERE, not on every save, so partial progress
      // can be stored.
      const missing: string[] = [];
      if (!event.title?.trim()) missing.push("title");
      if (!event.description?.trim()) missing.push("description");
      if (event.startTime == null) missing.push("startTime");
      if (!event.location?.trim()) missing.push("location");
      if (!event.bannerUrl) missing.push("banner");
      if (!event.publicDescription?.trim()) missing.push("publicDescription");
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
          // Clear a prior decision so the reviewer sees a clean submission.
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        // AuditEntry.targetCcaID is `number | undefined`, never `number | null`
        // (admin.ts). `?? null` does not compile; `as number` compiles and writes
        // garbage. This spelling appears at every audit site in this file.
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action: "event.submit",
        reason: event.title ?? undefined,
      });
      return { status: "submitted" as const };
    }),

  /**
   * Pull an event back OUT of the review queue: `submitted` -> `draft`.
   *
   * WHY THIS EXISTS AT ALL. `submitted` is locked (editScope "none"), so a head
   * who needs to fix a typo cannot simply edit — and unlocking `submitted`
   * instead would let a reviewer approve words that changed five seconds
   * earlier. A withdrawal is a transition the reviewer can OBSERVE: the item
   * leaves the queue, and when it returns it returns as a fresh submission with
   * a new updatedAt, sorted to the back of a queue ordered `updatedAt asc`.
   *
   * NOT THE SAME ACT AS CANCEL, and the two must never be merged into one
   * button. Withdraw means "I am still doing this event, stop reviewing it for a
   * moment". Cancel means "this event is not happening" and is terminal.
   *
   * Notes for anyone tempted to tidy this up:
   *  - `identifiedProcedure`, not `roleManagerProcedure`. This is the OWNER's
   *    action over their own event; loadOwnedEvent covers both the CCA case and
   *    the hall case in one place.
   *  - the guard is `!== "submitted"`, NOT editScope. Withdrawing is not
   *    editing: a draft is already withdrawn, and a published event is
   *    cancelled rather than withdrawn.
   *  - NO booking cleanup. A submitted event has no bookingID — the auto-book
   *    runs on approval, which by definition has not happened. Copying
   *    cancelEvent's deleteMany here would be dead code that looks load-bearing.
   *  - the queue removal is IMPLICIT. listForReview filters `status:
   *    "submitted"`, so the status write IS the removal; there is nothing else
   *    to keep in sync.
   */
  withdraw: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      if (normalizeStatus(event.status) !== "submitted") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_WITHDRAWABLE",
        });
      }

      // THE STATUS GOES IN THE `where` — the mirror image of `decide`'s guard,
      // and the more damaging half of the same race. Between the read at :675
      // and this write, a reviewer can approve: this update would then set a
      // PUBLISHED event back to `draft` while leaving publishedAt stamped and
      // any auto-created booking in place. The event vanishes from the
      // residents' timeline with no cancel and no audit trail of an
      // unpublishing, because no such transition exists — published -> draft is
      // not in the state machine at all. Atomic match, so the loser writes
      // nothing and is told the truth.
      const applied = await ctx.db.event.updateMany({
        where: { eventID: input.eventID, status: "submitted" },
        data: {
          status: "draft",
          // The same three fields submitForReview clears. A withdrawn event
          // carries no decision, and a stale changes_requested reason left on a
          // draft would render the "JCRC asked for changes" panel on an event
          // the JCRC is no longer looking at.
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
      if (applied.count === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_WITHDRAWABLE",
        });
      }

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action: "event.withdraw",
        reason: event.title ?? undefined,
      });
      return { status: "draft" as const };
    }),

  /**
   * The owner calling the event off. TERMINAL, and reachable from every
   * non-terminal state — a head who changes their mind about an unsubmitted
   * event and a head calling off a published one are the same fact about the
   * same row, so there is one terminal word and one audit row.
   *
   * THERE IS NO HARD DELETE. A delete path over a collection keyed by a counter
   * is a new destructive primitive, and nothing is gained by it.
   */
  cancelEvent: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      const status = normalizeStatus(event.status);
      if (status === "declined" || status === "canceled") {
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

      await releaseEventBooking(ctx.db, event);

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action: "event.cancel",
        reason: event.title ?? undefined,
      });
      return { status: "canceled" as const };
    }),

  /**
   * The REVIEWER cancelling a PUBLISHED event. Published only — an event still
   * in the queue is declined, not cancelled.
   *
   * A reason is MANDATORY (reviewerCancelInput), because the owning head is not
   * asked first and the record has to say why. It writes the same
   * `event.cancel` action as the head's cancel: writeAudit denormalises
   * actorRoles onto the row, so `actorRoles contains "jcrc"` already selects
   * reviewer cancellations and a separate action name would be a duplicate.
   *
   * Same live capability re-check as `decide`, for the same reason (I-5): the
   * builder proves the caller was a manager when the session was minted, the
   * re-read proves they still are.
   */
  reviewerCancel: roleManagerProcedure
    .input(reviewerCancelInput)
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
      if (normalizeStatus(event.status) !== "published") {
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
          decisionReason: input.reason,
          decidedAt: new Date(),
          decidedBy: userID,
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });

      await releaseEventBooking(ctx.db, event);

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action: "event.cancel",
        reason: input.reason,
      });
      return { status: "canceled" as const };
    }),

  /**
   * Copy an event into a fresh, unsubmitted one. A recurring event is N
   * duplicates, which is what the heads asked for and costs no schema — there is
   * no series or recurrence model.
   *
   * IT DOES NOT COPY bannerUrl OR photoUrls, and that is FORCED, not chosen.
   * isOwnEventBlobUrl requires a URL's path to start with
   * `/event/{eventID}/{kind}`, so a banner copied from event 12 fails validation
   * for event 13 — the duplicate's first save would be rejected by the very
   * check that is the security boundary. The wrong fix is to relax that check to
   * accept any `event/*` path, which would let a head attach another CCA's
   * private image to their own event by URL. Copying the blob server-side is the
   * other alternative and is deferred: it means a put() inside a mutation that
   * currently cannot fail on I/O, plus orphan cleanup if the copy is discarded.
   */
  duplicate: identifiedProcedure
    .input(eventIdInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const source = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      const eventID = await nextEventId(ctx.db);
      await ctx.db.event.create({
        data: {
          eventID,
          // EXPLICIT, including when null — see `create`. A duplicated hall
          // event that omitted this key would vanish from the hall list.
          ccaID: source.ccaID,
          createdBy: userID,
          // No title on the original means no title on the copy. Do not
          // synthesise one; the list already renders "Untitled event".
          title: source.title ? `${source.title} (copy)` : null,
          description: source.description,
          startTime: source.startTime,
          endTime: source.endTime,
          location: source.location,
          facilityID: source.facilityID,
          capacity: source.capacity,
          publicDescription: source.publicDescription,
          // Images are NOT copied (see the docblock). Written explicitly rather
          // than omitted, for the same absent-vs-null reason as ccaID.
          bannerUrl: null,
          photoUrls: [],
          // A fresh copy carries no decision, no publication and no booking.
          status: "draft",
          decidedAt: null,
          decidedBy: null,
          decisionReason: null,
          publishedAt: null,
          bookingID: null,
          autoBookFailed: false,
          // The four inert Phase-2 fields — explicit here for the same
          // absent-vs-null reason as ccaID, and NOT copied from the source: a
          // duplicate is a fresh event that has not opened attendance, has no
          // scanners, and has nothing purged. See `create`.
          attendanceOpensAt: null,
          attendanceClosesAt: null,
          scannerUserIDs: [],
          answersPurgedAt: null,
          createdAt: new Date(),
          updatedAt: null,
          updatedBy: null,
        },
      });

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: source.ccaID ?? undefined,
        targetEventID: eventID,
        action: "event.duplicate",
        reason: `from #${source.eventID}`,
      });
      return { eventID };
    }),

  /* ----------------------------- HEAD: monitoring ------------------------ */

  /**
   * The owner's list — a CCA's events, or (ccaID null) the hall-wide ones.
   *
   * THIS IS THE ONLY LIST AN AUTHORING SURFACE HAS, which is why the null branch
   * matters so much: a hall event that this query cannot reach is an event that
   * was created successfully and can never be managed again. `where: { ccaID:
   * input.ccaID }` is written unchanged because input.ccaID is already
   * `number | null` and Prisma renders null as a null MATCH — which finds stored
   * nulls and NOT absent keys, and is exactly why `create` and `duplicate` write
   * the field explicitly.
   *
   * Grep-verified: this is the only Prisma `where` on Event keyed by ccaID in the
   * repo. Every other Event query filters on status or eventID and therefore
   * already includes hall rows correctly.
   */
  listForOwner: identifiedProcedure
    .input(ccaIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      if (input.ccaID == null) {
        if (!computeCapabilities(roles).manageHallEvents) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "CAPABILITY_REQUIRED:manageHallEvents",
          });
        }
      } else {
        await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);
      }

      const events = await ctx.db.event.findMany({
        where: { ccaID: input.ccaID }, // null here matches STORED nulls
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

  getForOwner: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);
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
      await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

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
      await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

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
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

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
        targetCcaID: event.ccaID ?? undefined,
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
    const names = await attachCcaNames(ctx.db, nameableCcaIDs(events));
    return {
      events: events.map((e) => ({
        eventID: e.eventID,
        ccaID: e.ccaID,
        ccaName: ownerName(e.ccaID, names),
        title: e.title,
        startTime: e.startTime,
        location: e.location,
        updatedAt: e.updatedAt,
      })),
    };
  }),

  /**
   * One event, for the reviewer's detail page.
   *
   * DELIBERATELY NOT NARROWED TO `submitted`. A head can withdraw an event while
   * the JCRC has it open, and a reviewer who clicks a stale queue row must reach
   * a record that says "this was withdrawn" — not NO_SUCH_EVENT, which would send
   * them looking for a deleted event that exists. The QUEUE filters; this fetch
   * does not. The client branches on the returned status.
   */
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
      const names = await attachCcaNames(ctx.db, nameableCcaIDs([event]));
      return {
        event: { ...event, status: normalizeStatus(event.status) },
        ccaName: ownerName(event.ccaID, names),
      };
    }),

  /**
   * The JCRC decision. THREE outcomes, and approval PUBLISHES.
   *
   *   approve          -> published, stamps publishedAt, runs the auto-book
   *   request_changes  -> changes_requested, reopens the event for editing
   *   decline          -> declined, TERMINAL
   *
   * `event.publish` no longer exists as a procedure. It only ever was the
   * waiting room between the JCRC's yes and the head's banner upload, and the
   * banner is now required BEFORE submission — so the waiting room had no
   * occupant and no exit condition, i.e. an event that was allowed to happen and
   * that nobody could see, pending a second button the head was never told about.
   *
   * THE LIVE CAPABILITY RE-CHECK STAYS. roleManagerProcedure proves the caller
   * was a manager when the session was minted; the getUserRoles read below
   * proves they still are (I-5). Folding publish into this does not relax it,
   * and a "register and publish" convenience procedure must never re-implement
   * it — see the client-sequenced flow the hall surface uses instead.
   */
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

      const nextStatus =
        input.decision === "approve"
          ? "published"
          : input.decision === "request_changes"
            ? "changes_requested"
            : "declined";
      // THE STATUS GOES IN THE `where`, NOT ONLY IN THE CHECK ABOVE.
      //
      // The read at :1162 and this write are two round trips, and `withdraw` is
      // a mutation a head can land in between them — that is the whole premise
      // of T-10, which so far only made the READ honest. Guarding the write
      // with `findUnique` + `if` leaves the classic check-then-act hole: the
      // reviewer's decide loads a `submitted` row, the head withdraws it to
      // `draft`, and this update then writes `published` over the draft. That is
      // the illegal transition draft -> published — an event live on the
      // residents' timeline that its owner believes they pulled out of the
      // queue, with a publishedAt and a decision on a row nobody submitted.
      //
      // `updateMany` with the status in the `where` makes the check and the
      // write ONE atomic document match, so the loser of the race writes
      // nothing and gets the same NOT_UNDER_REVIEW the pre-check throws. The
      // pre-check above is kept: it distinguishes NO_SUCH_EVENT from a bad
      // status and it is what the common, uncontended path reports.
      //
      // Matching the RAW column is correct here and is NOT the T-7 trap:
      // normalizeStatus's fallback is "draft", so "submitted" is never a value
      // it invents — a raw "submitted" and a normalised "submitted" are the
      // same set of rows.
      const applied = await ctx.db.event.updateMany({
        where: { eventID: input.eventID, status: "submitted" },
        data: {
          status: nextStatus,
          decidedAt: new Date(),
          decidedBy: userID,
          decisionReason: input.reason ?? null,
          // Approval publishes in the SAME write. There is no separate publish
          // step and no `approved` state to pass through.
          ...(input.decision === "approve" ? { publishedAt: new Date() } : {}),
        },
      });
      if (applied.count === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_UNDER_REVIEW",
        });
      }

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
                // 0 IS THE RESERVED "no CCA" SENTINEL — see cascade.ts's
                // RESERVED_CCAID guard and BookingModal.tsx, which writes 0 on
                // every booking the resident UI creates (3,841 rows and rising).
                //
                // A hall event has Event.ccaID null; a Bookings row CANNOT.
                // Bookings.ccaID is a required Int and MUST NOT become nullable:
                // that would put a SECOND value meaning "absent" into the largest
                // collection in the database, where 0 already means it and where
                // cascade.ts guards only 0. `event.ccaID!` would compile and then
                // write null into a required Int, surfacing later as a Prisma
                // throw in someone else's query, on a booking nobody can explain.
                //
                // Two collections, two spellings of "no CCA", and that is
                // correct — they are different namespaces with different
                // constraints. Do not harmonise them.
                ccaID: event.ccaID ?? 0,
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
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action:
          input.decision === "approve"
            ? "event.approve"
            : input.decision === "request_changes"
              ? "event.changes"
              : "event.decline",
        reason:
          autoBook === "booked"
            ? `${input.reason ? input.reason + "; " : ""}auto-booked facility #${event.facilityID}`
            : autoBook === "conflict"
              ? `${input.reason ? input.reason + "; " : ""}facility #${event.facilityID} clash — not booked`
              : (input.reason ?? undefined),
      });
      return {
        status: nextStatus as "published" | "changes_requested" | "declined",
        autoBook,
      };
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
   * is a nullable String). Nothing else: no internal description, no attendee
   * data, no PII. Oversight is "what is happening", not "who is going";
   * exportAttendees stays owner-scoped. The `select` is explicit so the wide
   * fields are never even READ, rather than read and then dropped — the
   * `description` and `publicDescription` of every event in the hall is a lot of
   * bytes to pull across just to throw away.
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
      // it means in decide's NOT_UNDER_REVIEW check and in editScope.
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

      const names = await attachCcaNames(ctx.db, nameableCcaIDs(events));
      return {
        events: events.map((e) => ({
          eventID: e.eventID,
          ccaID: e.ccaID,
          ccaName: ownerName(e.ccaID, names),
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
   * handed the head's internal description and the private decision trail, from
   * a capability whose entire description is "view events, read-only".
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
      const names = await attachCcaNames(ctx.db, nameableCcaIDs([event]));

      const full = { ...event, status: normalizeStatus(event.status) };
      if (capabilities.reviewEvents) {
        return { event: full, ccaName: ownerName(event.ccaID, names) };
      }

      // If the hall office is ever meant to read the internal record, edit
      // SCRC_HIDDEN_EVENT_FIELDS rather than deleting this branch — the branch
      // is also what keeps the manager path provably untouched.
      return {
        event: { ...full, ...SCRC_HIDDEN_EVENT_FIELDS },
        ccaName: ownerName(event.ccaID, names),
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
      attachCcaNames(ctx.db, nameableCcaIDs(events)),
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
        ccaName: ownerName(e.ccaID, names),
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
      // public. draft/submitted/changes_requested/declined are NOT — treat as
      // not found so their existence isn't disclosed.
      const status = normalizeStatus(event?.status);
      if (!event || (status !== "published" && status !== "canceled")) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }

      const [names, signupCount, mine] = await Promise.all([
        attachCcaNames(ctx.db, nameableCcaIDs([event])),
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
        ccaName: ownerName(event.ccaID, names),
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
      attachCcaNames(ctx.db, nameableCcaIDs(events)),
      signupCounts(
        ctx.db,
        events.map((e) => e.eventID),
      ),
    ]);
    return {
      events: events.map((e) => ({
        ...toPublicCard(e),
        ccaName: ownerName(e.ccaID, names),
        signupCount: counts.get(e.eventID) ?? 0,
        mySignup: true,
      })),
    };
  }),
});
