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
import {
  isLiveCcaMember,
  membershipKeysForKey,
} from "~/server/api/services/ccaMembers";
import {
  checkInInput,
  manualCheckInInput,
  undoCheckInInput,
  saveScannersInput,
  parseCheckInPayload,
  resolveAttendanceWindow,
  normalizeMethod,
} from "~/lib/schemas/eventAttendance";
import {
  mintCheckInToken,
  verifyCheckInToken,
  isQrConfigured,
} from "~/server/api/services/eventQr";
import { assertScrcEnabled } from "~/server/api/services/scrcFlag";
import { writeAudit } from "~/server/api/routers/admin";
import {
  assertAttendanceEnabled,
  assertEventsEnabled,
  assertQuestionsEditable,
  isAttendanceEnabled,
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
  eventSignupInput,
  ccaIdInput,
  normalizeStatus,
  editScope,
  EVENT_STATUSES,
  HALL_OWNER_LABEL,
} from "~/lib/schemas/event";
import {
  answersAreRetained,
  saveQuestionsInput,
  validateAnswers,
} from "~/lib/schemas/eventQuestion";

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
 * WHO MAY SCAN AT THIS EVENT'S DOOR. Like `loadOwnedEvent`, THE BRANCH LIVES IN
 * EXACTLY ONE PLACE — every check-in path goes through here.
 *
 * Two ways in: you own the event, or the head nominated you AND you are still a
 * member. Nothing else, and no role string shortcut.
 *
 * THE STORED LIST IS NECESSARY, NEVER SUFFICIENT. `Event.scannerUserIDs` is
 * written once, when the head sets the event up. A nominee who later leaves the
 * CCA — or is removed from it — keeps their entry in that array forever,
 * because nothing sweeps it. Re-validating against live membership is the same
 * argument `assertHeadsCca` makes for reading `CcaHead` directly instead of
 * trusting `roles.includes("cca_head")`, and the same one I-5 makes for
 * `getUserRoles`.
 *
 * `isLiveCcaMember` checks all THREE places membership lives, not just the
 * obvious `UserCCA` rows — see its docblock. A UserCCA-only check would deny
 * roughly a third of every CCA, at a door, with a queue.
 */
async function assertMayScan(
  db: PrismaClient,
  userID: string,
  roles: string[],
  event: { ccaID: number | null; scannerUserIDs: string[] },
): Promise<void> {
  // 1. The owner always may — the same two ownership shapes as loadOwnedEvent.
  if (event.ccaID == null) {
    if (computeCapabilities(roles).manageHallEvents) return;
  } else {
    try {
      await assertHeadsCca(db, { userID, roles }, event.ccaID);
      return;
    } catch {
      // Not a head of this CCA. Fall through to the nominee branch rather than
      // rethrowing: being nominated is a second, independent way in, and
      // assertHeadsCca's FORBIDDEN would otherwise mask it.
    }
  }

  // 2. A nominee.
  //
  // MATCHED ACROSS THE WHOLE KEY SPACE, NOT ON THE CANONICAL ID ALONE, and this
  // is load-bearing rather than defensive. `userID` here is
  // `session.user.userID` = `canonicalUserID(email)`. What is STORED in
  // `scannerUserIDs` came out of `cca.memberDirectory`, whose `userID` field is
  // `e.storedUserID` = the `User.userID` COLUMN (services/ccaRoster.ts) — and
  // `schema.prisma` states above `UserMatric` that ~515 rows hold an A-format
  // matric there. A bare `.includes(userID)` therefore compares two DIFFERENT
  // key spaces and returns false for every nominee whose stored column is not
  // the canonical id: the head picks them out of the live directory, the save
  // succeeds, and then the door tells them they are not on the list. That is
  // precisely the failure the live-membership re-validation below exists to
  // avoid, arriving one line earlier through the key instead of the source.
  //
  // THIS DOES NOT WIDEN THE GRANT. `membershipKeysForKey` derives both keys
  // from the caller's OWN `User` row (their session email and their stored
  // column); nothing here is client-supplied, so the set of PEOPLE admitted is
  // unchanged — only the set of SPELLINGS that names them. Being on the list is
  // still necessary and never sufficient: live membership is re-checked below.
  const callerKeys = await membershipKeysForKey(db, userID);
  if (!callerKeys.some((k) => event.scannerUserIDs.includes(k))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_A_SCANNER" });
  }

  if (event.ccaID == null) {
    // A HALL EVENT HAS NO MEMBERSHIP SET TO RE-VALIDATE AGAINST. The only
    // meaningful live check is the capability itself, re-read by the caller
    // (I-5). In practice this branch is unreachable from the UI, because every
    // hall nominee must hold manageHallEvents and branch 1 already admitted
    // them — which is why no nominee picker is rendered for hall events at all.
    if (!computeCapabilities(roles).manageHallEvents) {
      throw new TRPCError({ code: "FORBIDDEN", message: "NOT_A_SCANNER" });
    }
    return;
  }

  if (!(await isLiveCcaMember(db, event.ccaID, userID))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_A_SCANNER" });
  }
}

/**
 * Free the facility a cancelled event was holding: delete the auto-created
 * Bookings row so the slot reopens.
 *
 * NON-FATAL by design — a missing booking (already deleted, or never made
 * because the slot clashed at approval) is a normal outcome, not an error, and
 * an event must not be left half-cancelled because a cleanup delete failed.
 *
 * IT RE-READS `bookingID` ITSELF, and takes an eventID rather than a row FOR
 * EXACTLY THAT REASON. It used to be handed the row its caller had loaded
 * before the status write, and to run AFTER the caller had already nulled
 * Event.bookingID — which meant the cleanup decided what to free from a value
 * read one or more round trips earlier, and threw away the only pointer to the
 * booking before looking. `decide` stamps `bookingID` in a SEPARATE write after
 * it publishes (the auto-book takes a facility lock first), so a cancel landing
 * in that window read `bookingID: null`, freed nothing, and then had the
 * booking written onto the row it had just cancelled: a canceled event holding
 * a room, with no pointer left to find it by. Reading the CURRENT value after
 * the status write closes that window.
 *
 * ORDER IS LOAD-BEARING: delete the Bookings row FIRST, null the pointer
 * SECOND. The reverse loses the pointer if the delete fails, which is the
 * orphan this function exists to prevent; this order at worst leaves a
 * `bookingID` pointing at an already-deleted booking, which is inert and which
 * a re-run cleans up.
 *
 * Shared by cancelEvent and reviewerCancel. Two cancels, one cleanup: the head
 * and the reviewer must not be able to leave the room booked in different
 * circumstances.
 */
