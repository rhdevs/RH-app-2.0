import { z } from "zod";

/**
 * Shared validation for the CCA membership-application + interview workflow.
 *
 * Deliberately NOT under `src/server/`: the resident and head forms mirror this
 * validation with a real `safeParse`, so they need the runtime VALUE, and a
 * `"use client"` component value-importing from the server tree risks pulling
 * Prisma into the browser bundle. Same reasoning, same location, as `cca.ts`
 * and `profile.ts` beside it.
 *
 * SECURITY — every input object below must NEVER gain a `userID`, `status`,
 * `decidedBy`, `decisionReason` (on a resident input), `ccaName`, `category` or
 * `roles` key. The applicant is always `ctx.session.user.userID`, the status is
 * a server-driven state machine, and the decision is a head-only field. zod
 * strips unknown keys, so the only way a resident writes something they should
 * not is if someone ADDS the key here. `ccaID`/`applicationID`/`slotID` are
 * present but are TARGETS, not payload — authorised per request (assertHeadsCca
 * for heads, ownership for residents).
 */

/* -------------------------------------------------------------------------- */
/* Status vocabulary — enforced in code (CcaApplication.status is a String)    */
/* -------------------------------------------------------------------------- */

export const APPLICATION_STATUSES = [
  "submitted",
  "interview_scheduled",
  "interviewed",
  "accepted",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * TERMINAL states end an application. Only these free the (ccaID, userID) pair
 * for a fresh application, and only `accepted` writes membership. A row in any
 * NON-terminal state is the "open application" a duplicate-apply check refuses.
 */
export const TERMINAL_STATUSES = [
  "accepted",
  "rejected",
  "withdrawn",
] as const satisfies readonly ApplicationStatus[];

export function isTerminalStatus(status: string | null | undefined): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status ?? "");
}

/* -------------------------------------------------------------------------- */
/* Field bounds                                                                */
/* -------------------------------------------------------------------------- */

export const APPLICATION_NOTES_MAX = 1500;
export const INTERVIEW_LOCATION_MAX = 200;
export const INTERVIEW_NOTE_MAX = 2000;
export const DECISION_REASON_MAX = 1000;
/** Soft cap on how many slots a head opens in one request — a sanity bound.
 *  Unchanged by group slots: seats cost no rows, so 50 × 20 is still 50 rows. */
export const MAX_SLOTS_PER_OPEN = 50;

/**
 * How many applicants may share one interview slot.
 *
 * These two live HERE rather than beside slotCapacity() in
 * services/ccaApplications.ts because the head's slot generator is a client
 * component and needs the VALUES — importing them from the server tree risks
 * pulling Prisma into the browser bundle (see the module header). The service
 * imports them back; there is still exactly one definition of each.
 *
 * DEFAULT is 1 because that is what every slot written before group slots
 * existed means, and because capacity 1 must stay byte-for-byte today's
 * behaviour. MAX is 20: big enough for a mass audition, small enough that a
 * fat-fingered "200" is refused rather than opening a slot nobody can fill.
 */
export const SLOT_CAPACITY_DEFAULT = 1;
export const SLOT_CAPACITY_MAX = 20;

/** Reused everywhere a CCA is the target. ccaID 0 is RESERVED (cascade.ts). */
const ccaID = z.number().int().positive();
const applicationID = z.number().int().positive();
const slotID = z.number().int().positive();
/** UNIX epoch SECONDS, matching Bookings.startTime/endTime. */
const epochSeconds = z.number().int().positive();
/**
 * Seats on one slot. HEAD-ONLY — see the SECURITY note at the top of this file:
 * this key must never appear on a resident input, or a resident could widen the
 * slot they are about to book.
 */
const capacity = z.number().int().min(1).max(SLOT_CAPACITY_MAX);
/**
 * A bookable facility (Facilities.facilityID). HEAD-ONLY, like `capacity`:
 * choosing one makes the server hold the room, so a resident input must never
 * carry this key.
 */
const facilityID = z.number().int().positive();

/* -------------------------------------------------------------------------- */
/* Resident inputs                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Apply to join a CCA. `notes` is the applicant's own free text — trim + max
 * ONLY, never sanitized (React escapes it on render; same reasoning as
 * CcaProfile.description). "" is allowed: notes are optional.
 */
export const applyInput = z.object({
  ccaID,
  notes: z.string().trim().max(APPLICATION_NOTES_MAX).default(""),
});
export type ApplyInput = z.input<typeof applyInput>;

