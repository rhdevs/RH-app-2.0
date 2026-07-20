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
/** Soft cap on how many slots a head opens in one request — a sanity bound. */
export const MAX_SLOTS_PER_OPEN = 50;

/** Reused everywhere a CCA is the target. ccaID 0 is RESERVED (cascade.ts). */
const ccaID = z.number().int().positive();
const applicationID = z.number().int().positive();
const slotID = z.number().int().positive();
/** UNIX epoch SECONDS, matching Bookings.startTime/endTime. */
const epochSeconds = z.number().int().positive();

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

/** One slot a head is opening. The clock check (not in the past) is server-side. */
export const slotDraftSchema = z
  .object({
    startTime: epochSeconds,
    endTime: epochSeconds,
    location: z.string().trim().max(INTERVIEW_LOCATION_MAX).optional(),
  })
  .refine((s) => s.endTime > s.startTime, {
    message: "END_BEFORE_START",
    path: ["endTime"],
  });
export type SlotDraft = z.input<typeof slotDraftSchema>;

export const openSlotsInput = z.object({
  ccaID,
  slots: z.array(slotDraftSchema).min(1).max(MAX_SLOTS_PER_OPEN),
});
export type OpenSlotsInput = z.input<typeof openSlotsInput>;

/** Cancel a slot a head opened (open, or booked → reverts the application). */
export const cancelSlotInput = z.object({ ccaID, slotID });
export type CancelSlotInput = z.input<typeof cancelSlotInput>;

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