async function releaseEventBooking(
  db: PrismaClient,
  eventID: number,
): Promise<void> {
  try {
    const fresh = await db.event.findUnique({
      where: { eventID },
      select: { bookingID: true },
    });
    const bookingID = fresh?.bookingID ?? null;
    if (bookingID == null) return;
    await db.bookings.deleteMany({ where: { bookingID } });
    await db.event.update({ where: { eventID }, data: { bookingID: null } });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "event_booking_delete_failed",
        eventID,
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
 *   scannerUserIDs  the SAME canonical-id class, and the one that is easy to
 *                   miss because it is INERT: D-17 landed it for the attendance
 *                   phase and nothing reads or writes it yet, so leaving it out
 *                   of this list costs nothing TODAY and leaks a list of every
 *                   door scanner in the hall the day the attendance phase fills
 *                   it in — silently, through a procedure whose whole
 *                   description is "view events, read-only", with no diff to
 *                   this file to notice. Exactly the argument `create` makes
 *                   for writing the four inert fields explicitly: the cost of
 *                   handling an inert field now is one line, and the cost of
 *                   discovering the omission later is an incident. It is a
 *                   LIST, so it blanks to `[]` rather than null — an empty
 *                   scanner list means "nobody", which is the honest redaction
 *                   here, and it keeps the field's TYPE intact for the client.
 *
 * `ccaID` stays: it names an organisation, not a person, and the hall office
 * already has the full CCA list. `decidedAt`, `publishedAt`, `createdAt` and
 * `updatedAt` stay — "when did this move" is a pipeline fact and is the whole
 * point of watching the pipeline. The other three inert Phase-2 fields
 * (attendanceOpensAt, attendanceClosesAt, answersPurgedAt) are TIMESTAMPS, not
 * identities, and stay for the same reason the other timestamps do.
 *
 * Blanked rather than deleted, so the response SHAPE is identical for both
 * tiers and no client has to branch on field presence.
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
  scannerUserIDs: [],
} as const satisfies Partial<Record<keyof Event, null | readonly string[]>>;

/**
 * WHAT "BLANK" MEANS ON AN EVENT ROW — ONE DEFINITION, USED TWICE.
 *
 * D-30's reuse rule needs two things to agree exactly: the `where` that FINDS a
 * blank draft, and the `create` that MAKES one. While they were two hand-written
 * lists in two places they drifted immediately — `create` omitted
 * `publicDescription` and `bannerUrl` while the filter demanded both be null,
 * and because Prisma's null match is the strict one (T-12) a row created here
 * could never match the filter meant to find it. Reuse never fired once; every
 * press of "New event" allocated a new id, silently, with a green build.
 *
 * THE TWO LISTS ARE NOW THE SAME OBJECT, so that drift is no longer a matter of
 * discipline:
 *   - spread into the reuse `where`, it IS the blankness condition;
 *   - spread FIRST into `create`'s `data`, it guarantees every one of these keys
 *     is written explicitly — later keys in the same object literal override it
 *     with the caller's real values.
 * Add a field here and both sides move together. Add one to the create only and
 * the filter ignores it, which costs at worst one extra blank row. The dangerous
 * direction — a filter key that the create never writes — can no longer be
 * expressed at all.
 *
 * NOT the four inert Phase-2 fields (attendanceOpensAt, attendanceClosesAt,
 * scannerUserIDs, answersPurgedAt). `create` must write those for the same T-12
 * reason, but they are not part of BLANKNESS: nothing a head types sets them, so
 * requiring them in the filter would be noise. They stay spelled out at the
 * create site, with the comment that explains why.
 *
 * `satisfies Partial<Record<keyof Event, null>>` is the guard
 * SCRC_HIDDEN_EVENT_FIELDS uses above: a renamed or deleted column fails the
 * build here rather than quietly becoming a filter key that matches nothing.
 */
const BLANK_EVENT_CONTENT = {
  title: null,
  description: null,
  publicDescription: null,
  bannerUrl: null,
  startTime: null,
  endTime: null,
  location: null,
  facilityID: null,
  capacity: null,
  // ADDED BY PART C (D-59a). Both are Int?, so `null` is a legal value and the
  // `satisfies` guard accepts them. Safe in the only direction that matters:
  // `create` and `duplicate` have written both explicitly as null since they
  // were added, so every row this filter is meant to find already carries the
  // keys and Prisma's strict null match (T-12) is satisfied. A row predating
  // that simply fails to match and the head gets one extra blank draft — the
  // benign direction, and the one this branch already commits to in writing.
  //
  // scannerUserIDs IS DELIBERATELY ABSENT AND CANNOT BE ADDED. It is
  // `String[] @default([])`, a non-nullable list whose absent value is `[]`,
  // not `null`, so it does not satisfy Partial<Record<keyof Event, null>> and
  // adding it does not compile. IF YOU HIT THAT BUILD ERROR, DO NOT LOOSEN THIS
  // `satisfies` CLAUSE TO ADMIT IT — the clause is what keeps this filter safe
  // against a renamed column, and loosening it IS the defect. It is checked in
  // JS below instead, beside the question count, for the same reason.
  attendanceOpensAt: null,
  attendanceClosesAt: null,
} as const satisfies Partial<Record<keyof Event, null>>;

/**
 * WHAT ANYONE MAY SEE OF A QUESTION — one projection, used by getPublic (every
 * authenticated resident on a published event), getForReview (the JCRC) and
 * getQuestionsForOwner (the head).
 *
 * It is the whole row minus `id`, `eventID` and `createdAt`. THERE IS NO PII AND
 * NO CANONICAL ID ON THIS MODEL AT ALL, which is why it needs no redaction list
 * and why the same projection is safe for all three audiences. If a later phase
 * puts an identity key on EventQuestion, this stops being true and the SCRC
 * question (T-30) has to be asked again.
 *
 * `select`ed explicitly rather than spread, so a future column is opt-IN.
 */
const PUBLIC_QUESTION_FIELDS = {
  questionID: true,
  order: true,
  type: true,
  label: true,
  helpText: true,
  required: true,
  options: true,
  maxLength: true,
} as const;

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

      // D-30 — REUSE THE CALLER'S EXISTING BLANK DRAFT instead of making a
      // second one.
      //
      // D-29 turned "New event" from a link into a mutation BUTTON, so without
      // this rule every stray press leaves a row behind and the number of
      // abandoned blanks grows without bound. With it, the maximum number of
      // live blank drafts is ONE per (owner scope, creator): press the button
      // ten times and you land on the same row ten times.
      //
      // ONLY FOR A BARE CREATE. A payload carrying any content field allocates a
      // fresh id exactly as it does today — `duplicate` and any future
      // create-with-content path are unaffected.
      //
      // THE RACE IS REAL AND SELF-HEALS. Two tabs pressing the button at once
      // both find nothing and both create. That leaves two blanks, the next
      // press reuses one of them, and sweep-blank-event-drafts.mjs (D-33)
      // removes the other. Serialising this behind withEventLock would be more
      // machinery than the outcome justifies.
      // DERIVED FROM THE INPUT OBJECT, NOT FROM A HAND-WRITTEN LIST OF FIELDS.
      // The hand-written version listed the seven content fields
      // createEventInput happens to carry TODAY. Add an eighth to the schema —
      // Phase 2's question rows are the obvious candidate — and the old spelling
      // would keep returning true for a payload that carried it, so the reuse
      // branch below would hand back an existing row and DISCARD the new
      // content, silently, with the caller told it succeeded. Enumerating the
      // parsed input instead means a new field is covered the moment it is added
      // to the schema, with no second edit here. `ccaID` is excluded because it
      // is the OWNER SCOPE, not content: it is resolved above and is part of the
      // reuse key, not of blankness.
      const isBareCreate = Object.entries(input).every(
        ([key, value]) => key === "ccaID" || value == null,
      );
      if (isBareCreate) {
        const existing = await ctx.db.event.findFirst({
          where: {
            // WRITTEN EXPLICITLY, EVEN WHEN NULL — T-12, the same rule as the
            // create below. `{ ccaID: null }` matches a STORED null and NOT an
            // absent key, and the hall branch depends on exactly that. This is
            // the RESOLVED local from the ownership branch above, which is
            // `input.ccaID ?? null` by construction.
            ccaID,
            // createdBy is in the filter so a CCA with two heads never has head
            // B silently adopt head A's abandoned blank. That would put B's
            // edits on a row A believes is theirs, and `createdBy` would then
            // name the wrong person on every audit row the event ever writes.
            createdBy: userID,
            status: "draft",
            // EVERY content field is in the filter, not just `status`. A row
            // with a title is not blank, and reusing it would silently discard
            // whatever the head typed and saved earlier. The filter is
            // DELIBERATELY OVER-STRICT: the worst case of a MISSED reuse is one
            // extra blank row; the worst case of a WRONG reuse is lost work.
            //
            // SPREAD FROM THE SAME OBJECT THE CREATE BELOW SPREADS, which is
            // what stops the two lists drifting apart again. See
            // BLANK_EVENT_CONTENT.
            ...BLANK_EVENT_CONTENT,
          },
          orderBy: { createdAt: "desc" },
          select: { eventID: true, photoUrls: true, scannerUserIDs: true },
        });
        // photoUrls is checked in JS and NOT in the `where`: Prisma+Mongo's
        // `equals: []` on a scalar list is a shape this repo has not used and
        // does not need, and the row is already in hand.
        if (existing && existing.photoUrls.length === 0) {
          // D-39a — A DRAFT THAT ALREADY CARRIES QUESTIONS IS NOT BLANK.
          //
          // THIS CANNOT GO IN THE `where` ABOVE. BLANK_EVENT_CONTENT is
          // `satisfies Partial<Record<keyof Event, null>>` and questions are a
          // SEPARATE COLLECTION with no relation field on Event, so blankness
          // as spelled there is structurally incapable of seeing them — not by
          // oversight, but by construction. The `satisfies` guard that makes
          // the filter safe against renamed columns is the same guard that
          // makes it blind to anything that is not a column. Checked here, in
          // JS, for exactly the same reason photoUrls is: the row is in hand.
          //
          // WHAT IT PREVENTS, and it is silent: a head presses New event,
          // builds six questions, never types a title and leaves. Days later
          // they press New event again, get this same row back with the six
          // questions still attached, fill in the details, and — because the
          // details editor is at the TOP of the screen and the builder is
          // BELOW it — press Submit for review without scrolling. The JCRC
          // then approves a form the head did not write this time, and the
          // first signup freezes it. Nothing throws and nothing logs.
          //
          // FALL THROUGH RATHER THAN DELETING THE QUESTIONS. The head may be
          // coming back TO those questions. Reuse exists to cap abandoned
          // rows, which is housekeeping; it must never outrank
          // not-destroying-work. The cost of falling through is one extra
          // abandoned row and one counter value (D-39b) — and that row is then
          // neither reusable here nor sweepable by
          // sweep-blank-event-drafts.mjs, whose condition 7 refuses to delete
          // a draft carrying questions. Both agree, deliberately; the sweep
          // REPORTS such rows so an operator can delete them by judgement.
          //
          // NOT a relation field on Event instead. Two independent refusals: it
          // would be a NEW Event COLUMN, which is an SCRC disclosure decision
          // every time (T-30); and a Prisma relation is not `null`, so it could
          // not satisfy Partial<Record<keyof Event, null>> and the guard would
          // have to be loosened for every field to admit one.
          //
          // Costs one count on the event_question index's leading eventID
          // prefix, only inside the isBareCreate branch and only when a
          // candidate row was actually found.
          const questionCount = await ctx.db.eventQuestion.count({
            where: { eventID: existing.eventID },
          });
          // D-59a — AND A DRAFT THAT ALREADY CARRIES NOMINATED SCANNERS IS NOT
          // BLANK EITHER. Same wall as the questions above, reached from the
          // opposite direction: questions are invisible to the `where` because
          // they are not a column at all, and scannerUserIDs is invisible
          // because it is a column of the WRONG SHAPE — `String[]`, whose
          // absent value is `[]` and not `null`. Free to check: the row is
          // already in hand and the field is already selected.
          //
          // THIS ONE IS AN AUTHORISATION BUG, NOT HOUSEKEEPING. Without it: a
          // head presses New event, scrolls to the Door section, nominates two
          // committee members, never types a title, and leaves. Weeks later
          // they press New event again, are handed that same row, fill in a
          // real event and submit it — and two people they did not choose now
          // hold a door surface that writes rows asserting where residents
          // physically were, while the head's screen shows an empty scanner
          // list. The Door section sits BELOW the questions builder, so the
          // same submit-without-scrolling path applies verbatim.
          //
          // The blast radius is bounded and saying so is part of the argument:
          // the filter is scoped to the same ccaID and the same createdBy, and
          // assertMayScan re-validates every nominee against LIVE membership,
          // so an inherited scanner is necessarily a current member of the same
          // CCA. Not a stranger — but still not the head's choice.
          if (questionCount === 0 && existing.scannerUserIDs.length === 0) {
            // RETURNS BEFORE nextEventId. Allocating an id and then discarding
            // it burns a counter value for no reason, and nextEventId never
            // goes backwards.
            return { eventID: existing.eventID };
          }
        }
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
          // FIRST, so every blankness key is written even if the explicit
          // assignments below stop naming one of them. The keys that follow
          // override these nulls with the caller's real values; any that stop
          // being named stay explicitly null, which is exactly what the reuse
          // filter above needs and what omitting them broke. See
          // BLANK_EVENT_CONTENT.
          ...BLANK_EVENT_CONTENT,
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
          // THE TWO PUBLIC-CONTENT FIELDS, EXPLICITLY NULL — same rule as
          // ccaID above, and omitting them was a REAL BUG found by pressing
          // "New event" twice in a browser. The D-30 reuse filter asks for
          // `publicDescription: null, bannerUrl: null` among its blankness
          // conditions. Prisma's null match is the strict one (that is the
          // whole premise of T-12), so a row created WITHOUT these keys does
          // not match a filter asking for them to be null — and this create is
          // the only thing that makes the rows the filter is meant to find.
          // Reuse could therefore never fire: every press of the button
          // allocated a new id, which is precisely the unbounded-blanks
          // outcome D-30 exists to prevent. Nothing errored; the cap was
          // simply never enforced.
          publicDescription: null,
          bannerUrl: null,
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
      //
      // AN EMPTY PUBLIC DESCRIPTION IS STORED AS `null`, NOT AS `""`.
      //
      // This is the only field on the row that can arrive as an empty string:
      // title / description / location all carry `.min(1)` in the schema, so ""
      // is rejected before it reaches here, and every other blank field is
      // nullable. `publicDescription` deliberately has no `.min(1)` (partial
      // progress must be savable), and DetailsEditor.buildPatch sends
      // `publicDescription.trim()` UNCONDITIONALLY — so a head who presses "New
      // event" and then "Save and finish later" without typing anything used to
      // write `""` onto an otherwise untouched row.
      //
      // THAT DEFEATED D-30. The reuse filter asks for `publicDescription: null`,
      // Prisma's null match is the strict one (T-12), and `"" !== null` — so
      // that one save made the row permanently unreusable and the next press of
      // "New event" allocated a fresh id. Pressing save on each new blank row in
      // turn reproduced exactly the unbounded-blanks growth D-30 exists to
      // prevent, one click further along than the bug that was already fixed in
      // `create`.
      //
      // NORMALISING AT THE WRITE, NOT LOOSENING THE FILTER. Accepting
      // `{ in: [null, ""] }` in the reuse filter would have made "" a second
      // spelling of absent that every future reader has to know about — the
      // two-values-meaning-absent class this repo has already remediated once
      // (see the ccaID note on the Event model). Everything else that asks "is
      // this blank" already trims: submitForReview's completeness check,
      // isBlankDraft in EventManage, and the sweep script's isBlank. Storing
      // null is what makes the strict filter agree with all three.
      if (input.publicDescription !== undefined)
        data.publicDescription = input.publicDescription.trim() || null;
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

      // ATOMIC STATUS WRITE (C-10 / D-37). This used to be a bare
      // `update` keyed on eventID alone, with the status checked one round trip
      // earlier against the row loadOwnedEvent read above. `cancelEvent` is
      // reachable from `draft` and `changes_requested` — exactly the two states
      // this procedure accepts — so that window admitted `canceled -> submitted`:
      // a RESURRECTED event, back in the JCRC queue, that its owner believes
      // they called off, with no cancellation trace on the row and an
      // `event.cancel` audit row now describing something that did not stick.
      // The same window admitted `declined -> submitted`, which the
      // NOT_SUBMITTABLE copy on the client already describes but the write did
      // not actually refuse.
      //
      // THE GUARD IS SPELLED NEGATIVELY, for the same reason cancelEvent's is:
      // `normalizeStatus` maps null and anything unrecognised to "draft", which
      // IS submittable, so only the negative form matches the editScope
      // pre-check above row for row. A positive `in: ["draft",
      // "changes_requested"]` would refuse a row whose stored status is null,
      // which the pre-check accepted.
      //
      // The findUnique pre-check STAYS: it separates NO_SUCH_EVENT from a bad
      // status, it supplies the row the audit write below needs, and it reports
      // the ordinary uncontended case.
      const applied = await ctx.db.event.updateMany({
        where: {
          eventID: input.eventID,
          NOT: {
            status: { in: ["submitted", "published", "declined", "canceled"] },
          },
        },
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
      if (applied.count === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_SUBMITTABLE",
        });
      }
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

      // THE STATUS GOES IN THE `where`, exactly as in `decide` and `withdraw`.
      // The read above and this write are two round trips, and `decide` is a
      // mutation a reviewer can land in between them: a cancel that loaded a
      // `submitted` row finds it `published` — with a room booked for it — by
      // the time it writes. The old unscoped update went through anyway, and
      // the cleanup below then freed nothing, because it was deciding from the
      // pre-race row. A canceled event silently kept the facility.
      //
      // `NOT ... in` rather than `in`: normalizeStatus maps null and anything
      // unrecognised to "draft", which IS cancelable, so the negative spelling
      // is the one that matches the check above row for row. (A positive `in`
      // list would refuse a null-status row that the check permits.)
      //
      // `bookingID` IS DELIBERATELY NOT NULLED HERE. releaseEventBooking now
      // re-reads it after this write and clears it once the booking is gone —
      // nulling it first is what threw away the pointer.
      const applied = await ctx.db.event.updateMany({
        where: {
          eventID: input.eventID,
          NOT: { status: { in: ["declined", "canceled"] } },
        },
        data: {
          status: "canceled",
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
      if (applied.count === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_CANCELABLE",
        });
      }

      await releaseEventBooking(ctx.db, input.eventID);

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

      // Scoped on `published` for the same reason cancelEvent is scoped on
      // "not terminal": the owning head can cancel, and `decide` can still be
      // stamping this row's bookingID, between the read above and this write.
      // Same atomic match, same NOT_CANCELABLE for the loser.
      const applied = await ctx.db.event.updateMany({
        where: { eventID: input.eventID, status: "published" },
        data: {
          status: "canceled",
          decisionReason: input.reason,
          decidedAt: new Date(),
          decidedBy: userID,
          updatedAt: new Date(),
          updatedBy: userID,
        },
      });
      if (applied.count === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_CANCELABLE",
        });
      }

      await releaseEventBooking(ctx.db, input.eventID);

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
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      const [signups, questions] = await Promise.all([
        ctx.db.eventSignup.findMany({
          where: { eventID: input.eventID },
          select: { userID: true, createdAt: true, answers: true },
          orderBy: { createdAt: "asc" },
        }),
        ctx.db.eventQuestion.findMany({
          where: { eventID: input.eventID },
          orderBy: { order: "asc" },
          select: PUBLIC_QUESTION_FIELDS,
        }),
      ]);
      const resolved = await resolveAttendees(
        ctx.db,
        signups.map((s) => s.userID),
      );
      // D-52 LAYER 1 — THE READ CUTOFF, AND IT NEEDS NOBODY. Once sixty days
      // have passed since (endTime ?? startTime) this returns no answers AT
      // ALL, whether or not the rows still hold them and whether or not
      // answersPurgedAt is set. That is what makes the retention promise true
      // in the application on time, independently of any operator — layer 2,
      // purge-event-answers.mjs, is a script a human runs and there is no cron
      // in this repository. The questions themselves are still returned: the
      // table and the CSV keep their columns and fill every answer cell with a
      // literal em dash, because a BLANK cell says "this person didn't answer",
      // which is a different and false claim (T-29).
      const answersRetained = answersAreRetained(
        event.endTime,
        event.startTime,
        Math.floor(Date.now() / 1000),
      );
      return {
        questions,
        answersRetained,
        attendees: signups.map((s) => ({
          ...(resolved.get(s.userID) ?? {
            userID: s.userID,
            displayName: null,
            matric: null,
            block: null,
            telegramHandle: null,
          }),
          signedUpAt: s.createdAt,
          answers: answersRetained ? s.answers : [],
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

      const [signups, questions] = await Promise.all([
        ctx.db.eventSignup.findMany({
          where: { eventID: input.eventID },
          select: { userID: true, createdAt: true, answers: true },
          orderBy: { createdAt: "asc" },
        }),
        ctx.db.eventQuestion.findMany({
          where: { eventID: input.eventID },
          orderBy: { order: "asc" },
          select: PUBLIC_QUESTION_FIELDS,
        }),
      ]);
      const resolved = await resolveAttendees(
        ctx.db,
        signups.map((s) => s.userID),
      );
      // PII IS STILL JOINED LIVE. resolveAttendees is untouched: name, matric,
      // block and telegram come from User/UserMatric at export time, never from
      // a snapshot, so an export always reflects current profile data. THE
      // ANSWERS ARE THE ONE THING THAT IS STORED on the signup, because they
      // are an answer to a question at a moment, not a current fact about a
      // person.
      const answersRetained = answersAreRetained(
        event.endTime,
        event.startTime,
        Math.floor(Date.now() / 1000),
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
        answers: answersRetained ? s.answers : [],
      }));

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action: "event.attendees.export",
        // THE SAME AUDIT ROW, A STRICTLY LARGER PII PAYLOAD BEHIND IT. The
        // column count is what lets the log distinguish "exported 40 names"
        // from "exported 40 names and their answers" (D-53).
        reason: `${attendees.length} attendee(s), ${answersRetained ? questions.length : 0} answer column(s)`,
      });
      return {
        attendees,
        questions,
        answersRetained,
        title: event.title,
        eventID: event.eventID,
      };
    }),

  /* ------------------------- HEAD: signup questions ---------------------- */

  /**
   * The builder's read. Returns the whole list plus the two facts the UI must
   * NOT re-derive: `frozen` and `signupCount`.
   *
   * `frozen` IS COMPUTED SERVER-SIDE, from the same two conditions
   * assertQuestionsEditable enforces, so the screen and the write cannot
   * disagree about what is editable. A UI that re-derived it from `status`
   * alone would miss the zero-signups half and offer a head a form that fails
   * on save — which is T-35, and the reason QUESTIONS_FROZEN has its own
   * non-retryable copy.
   */
  getQuestionsForOwner: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      const [questions, signupCount] = await Promise.all([
        ctx.db.eventQuestion.findMany({
          where: { eventID: input.eventID },
          orderBy: { order: "asc" },
          select: PUBLIC_QUESTION_FIELDS,
        }),
        ctx.db.eventSignup.count({ where: { eventID: input.eventID } }),
      ]);
      return {
        questions,
        signupCount,
        frozen:
          editScope(normalizeStatus(event.status)) === "none" ||
          signupCount > 0,
      };
    }),

  /**
   * ONE WHOLE-LIST SAVE, under the lock, with never-reused ids.
   *
   * There is deliberately no per-question add / edit / delete / reorder
   * mutation. Reordering is the operation a builder does most, and a
   * per-question `order` patch is N writes that can half-apply. One list, one
   * reconciliation, one lock.
   *
   * WHY withEventLock AND NOT A NEW LOCK. It is keyed `event:{eventID}` and it
   * already serialises signup, so a question save and a signup CANNOT
   * interleave — which is precisely the guarantee the freeze needs. The cost is
   * T-38: a save can wait up to 5 s behind a burst of signups, or see "This
   * event is busy right now". Acceptable; a head editing a form is not on a hot
   * path, and a second mutex would be two locks that must be taken in a
   * consistent order, which is a deadlock waiting for a maintainer.
   *
   * NO AUDIT ROW (C-3, D-53). State-machine transitions are audited; field
   * saves are not, and questions are fields of an event. This fires on every
   * builder save and would bury the handful of rows that describe what actually
   * happened to an event.
   */
  saveQuestions: identifiedProcedure
    .input(saveQuestionsInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      // THE ONLY OWNERSHIP BRANCH. Never a role check — `cca_head` is
      // scope-free — and never re-derived inline.
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      return withEventLock(ctx.db, input.eventID, async () => {
        // INSIDE THE LOCK, NOT BEFORE IT. Outside, a signup can land between
        // the check and the write, and the first answer is then validated
        // against a form that changed.
        await assertQuestionsEditable(ctx.db, event);

        const existing = await ctx.db.eventQuestion.findMany({
          where: { eventID: input.eventID },
          select: { questionID: true },
        });
        const existingIDs = new Set(existing.map((q) => q.questionID));

        // MAX OF WHAT EXISTS, NOT THE COUNT. A list of three questions whose
        // ids are 1, 2 and 7 must allocate 8. And `maxID` keeps climbing across
        // this call, so a deleted question's id is never recycled — an answer
        // stored against question 3 would silently rebind to a different
        // question 3 the moment one was re-added, on a document nothing here
        // would flag.
        let maxID = existing.reduce((m, q) => Math.max(m, q.questionID), 0);

        const claimed = new Set<number>();
        const resolved = input.questions.map((q, index) => {
          let questionID: number;
          if (q.questionID == null) {
            questionID = ++maxID;
          } else {
            if (!existingIDs.has(q.questionID) || claimed.has(q.questionID)) {
              // Either the id is not on this event, or the payload named it
              // twice. Both mean the client is holding a list that is out of
              // step with the server, and both are unfixable by retrying.
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "NO_SUCH_QUESTION",
              });
            }
            questionID = q.questionID;
          }
          claimed.add(questionID);
          const help = q.helpText?.trim() ?? "";
          return {
            questionID,
            // ORDER IS THE ARRAY INDEX, rewritten for every kept question on
            // every save. Dense, 0-based, no gaps — a sparse `order` makes
            // orderBy stable but meaningless.
            order: index,
            type: q.type,
            label: q.label,
            helpText: help.length > 0 ? help : null,
            required: q.required ?? false,
            // EVERY FIELD WRITTEN EXPLICITLY, including the two that are empty
            // for this type. T-12: `{ maxLength: null }` matches a STORED null
            // and not an absent key, and leaving a stale `options` behind after
            // a type change would hand validateAnswers a vocabulary the head
            // can no longer see.
            options: q.options ?? [],
            maxLength: q.maxLength ?? null,
          };
        });

        const keptIDs = resolved.map((q) => q.questionID);
        // `notIn: []` matches everything, which is exactly right when the head
        // has cleared the whole form.
        await ctx.db.eventQuestion.deleteMany({
          where: { eventID: input.eventID, questionID: { notIn: keptIDs } },
        });

        for (const q of resolved) {
          const { questionID, ...fields } = q;
          await ctx.db.eventQuestion.upsert({
            where: {
              eventID_questionID: { eventID: input.eventID, questionID },
            },
            create: {
              eventID: input.eventID,
              questionID,
              ...fields,
              createdAt: new Date(),
            },
            update: fields,
          });
        }

        return { saved: keptIDs.length };
      });
    }),

  /**
   * One resident's answers, for the head's detail view.
   *
   * Owning head only — the access ceiling is head + JCRC, but a ceiling is not a
   * mandate and the JCRC has stated no use for an answers screen (D-48). A
   * nominated door scanner cannot reach this either: scanners scan.
   *
   * `userID` IS A PLAIN BOUNDED STRING, deliberately not canonicalUserIDSchema.
   * That schema refuses the EXT namespace, and this lookup is already fenced to
   * one event the caller owns — an unrecognised id simply finds no row, so
   * there is nothing to enumerate that getAttendees does not already hand the
   * same caller in full.
   */
  getSignupAnswers: identifiedProcedure
    .input(
      z.object({
        eventID: z.number().int().positive(),
        userID: z.string().trim().min(1).max(64),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const actorUserID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, actorUserID); // I-5 live read
      const event = await loadOwnedEvent(
        ctx.db,
        actorUserID,
        roles,
        input.eventID,
      );

      const [signup, questions] = await Promise.all([
        ctx.db.eventSignup.findUnique({
          where: {
            eventID_userID: { eventID: input.eventID, userID: input.userID },
          },
          select: { answers: true, createdAt: true },
        }),
        ctx.db.eventQuestion.findMany({
          where: { eventID: input.eventID },
          orderBy: { order: "asc" },
          select: PUBLIC_QUESTION_FIELDS,
        }),
      ]);
      if (!signup) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_SIGNUP" });
      }
      // The same unconditional read cutoff as getAttendees (D-52 layer 1).
      const answersRetained = answersAreRetained(
        event.endTime,
        event.startTime,
        Math.floor(Date.now() / 1000),
      );
      return {
        questions,
        answersRetained,
        answers: answersRetained ? signup.answers : [],
        signedUpAt: signup.createdAt,
      };
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
      // D-47 — A REVIEWER APPROVING AN EVENT IS APPROVING WHAT RESIDENTS WILL
      // BE ASKED, including whether the head has put a health question on a
      // hall form. Approving without seeing the questions would make the PDPA
      // line in the builder advisory only. Read-only: the reviewer never edits.
      const questions = await ctx.db.eventQuestion.findMany({
        where: { eventID: input.eventID },
        orderBy: { order: "asc" },
        select: PUBLIC_QUESTION_FIELDS,
      });
      return {
        event: { ...event, status: normalizeStatus(event.status) },
        ccaName: ownerName(event.ccaID, names),
        questions,
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
      // "released" = the slot was free and was booked, but the event stopped
      // being published before the booking could be attached to it, so the
      // booking was given straight back. Distinct from "conflict" (the slot was
      // never free) because it is a different fact about the room.
      let autoBook: "booked" | "conflict" | "released" | "none" = "none";
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
            // SCOPED ON `published`, and the booking is GIVEN BACK if it does
            // not apply. This write is several round trips after the status
            // write above — a facility lock, a conflict scan and a create sit
            // in between — and a cancel (the head's, or a reviewer's) lands in
            // that window. Unscoped, it stamped a live bookingID onto a row
            // that had just been CANCELED, after that cancel's cleanup had
            // already looked and found nothing: the room stayed held for an
            // event that is not happening, with the only pointer to it written
            // onto a row nobody reads bookings off. Nothing may hold a facility
            // for a non-published event, so if the match fails the Bookings row
            // we just created is deleted rather than left behind.
            const stamped = await ctx.db.event.updateMany({
              where: { eventID: input.eventID, status: "published" },
              data: { bookingID: result.bookingID, autoBookFailed: false },
            });
            if (stamped.count > 0) {
              autoBook = "booked";
            } else {
              autoBook = "released";
              await ctx.db.bookings
                .deleteMany({ where: { bookingID: result.bookingID } })
                .catch(() => undefined);
            }
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
              : autoBook === "released"
                ? `${input.reason ? input.reason + "; " : ""}facility #${event.facilityID} booked then released — event no longer published`
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
   * gets the same record with the identity-bearing fields blanked — the count is
   * deliberately NOT written out here, because it was written out, drifted, and
   * then disagreed with the list it describes; read SCRC_HIDDEN_EVENT_FIELDS
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

      // T-40 — THE QUESTIONS ARE READ **AFTER** THE STATUS GUARD ABOVE, NEVER
      // BEFORE IT. Fetching them first and then checking status would disclose
      // a draft event's whole form to any authenticated resident who guessed an
      // eventID. The guard is the boundary; everything below it is projection.
      //
      // A `canceled` event may also carry questions, and returning them is
      // harmless because signup is closed — but the client must not render a
      // form under "Signups are closed."
      const [names, signupCount, mine, questions] = await Promise.all([
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
        ctx.db.eventQuestion.findMany({
          where: { eventID: event.eventID },
          orderBy: { order: "asc" },
          select: PUBLIC_QUESTION_FIELDS,
        }),
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
        // ADDED HERE AND **NOT** TO toPublicCard. That helper is shared by
        // listPublished and listMySignups, so putting questions in it would
        // ship every event's whole form to the resident timeline on every page
        // load. getPublic is a single-event fetch and the only place the form
        // is rendered.
        questions,
      };
    }),

  /**
   * Sign up, answering the event's custom questions if it has any.
   *
   * THE ANSWERS RIDE ON THE EXISTING `eventSignup.create`. ONE DOCUMENT, ONE
   * WRITE, INSIDE THE LOCK. There is no second write and there must never be
   * one: a write placed after the P2002 catch below is SKIPPED on every retried
   * submission while the caller is told it worked, and a write placed after the
   * withEventLock callback is outside the mutex the capacity check needs.
   *
   * THE ORDER INSIDE THE LOCK IS LOAD-BEARING (D-43a). The already-signed-up
   * check is FIRST, before validation, because there are TWO idempotent paths
   * here and validating first would break both: a retry carrying no answers —
   * a stale tab, a re-fired mutation after a network blip — would get
   * ANSWERS_INVALID for an event the resident is already signed up for, which
   * today returns success. It is also wasted work, since an already-signed-up
   * caller's stored answers are deliberately left alone. First answer wins.
   */
  signup: identifiedProcedure
    .use(requireMatric)
    .input(eventSignupInput)
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
        // D-43a — ALREADY SIGNED UP? SUCCEED IMMEDIATELY, BEFORE ANY
        // VALIDATION. One indexed findUnique on event_user, on a path that
        // already does a count against the same collection inside the same
        // lock.
        //
        // This makes "first answer wins" true BY CONSTRUCTION rather than as a
        // side effect of the P2002 handler below, which is what enforces D-48's
        // ruling that there is no answer-editing path in this phase. It also
        // makes the capacity arm below simpler: its old inner findUnique and
        // early return are now unreachable, because a caller cannot get there
        // while already signed up.
        const already = await ctx.db.eventSignup.findUnique({
          where: { eventID_userID: { eventID: input.eventID, userID } },
          select: { eventID: true },
        });
        if (already) return { signedUp: true as const };

        // READ INSIDE THE LOCK, deliberately. The questions are the thing that
        // can change while somebody is filling in the form, so a head must not
        // be able to slip one in between the validation and the write. The
        // freeze (assertQuestionsEditable) makes this near-vacuous once one
        // signup exists; for the FIRST signup it is the only guard there is.
        const questions = await ctx.db.eventQuestion.findMany({
          where: { eventID: input.eventID },
          orderBy: { order: "asc" },
          select: {
            questionID: true,
            type: true,
            required: true,
            options: true,
            maxLength: true,
          },
        });
        const v = validateAnswers(questions, input.answers ?? []);
        if (!v.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "ANSWERS_INVALID",
            // Per-question detail for the server log. The client does NOT rely
            // on this reaching it: it runs the same validateAnswers itself and
            // renders errors under the right fields, and tRPC does not ship
            // `cause` to the browser.
            cause: v.errors,
          });
        }

        if (event.capacity != null) {
          const count = await ctx.db.eventSignup.count({
            where: { eventID: input.eventID },
          });
          if (count >= event.capacity) {
            throw new TRPCError({ code: "CONFLICT", message: "EVENT_FULL" });
          }
        }
        try {
          await ctx.db.eventSignup.create({
            data: {
              eventID: input.eventID,
              userID,
              createdAt: new Date(),
              // WRITTEN EXPLICITLY, even when the event has no questions and
              // this is [] — T-12, the same rule create follows for the four
              // inert Phase-2 Event fields.
              answers: v.normalized,
            },
          });
        } catch (err) {
          // Unique index is the double-submit backstop — idempotent success.
          //
          // DO NOT DELETE THIS CATCH. D-43a's early return above handles the
          // ALREADY-SIGNED-UP case; this handles the genuine race — two tabs
          // that both got past that findUnique before either wrote. They are
          // different facts and both are needed. Note the consequence, which is
          // correct but surprising: the loser's answers are DISCARDED and it is
          // still told it succeeded. First answer wins, and the copy must not
          // promise otherwise (T-23).
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

  /* ------------------------------------------------------------------ */
  /* PART C — attendance                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * The resident's side: mint MY current check-in token.
   *
   * Deliberately says nothing about any event. The token is a claim about WHO
   * you are for the next thirty seconds, not about where you are going, so one
   * code works at every door and nothing here needs an eventID. It also means
   * this cannot be used to enumerate events.
   */
  myCheckInToken: identifiedProcedure.query(async ({ ctx }) => {
    await assertEventsEnabled(ctx.db);
    await assertAttendanceEnabled(ctx.db);
    const userID = ctx.session.user.userID;
    const nowSec = Math.floor(Date.now() / 1000);
    const { token, expiresAt } = mintCheckInToken(userID, nowSec);
    return { userID, token, expiresAt };
  }),

  /**
   * THE DOOR SCAN.
   *
   * NO withEventLock, deliberately. Two scans of DIFFERENT people do not
   * contend, and two scans of the SAME person are resolved by the unique index.
   * Taking the signup lock here would put the door behind the same mutex as
   * signup, on the one path where latency is a person standing in a queue.
   */
  checkIn: identifiedProcedure
    .input(checkInInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      await assertAttendanceEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      if (normalizeStatus(event.status) !== "published") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_PUBLISHED",
        });
      }

      await assertMayScan(ctx.db, userID, roles, event);

      const nowSec = Math.floor(Date.now() / 1000);
      const attWindow = resolveAttendanceWindow(event);
      // NO DERIVABLE WINDOW IS ITS OWN STATE, and it gets its own code.
      // `resolveAttendanceWindow` returns null for an event with no startTime
      // and for an override whose close is not after its open — neither of
      // which is "not open yet" or "closed". Folding it into DOOR_NOT_OPEN told
      // the scanner "it opens an hour before the start time" for an event that
      // has no start time, while the page beside them said "check-in has
      // closed": two different untruths about one state, and neither names the
      // thing the head has to go and fix.
      if (!attWindow) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NO_DOOR_WINDOW",
        });
      }
      if (nowSec < attWindow.opensAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "DOOR_NOT_OPEN",
        });
      }
      if (nowSec > attWindow.closesAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "DOOR_CLOSED",
        });
      }

      const parsed = parseCheckInPayload(input.payload);
      // BAD_QR FOR BOTH AN UNPARSEABLE PAYLOAD AND A FAILED VERIFICATION, and
      // that sameness is the point. A distinct "expired" or "wrong person" code
      // would tell someone holding a scanner whether a given userID EXISTS,
      // turning the door into an account-enumeration oracle.
      if (!parsed) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "BAD_QR" });
      }
      if (!verifyCheckInToken(parsed.userID, parsed.token, nowSec)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "BAD_QR" });
      }

      return recordCheckIn(ctx.db, {
        eventID: input.eventID,
        subjectUserID: parsed.userID,
        scannerUserID: userID,
        method: "qr",
      });
    }),

  /**
   * THE PAPER FALLBACK. Same authorisation, same window, same write — the only
   * difference is that a human asserted the identity instead of a token.
   *
   * This is not a lesser path: a flat battery, a resident with no signal, or a
   * camera the browser will not open are all ordinary, and a door that stops
   * working in those cases is a door nobody trusts.
   */
  checkInManual: identifiedProcedure
    .input(manualCheckInInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      await assertAttendanceEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      if (normalizeStatus(event.status) !== "published") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_PUBLISHED",
        });
      }
      await assertMayScan(ctx.db, userID, roles, event);

      const nowSec = Math.floor(Date.now() / 1000);
      const attWindow = resolveAttendanceWindow(event);
      // NO DERIVABLE WINDOW IS ITS OWN STATE, and it gets its own code.
      // `resolveAttendanceWindow` returns null for an event with no startTime
      // and for an override whose close is not after its open — neither of
      // which is "not open yet" or "closed". Folding it into DOOR_NOT_OPEN told
      // the scanner "it opens an hour before the start time" for an event that
      // has no start time, while the page beside them said "check-in has
      // closed": two different untruths about one state, and neither names the
      // thing the head has to go and fix.
      if (!attWindow) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NO_DOOR_WINDOW",
        });
      }
      if (nowSec < attWindow.opensAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "DOOR_NOT_OPEN",
        });
      }
      if (nowSec > attWindow.closesAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "DOOR_CLOSED",
        });
      }

      return recordCheckIn(ctx.db, {
        eventID: input.eventID,
        subjectUserID: input.userID,
        scannerUserID: userID,
        method: "manual",
      });
    }),

  /**
   * UNDO — a hard delete, and AUDITED.
   *
   * A check-in is a claim about where a person physically was. Erasing one
   * leaves no row behind to carry that fact, which is exactly why this is the
   * attendance action that writes an audit row while the check-in itself does
   * not. The reason is mandatory for the same purpose.
   */
  undoCheckIn: identifiedProcedure
    .input(undoCheckInInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      await assertAttendanceEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      await assertMayScan(ctx.db, userID, roles, event);

      const removed = await ctx.db.eventAttendance.deleteMany({
        where: { eventID: input.eventID, userID: input.userID },
      });
      if (removed.count === 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_CHECKED_IN",
        });
      }

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        // THE ONE AUDIT ROW IN THIS FEATURE THAT IS ABOUT A SPECIFIC RESIDENT,
        // so it goes in the COLUMN and not only in the reason string.
        // `admin.listAuditLog` filters on `targetUserID`; an undo recorded only
        // inside free text is invisible to the one query that would ever look
        // for it — "what happened to this person's check-in" is exactly the
        // question this row exists to answer.
        targetUserID: input.userID,
        // `?? undefined`, never `?? null`: the column is Int? and `?? null`
        // does not compile against writeAudit's signature.
        targetCcaID: event.ccaID ?? undefined,
        targetEventID: event.eventID,
        action: "event.checkin.undo",
        reason: `undo check-in for ${input.userID}: ${input.reason}`,
      });

      const count = await ctx.db.eventAttendance.count({
        where: { eventID: input.eventID },
      });
      return { ok: true as const, count };
    }),

  /**
   * A TINY QUERY SO THE UI NEVER RENDERS A BROKEN DOOR.
   *
   * Answers "can this door work, for me, right now" without minting a token or
   * throwing. The page needs to distinguish "the feature is off", "the secret
   * is not configured", "you are not a scanner" and "the window is shut" — all
   * honest states deserving different copy, none of which should look like a
   * crash to someone standing at a door.
   */
  attendanceStatus: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const enabled = await isAttendanceEnabled(ctx.db);
      if (!enabled) {
        return {
          enabled: false as const,
          configured: isQrConfigured(),
          mayScan: false,
          published: false,
          opensAt: null,
          closesAt: null,
          open: false,
          count: 0,
        };
      }
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }

      let mayScan = true;
      try {
        await assertMayScan(ctx.db, userID, roles, event);
      } catch {
        mayScan = false;
      }

      const attWindow = resolveAttendanceWindow(event);
      const nowSec = Math.floor(Date.now() / 1000);
      const count = mayScan
        ? await ctx.db.eventAttendance.count({
            where: { eventID: input.eventID },
          })
        : 0;

      return {
        enabled: true as const,
        configured: isQrConfigured(),
        mayScan,
        published: normalizeStatus(event.status) === "published",
        opensAt: attWindow?.opensAt ?? null,
        closesAt: attWindow?.closesAt ?? null,
        open:
          attWindow != null &&
          nowSec >= attWindow.opensAt &&
          nowSec <= attWindow.closesAt,
        count,
      };
    }),

  /**
   * THE PRE-LOADED ROSTER for the manual fallback. Same `assertMayScan` gate as
   * the scan itself.
   *
   * `matricSuffix` IS THE LAST FOUR CHARACTERS, NEVER THE FULL NUMBER, and the
   * reason is the audience rather than the data. `getAttendees` hands the head a
   * full matric on the stated grounds that the head is already authorised to see
   * it. This list goes to EVERY NOMINATED SCANNER — any CCA member the head
   * picked — so shipping full matriculation numbers to all of them widens a PII
   * surface for no operational gain. A committee member ticking someone off is
   * reading a student card and needs to tell two similar names apart, which four
   * characters do.
   *
   * Nothing is taken from anyone who had it: the head still gets the full matric
   * through `getAttendees` and the audited `exportAttendees`.
   *
   * Search is CLIENT-SIDE over displayName and matricSuffix, which is what makes
   * the list usable when the network is the thing that failed.
   *
   * WALK-INS ARE NOT HERE, by definition — they did not sign up. They are
   * checked in by QR, or by a head who knows their account id.
   */
  getDoorRoster: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      await assertAttendanceEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read

      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
      });
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
      }
      await assertMayScan(ctx.db, userID, roles, event);

      const [signups, attendance] = await Promise.all([
        ctx.db.eventSignup.findMany({
          where: { eventID: input.eventID },
          select: { userID: true },
        }),
        ctx.db.eventAttendance.findMany({
          where: { eventID: input.eventID },
          select: { userID: true },
        }),
      ]);

      const checkedIn = new Set(attendance.map((a) => a.userID));
      const resolved = await resolveAttendees(
        ctx.db,
        signups.map((s) => s.userID),
      );

      return {
        rows: signups.map((s) => {
          const r = resolved.get(s.userID);
          const matric = r?.matric ?? null;
          return {
            userID: s.userID,
            displayName: r?.displayName ?? null,
            block: r?.block ?? null,
            // LAST FOUR ONLY. Rendered as ••••567X.
            matricSuffix: matric ? matric.slice(-4) : null,
            signedUp: true as const,
            checkedIn: checkedIn.has(s.userID),
          };
        }),
        checkedInCount: attendance.length,
      };
    }),

  /**
   * NOMINATE SCANNERS. Owner-only — being a scanner does not let you appoint
   * more scanners.
   *
   * VALIDATED AGAINST LIVE MEMBERSHIP AT WRITE TIME so the head gets told
   * immediately, rather than discovering at a door that a name they typed was
   * never eligible. That validation is a COURTESY, NOT THE BOUNDARY:
   * `assertMayScan` re-checks every nominee at scan time (I-5), because this
   * list is written once and nothing sweeps it when someone leaves the CCA.
   *
   * NO PICKER IS OFFERED FOR HALL EVENTS and this refuses them. A hall event has
   * no membership set to validate against, and every person who could
   * legitimately scan one already holds `manageHallEvents`, which
   * `assertMayScan`'s first branch admits outright — so a nomination list there
   * would be a control that changes nothing.
   */
  /**
   * THE HEAD'S ATTENDANCE NUMBERS — a SEPARATE query, not a widened
   * `getSignupStats`.
   *
   * `getSignupStats` is Phase 1 behaviour and must keep working with the
   * attendance flag OFF. Merging the two would make the head's signup charts
   * start failing because a Phase 3 switch is off, which is a regression
   * dressed as a feature. Two queries fail independently; one merged query
   * fails together.
   *
   * `walkIns` and `turnedUp` are counted from the STORED `wasSignedUp`, never
   * re-derived by re-checking the signup table. A resident who checks in and
   * then cancels their signup stays a `turnedUp`, because that is what
   * happened.
   */
  getAttendanceStats: identifiedProcedure
    .input(eventIdInput)
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      await assertAttendanceEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      const [signups, attendance] = await Promise.all([
        ctx.db.eventSignup.findMany({
          where: { eventID: input.eventID },
          select: { userID: true },
        }),
        ctx.db.eventAttendance.findMany({
          where: { eventID: input.eventID },
          select: { userID: true, wasSignedUp: true, method: true },
        }),
      ]);

      const attended = new Set(attendance.map((a) => a.userID));
      const noShowIDs = signups
        .map((s) => s.userID)
        .filter((id) => !attended.has(id));

      // resolveAttendees, so PII is joined LIVE like every other attendee read.
      // NOT audited — the same call, same authorisation and same data the head
      // already gets through getAttendees.
      const resolved = await resolveAttendees(ctx.db, noShowIDs);
      const window = resolveAttendanceWindow(event);

      return {
        signedUp: signups.length,
        checkedIn: attendance.length,
        // STORED, not re-derived (T-36).
        walkIns: attendance.filter((a) => a.wasSignedUp !== true).length,
        turnedUp: attendance.filter((a) => a.wasSignedUp === true).length,
        noShows: noShowIDs.map((id) => ({
          userID: id,
          displayName: resolved.get(id)?.displayName ?? null,
          block: resolved.get(id)?.block ?? null,
        })),
        doorOpens: window?.opensAt ?? null,
        doorCloses: window?.closesAt ?? null,
        byMethod: {
          qr: attendance.filter((a) => normalizeMethod(a.method) === "qr").length,
          manual: attendance.filter((a) => normalizeMethod(a.method) === "manual")
            .length,
        },
      };
    }),

  /**
   * THE JCRC'S HALL-WIDE ROLL-UP.
   *
   * A DATE RANGE, NOT A TERM. The brief asked for "every event this term" and
   * this repository has no notion of a term — there is no term, semester or
   * academic-year model anywhere in the schema. Inventing one would be a second
   * calendar to maintain, wrong the year the academic calendar shifts, and
   * needed by nothing else. A date range is honest about what it is, is always
   * correct, and can be pointed at a term by whoever knows when it started.
   *
   * THE LIVE `reviewEvents` RE-CHECK IS NOT OPTIONAL even though
   * `roleManagerProcedure` already gated the call. Same I-5 pattern `decide`
   * and `reviewerCancel` both use: the procedure builder proves the caller was
   * a manager when the session was minted, and the re-read proves they still
   * are. A hall-wide roll-up of every CCA's turnout is a disclosure surface and
   * gets the same treatment as a decision.
   *
   * DELIBERATELY NOT GATED ON THE ATTENDANCE FLAG. The event, signup and
   * calendar-density panels are all meaningful with the door layer switched
   * off; only the turnout columns are empty, and they render as "—" rather than
   * 0% precisely so that absence reads as absence.
   */
  getHallStats: roleManagerProcedure
    .input(
      z.object({
        fromSec: z.number().int().positive(),
        toSec: z.number().int().positive(),
      }),
    )
    .query(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      if (!computeCapabilities(roles).reviewEvents) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "CAPABILITY_REQUIRED:reviewEvents",
        });
      }
      if (input.toSec <= input.fromSec) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "BAD_RANGE" });
      }

      const events = await ctx.db.event.findMany({
        where: {
          startTime: { gte: input.fromSec, lte: input.toSec },
          // Drafts are nobody's business but their owner's, and a declined
          // event never existed as far as the hall is concerned.
          status: { in: ["published", "canceled"] },
        },
        select: {
          eventID: true,
          ccaID: true,
          title: true,
          startTime: true,
          status: true,
        },
        orderBy: { startTime: "asc" },
      });

      const eventIDs = events.map((e) => e.eventID);
      const [signups, attendance, names] = await Promise.all([
        eventIDs.length === 0
          ? Promise.resolve([] as { eventID: number }[])
          : ctx.db.eventSignup.findMany({
              where: { eventID: { in: eventIDs } },
              select: { eventID: true },
            }),
        eventIDs.length === 0
          ? Promise.resolve([] as { eventID: number; wasSignedUp: boolean | null }[])
          : ctx.db.eventAttendance.findMany({
              where: { eventID: { in: eventIDs } },
              select: { eventID: true, wasSignedUp: true },
            }),
        attachCcaNames(ctx.db, nameableCcaIDs(events)),
      ]);

      const signupsBy = new Map<number, number>();
      for (const s of signups) {
        signupsBy.set(s.eventID, (signupsBy.get(s.eventID) ?? 0) + 1);
      }
      const checkedBy = new Map<number, number>();
      const walkBy = new Map<number, number>();
      for (const a of attendance) {
        checkedBy.set(a.eventID, (checkedBy.get(a.eventID) ?? 0) + 1);
        if (a.wasSignedUp !== true) {
          walkBy.set(a.eventID, (walkBy.get(a.eventID) ?? 0) + 1);
        }
      }

      const rows = events.map((e) => ({
        eventID: e.eventID,
        ccaID: e.ccaID,
        // ownerName so a hall event reads "Hall" and a deleted CCA still reads
        // as an id. The CLIENT calls ownerLabel on the pair — it must never
        // guard with `{ccaName && …}`, which is how a hall event's owner line
        // silently vanishes (T-4).
        ccaName: ownerName(e.ccaID, names),
        title: e.title,
        startTime: e.startTime,
        status: normalizeStatus(e.status),
        signups: signupsBy.get(e.eventID) ?? 0,
        checkedIn: checkedBy.get(e.eventID) ?? 0,
        walkIns: walkBy.get(e.eventID) ?? 0,
      }));

      // Grouped by OWNER, with hall events collapsed under a single null key so
      // "Hall" is one row rather than one row per hall event.
      const byCcaMap = new Map<
        string,
        { ccaID: number | null; ccaName: string | null; events: number; signups: number; checkedIn: number }
      >();
      for (const r of rows) {
        const key = r.ccaID == null ? "hall" : String(r.ccaID);
        const cur =
          byCcaMap.get(key) ??
          { ccaID: r.ccaID, ccaName: r.ccaName, events: 0, signups: 0, checkedIn: 0 };
        cur.events += 1;
        cur.signups += r.signups;
        cur.checkedIn += r.checkedIn;
        byCcaMap.set(key, cur);
      }

      // Weeks keyed by the UTC Monday, so the buckets are stable regardless of
      // who is reading and from where.
      const byWeekMap = new Map<string, number>();
      for (const r of rows) {
        if (r.startTime == null) continue;
        const d = new Date(r.startTime * 1000);
        const day = (d.getUTCDay() + 6) % 7; // Monday = 0
        d.setUTCDate(d.getUTCDate() - day);
        const key = d.toISOString().slice(0, 10);
        byWeekMap.set(key, (byWeekMap.get(key) ?? 0) + 1);
      }

      return {
        events: rows,
        byCca: [...byCcaMap.values()].sort((a, b) => b.events - a.events),
        byWeek: [...byWeekMap.entries()]
          .map(([weekStart, count]) => ({ weekStart, events: count }))
          .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
      };
    }),

  saveScanners: identifiedProcedure
    .input(saveScannersInput)
    .mutation(async ({ ctx, input }) => {
      await assertEventsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

      if (event.ccaID == null) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "HALL_EVENT_HAS_NO_SCANNERS",
        });
      }

      // De-duplicate before validating: the same person named twice is a slip,
      // not an error worth refusing over.
      const wanted = [...new Set(input.scannerUserIDs)];
      const ccaID = event.ccaID;
      const checks = await Promise.all(
        wanted.map(async (candidate) => ({
          candidate,
          ok: await isLiveCcaMember(ctx.db, ccaID, candidate),
        })),
      );
      const notMembers = checks.filter((c) => !c.ok).map((c) => c.candidate);
      if (notMembers.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `NOT_MEMBERS:${notMembers.join(",")}`,
        });
      }

      await ctx.db.event.updateMany({
        where: { eventID: input.eventID },
        data: { scannerUserIDs: wanted },
      });

      return { ok: true as const, scannerUserIDs: wanted };
    }),
});