/** Book an open interview slot against one's own application. */
export const bookSlotInput = z.object({ applicationID, slotID });
export type BookSlotInput = z.input<typeof bookSlotInput>;

/** Withdraw an application, or cancel one's booked slot back to `submitted`. */
export const applicationTargetInput = z.object({ applicationID });
export type ApplicationTargetInput = z.input<typeof applicationTargetInput>;

/** Browse one CCA / list its open slots. */
export const ccaTargetInput = z.object({ ccaID });
export type CcaTargetInput = z.input<typeof ccaTargetInput>;

/* -------------------------------------------------------------------------- */
/* Head inputs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One slot a head is opening. The clock check (not in the past) is server-side.
 *
 * `capacity` DEFAULTS rather than being optional: the row must be written with
 * an explicit number, never left absent, because Prisma+Mongo's `{ capacity:
 * null }` does not match an absent field (§0.4 of the design doc). The generator
 * applies one capacity to the whole batch; per-slot edits come later via
 * editSlotInput.
 */
export const slotDraftSchema = z
  .object({
    startTime: epochSeconds,
    endTime: epochSeconds,
    location: z.string().trim().max(INTERVIEW_LOCATION_MAX).optional(),
    capacity: capacity.default(SLOT_CAPACITY_DEFAULT),
  })
  .refine((s) => s.endTime > s.startTime, {
    message: "END_BEFORE_START",
    path: ["endTime"],
  });
export type SlotDraft = z.input<typeof slotDraftSchema>;

/**
 * Open a batch of slots, optionally IN a facility.
 *
 * `facilityID` is on the BATCH, not on each slot, because the room is held once
 * for the whole window (one Bookings row spanning the first slot's start to the
 * last slot's end) rather than once per 15-minute slot. Per-slot facilities
 * would mean per-slot bookings — fifty rows in the facility calendar for one
 * afternoon of interviews.
 *
 * When it is set the server denormalizes the facility NAME into every slot's
 * `location` (so the resident-facing list still reads "JCRC Room" with no
 * join), and any `location` text on the drafts is ignored.
 */
export const openSlotsInput = z.object({
  ccaID,
  slots: z.array(slotDraftSchema).min(1).max(MAX_SLOTS_PER_OPEN),
  facilityID: facilityID.optional(),
});
export type OpenSlotsInput = z.input<typeof openSlotsInput>;

/** Cancel a slot a head opened (open, or booked → reverts the application). */
export const cancelSlotInput = z.object({ ccaID, slotID });
export type CancelSlotInput = z.input<typeof cancelSlotInput>;

/**
 * Edit a slot. Moving an OCCUPIED slot's time/location is refused server-side —
 * that would change an interview out from under whoever booked it.
 *
 * `capacity` is OPTIONAL here, unlike slotDraftSchema: omitted means "leave it
 * alone", which is what a client written before group slots sends. Lowering it
 * below the seats already taken is refused (CAPACITY_BELOW_OCCUPANCY) — an edit
 * never evicts anyone.
 */
export const editSlotInput = z
  .object({
    ccaID,
    slotID,
    startTime: epochSeconds,
    endTime: epochSeconds,
    location: z.string().trim().max(INTERVIEW_LOCATION_MAX).optional(),
    capacity: capacity.optional(),
  })
  .refine((s) => s.endTime > s.startTime, {
    message: "END_BEFORE_START",
    path: ["endTime"],
  });
export type EditSlotInput = z.input<typeof editSlotInput>;

/** View / act on one application within a CCA the caller heads. */
export const headApplicationInput = z.object({ ccaID, applicationID });
export type HeadApplicationInput = z.input<typeof headApplicationInput>;

/** The head's review queue, optionally filtered by status. */
export const listApplicationsInput = z.object({
  ccaID,
  status: z.enum(APPLICATION_STATUSES).optional(),
});
export type ListApplicationsInput = z.input<typeof listApplicationsInput>;

/** Add an interview note. `body` is required (an empty note is meaningless). */
export const addNoteInput = z.object({
  ccaID,
  applicationID,
  body: z.string().trim().min(1).max(INTERVIEW_NOTE_MAX),
});
export type AddNoteInput = z.input<typeof addNoteInput>;

/**
 * Accept or reject an application. `decision` is head-only and the ONLY reason
 * this file guards its vocabulary so tightly — a resident input must never carry
 * it. `reason` is optional prose recorded on the application + audit row.
 */
export const decisionInput = z.object({
  ccaID,
  applicationID,
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().max(DECISION_REASON_MAX).optional(),
});
export type DecisionInput = z.input<typeof decisionInput>;