/**
 * THE ONE WRITER of an attendance row, shared by the QR and manual paths so the
 * two cannot drift about what a check-in means.
 *
 * `wasSignedUp` IS SNAPSHOTTED HERE, BEFORE THE WRITE, AND NEVER RE-DERIVED.
 * `cancelSignup` is a hard delete with no time gate, so a resident who checks
 * in and then cancels their signup would otherwise retroactively become a
 * walk-in in every count and export.
 */
async function recordCheckIn(
  db: PrismaClient,
  args: {
    eventID: number;
    subjectUserID: string;
    scannerUserID: string;
    method: "qr" | "manual";
  },
): Promise<{
  alreadyCheckedIn: boolean;
  displayName: string | null;
  wasSignedUp: boolean;
  checkedInAt: Date | null;
  count: number;
}> {
  const { eventID, subjectUserID, scannerUserID, method } = args;

  const signup = await db.eventSignup.findUnique({
    where: { eventID_userID: { eventID, userID: subjectUserID } },
    select: { eventID: true },
  });
  const wasSignedUp = signup !== null;

  let alreadyCheckedIn = false;
  let checkedInAt: Date | null = null;
  let storedWasSignedUp = wasSignedUp;

  try {
    const created = await db.eventAttendance.create({
      data: {
        eventID,
        userID: subjectUserID,
        checkedInAt: new Date(),
        checkedInBy: scannerUserID,
        method,
        // ALL SIX WRITTEN EXPLICITLY. `{ wasSignedUp: false }` matches a STORED
        // false and NOT an absent key (T-12), and the dashboards filter on it.
        wasSignedUp,
      },
    });
    checkedInAt = created.checkedInAt;
  } catch (err) {
    // THE UNIQUE INDEX IS THE DOUBLE-SCAN BACKSTOP — a second scan of the same
    // person is a SUCCESS reporting "already in", not an error, because at a
    // door the person is through either way and an error would send them to the
    // back of a queue.
    //
    // DO NOT DELETE THIS CATCH. And note it is only reachable once
    // `create-event-phase2-indexes.mjs EventAttendance --commit` has actually
    // run: a Prisma `@@unique` creates NOTHING on MongoDB, so until then a
    // double scan writes a SECOND ROW and the count is silently wrong.
    // Duck-typed, matching the existing P2002 catch in `signup` above. This
    // file imports only TYPES from @prisma/client; pulling in the runtime
    // `Prisma` namespace just to name an error class would be a new runtime
    // dependency in a module the client tree can reach.
    // The `typeof`/`!== null` guard is not padding: `(err as …).code` on a
    // thrown `null` or `undefined` throws a TypeError of its own and REPLACES
    // the original error, so the same shape the `signup` catch above uses is
    // used here verbatim rather than a shortened variant of it.
    if (
      !(
        typeof err === "object" &&
        err !== null &&
        (err as { code?: string }).code === "P2002"
      )
    ) {
      throw err;
    }
    alreadyCheckedIn = true;
    const existing = await db.eventAttendance.findUnique({
      where: { eventID_userID: { eventID, userID: subjectUserID } },
      select: { checkedInAt: true, wasSignedUp: true },
    });
    checkedInAt = existing?.checkedInAt ?? null;
    storedWasSignedUp = existing?.wasSignedUp ?? wasSignedUp;
  }

  const resolved = await resolveAttendees(db, [subjectUserID]);
  const count = await db.eventAttendance.count({ where: { eventID } });

  return {
    alreadyCheckedIn,
    displayName: resolved.get(subjectUserID)?.displayName ?? null,
    wasSignedUp: storedWasSignedUp,
    checkedInAt,
    count,
  };
}
