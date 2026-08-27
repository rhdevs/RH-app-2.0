import { z } from "zod";

import { CCA_BLOB_HOST } from "~/lib/schemas/cca";
import {
  answerValueSchema,
  EVENT_MAX_QUESTIONS,
} from "~/lib/schemas/eventQuestion";

/**
 * Shared Events validation. Deliberately NOT under `src/server/`: the client
 * mirrors this validation with a real `safeParse`, so it needs the runtime
 * VALUE, and a `"use client"` component value-importing from the server tree
 * risks pulling Prisma into the browser bundle. Same reasoning, same location,
 * as `cca.ts` and `profile.ts` beside it.
 */

/* -------------------------------------------------------------------------- */
/* Status vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle. Enforced HERE, in code — `Event.status` is a nullable String
 * with a default in the schema (I-2), never a DB enum. The DB cannot police it,
 * so every transition is checked in the router.
 *
 *   draft              — a TECHNICAL STAGING STATE. A row must exist before its
 *                        banner can be uploaded (the blob path is
 *                        event/{eventID}/banner), so `create` writes one and
 *                        routes straight to the editor. No head is ever parked
 *                        here: the head surface labels it "Not submitted".
 *   submitted          — with the JCRC, awaiting a decision. LOCKED: no field
 *                        save is accepted. The way out is `withdraw`.
 *   published          — approved AND live on the residents' timeline, in one
 *                        write. Banner / photos / public description stay
 *                        editable; the date, location and capacity do not.
 *   changes_requested  — the JCRC wants edits; editable and resubmittable.
 *   declined           — the JCRC said no. TERMINAL, not resubmittable.
 *   canceled           — the event is not happening. TERMINAL.
 *
 * There is NO `approved`. Approval publishes, so an event is never in the state
 * "allowed to happen but invisible, waiting on a second button".
 */
export const EVENT_STATUSES = [
  "draft",
  "submitted",
  "published",
  "changes_requested",
  "declined",
  "canceled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** What a head may edit in a given status. */
export type EventEditScope = "all" | "public" | "none";

/**
 * The ONE rule about what is writable, replacing the old PROPOSAL_EDITABLE /
 * PUBLIC_EDITABLE array pair.
 *
 * A FUNCTION, NOT TWO ARRAYS, for two reasons. (1) The `switch` below is
 * exhaustive over EventStatus with NO `default`, so adding a status later is a
 * compile error here rather than a silently-empty array somewhere. (2) It is one
 * exported value the CLIENT can import, which kills a live drift pair: the head
 * UI used to re-derive this branching by hand (`draft || rejected`, `approved`,
 * `published`) while the server enforced the arrays, and nothing made the two
 * agree.
 *
 * `submitted` IS "none", AND THAT IS THE WHOLE POINT. An event in the review
 * queue is frozen: the reviewer must never approve words that changed under
 * them five seconds earlier. A head who needs to fix a typo calls
 * `event.withdraw` first, which pulls it out of the queue visibly. Writing
 * "all" here compiles, passes every type check, and silently reinstates the
 * moving-target bug this rule exists to remove.
 */
export function editScope(status: EventStatus): EventEditScope {
  switch (status) {
    case "draft":
    case "changes_requested":
      return "all";
    case "published":
      return "public";
    case "submitted":
    case "declined":
    case "canceled":
      return "none";
  }
}

export function normalizeStatus(raw: string | null | undefined): EventStatus {
  return (EVENT_STATUSES as readonly string[]).includes(raw ?? "")
    ? (raw as EventStatus)
    : "draft";
}

/* -------------------------------------------------------------------------- */
/* Field limits                                                                */
/* -------------------------------------------------------------------------- */

export const EVENT_TITLE_MAX = 120;
export const EVENT_DESCRIPTION_MAX = 4000;
export const EVENT_LOCATION_MAX = 200;
export const EVENT_PUBLIC_DESCRIPTION_MAX = 4000;
export const EVENT_DECISION_REASON_MAX = 500;
/** How many gallery photos one event may carry. A soft product cap. */
export const EVENT_MAX_PHOTOS = 8;
/** Sanity ceiling on capacity — larger than any real hall event. */
export const EVENT_CAPACITY_MAX = 100_000;

/* Reusable field schemas. Trim + length only; React escapes on render (same
 * reasoning as `bio`/CCA `description` — see cca.ts). */
const titleField = z.string().trim().min(1, "Title is required").max(EVENT_TITLE_MAX);
const descriptionField = z.string().trim().min(1, "Description is required").max(EVENT_DESCRIPTION_MAX);
const locationField = z.string().trim().min(1, "Location is required").max(EVENT_LOCATION_MAX);
/** UNIX epoch SECONDS, UTC — the Bookings convention. */
const epochSecondsField = z.number().int().positive();
const capacityField = z.number().int().positive().max(EVENT_CAPACITY_MAX);

/* -------------------------------------------------------------------------- */
/* Blob uploads (reuse the CCA store, new path prefix)                         */
/* -------------------------------------------------------------------------- */

/**
 * Events reuse the SAME public Vercel Blob store as CCA images (its host is
 * already whitelisted in next.config.js's remotePatterns), under a distinct
 * `event/` path prefix. Re-exported so the upload route and client field import
 * one host constant.
 */
export const EVENT_BLOB_HOST = CCA_BLOB_HOST;

export const EVENT_UPLOAD_KINDS = ["banner", "photo"] as const;
export type EventUploadKind = (typeof EVENT_UPLOAD_KINDS)[number];

export const EVENT_IMAGE_CONTENT_TYPES = [
  "image/webp",
  "image/png",
  "image/jpeg",
] as const;

/** Images are client-downscaled to WebP; the cap stops a crafted upload. */
export const EVENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The upload constraints Vercel enforces when it mints a token, chosen by kind.
 * The route passes these straight into `onBeforeGenerateToken`.
 *
 * Both remaining kinds are images, so this is currently a single return. The
 * FUNCTION is kept rather than inlined: the route calls it by name, and the next
 * kind that is not an image needs the branch back.
 */
export function eventUploadConstraints(_kind: EventUploadKind): {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
} {
  return {
    allowedContentTypes: [...EVENT_IMAGE_CONTENT_TYPES],
    maximumSizeInBytes: EVENT_IMAGE_MAX_BYTES,
  };
}

/**
 * Upload pathname for an event asset. Vercel appends a random suffix, so the
 * stored blob is e.g. `event/12/photo-Xy7Qa1.webp` — unguessable and immutable.
 * Built here so the client (requests the token) and the route (authorises it)
 * cannot disagree about the shape.
 */
export function eventUploadPath(eventID: number, kind: EventUploadKind): string {
  return `event/${eventID}/${kind}`;
}

/**
 * Inverse of eventUploadPath, used by the upload route to learn WHICH event a
 * token is for. Client-supplied, so this parse is NOT the security boundary —
 * the caller must load the event and pass its ccaID to assertHeadsCca. It only
 * guarantees a well-formed, event-scoped path so a token can never be minted
 * for an arbitrary location in the store.
 */
export function parseEventUploadPath(
  pathname: string,
): { eventID: number; kind: EventUploadKind } | null {
  const m = /^event\/(\d+)\/(banner|photo)$/.exec(pathname);
  if (!m) return null;
  const eventID = Number(m[1]);
  if (!Number.isSafeInteger(eventID) || eventID <= 0) return null;
  return { eventID, kind: m[2] as EventUploadKind };
}

/**
 * Is this URL one of OUR blobs, for THIS event, of THIS kind? THE load-bearing
 * check — URLs reach the server from the client (browser uploads to Blob, then
 * calls a mutation with whatever URL it got back). Mirrors isOwnCcaBlobUrl:
 *   - protocol https (blocks javascript:/data:)
 *   - host EXACTLY the store's (not a suffix match)
 *   - path under this event's own prefix
 */
export function isOwnEventBlobUrl(
  url: string,
  eventID: number,
  kind: EventUploadKind,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.host !== EVENT_BLOB_HOST) return false;
  return parsed.pathname.startsWith(`/${eventUploadPath(eventID, kind)}`);
}

/* -------------------------------------------------------------------------- */
/* Mutation payloads                                                           */
/* -------------------------------------------------------------------------- */

const eventIDField = z.number().int().positive();
const ccaIDField = z.number().int().positive();

/** Cross-field time check reused by draft edits: end must be after start. */
function refineTimes(
  val: { startTime?: number | null; endTime?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (
    typeof val.startTime === "number" &&
    typeof val.endTime === "number" &&
    val.endTime <= val.startTime
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endTime"],
      message: "End time must be after the start time",
    });
  }
}

/**
 * Create an event. EVERY field is optional, including `ccaID` — the form saves
 * whatever the head has typed so far and completeness is a SUBMIT-time check
 * (see submitForReview). A row has to exist before a banner can be uploaded at
 * all, because the blob path is event/{eventID}/banner.
 *
 * `ccaID` ABSENT OR NULL MEANS HALL-WIDE, owned by the JCRC. The server branches
 * on it: null requires the `manageHallEvents` capability, a number goes to
 * assertHeadsCca. Note that `ccaIDField` is `.positive()`, so 0 is not even
 * expressible here — the Bookings "no CCA" sentinel and the Event "no CCA" null
 * cannot be confused by a client.
 */
export const createEventInput = z
  .object({
    ccaID: ccaIDField.nullable().optional(),
    title: titleField.optional(),
    description: descriptionField.optional(),
    startTime: epochSecondsField.optional(),
    endTime: epochSecondsField.optional(),
    // Location is EITHER a facility (facilityID set -> server denormalizes the
    // name into `location`) OR free text (`location`, facilityID null). null
    // facilityID clears a previous facility choice.
    location: locationField.optional(),
    facilityID: z.number().int().positive().nullable().optional(),
    capacity: capacityField.nullable().optional(),
  })
  .superRefine(refineTimes);
export type CreateEventInput = z.input<typeof createEventInput>;

/**
 * Patch an event. ONE schema for every field, replacing the old
 * updateDraftInput / updatePublicContentInput pair. All optional — the form
 * saves partial progress.
 *
 * THE SCHEMA DELIBERATELY DOES NOT ENCODE THE PER-STATUS FIELD SUBSET. Zod runs
 * on the client too, and the client does not know the STORED status at parse
 * time (it knows what it last fetched, which may be stale). Permissive schema +
 * strict server means the server is the only authority: `update` reads the row,
 * asks `editScope`, and writes only the fields that scope permits — silently
 * ignoring the rest rather than erroring, so a head does not lose a banner edit
 * to a status race.
 *
 * The isOwnEventBlobUrl superRefines below are THE security boundary for
 * client-supplied URLs. Do not loosen them, and do not "generalise" them to
 * accept any event/* path — that would let a head attach another CCA's private
 * image to their own event by URL.
 */
export const updateEventInput = z
  .object({
    eventID: eventIDField,
    title: titleField.optional(),
    description: descriptionField.optional(),
    startTime: epochSecondsField.optional(),
    endTime: epochSecondsField.nullable().optional(),
    location: locationField.optional(),
    facilityID: z.number().int().positive().nullable().optional(),
    capacity: capacityField.nullable().optional(),
    publicDescription: z
      .string()
      .trim()
      .max(EVENT_PUBLIC_DESCRIPTION_MAX)
      .optional(),
    bannerUrl: z.string().url().nullable().optional(),
    photoUrls: z.array(z.string().url()).max(EVENT_MAX_PHOTOS).optional(),
    // THE DOOR TIMING. Nullable AND optional, and the two are different:
    // `undefined` means "leave it alone", `null` means "clear it".
    //   both null       -> back to the derived default (start-1h .. end+1h)
    //   opensAt set,
    //   closesAt null   -> OPEN-ENDED: open until the head closes it
    //   both set        -> an explicit window
    // See resolveAttendanceWindow in lib/schemas/eventAttendance.ts, which is
    // the single reader of that three-state encoding.
    attendanceOpensAt: epochSecondsField.nullable().optional(),
    attendanceClosesAt: epochSecondsField.nullable().optional(),
  })
  .superRefine((val, ctx) => {
    refineTimes(val, ctx);
    if (
      typeof val.bannerUrl === "string" &&
      !isOwnEventBlobUrl(val.bannerUrl, val.eventID, "banner")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bannerUrl"],
        message: "NOT_A_VALID_EVENT_BLOB_URL",
      });
    }
    if (val.photoUrls) {
      val.photoUrls.forEach((u, i) => {
        if (!isOwnEventBlobUrl(u, val.eventID, "photo")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["photoUrls", i],
            message: "NOT_A_VALID_EVENT_BLOB_URL",
          });
        }
      });
    }
  });
export type UpdateEventInput = z.input<typeof updateEventInput>;

/**
 * The JCRC decision. THREE outcomes, not two: `request_changes` reopens the
 * event for editing and is resubmittable, `decline` is terminal. "Rejected" used
 * to mean both, which left a genuine no sitting in a permanently re-submittable
 * state. Both non-approve outcomes require a reason — it is the only feedback
 * channel the head has, because a reviewer never edits an event.
 */
export const decideInput = z
  .object({
    eventID: eventIDField,
    decision: z.enum(["approve", "request_changes", "decline"]),
    reason: z.string().trim().max(EVENT_DECISION_REASON_MAX).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.decision !== "approve" && !val.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A reason is required to request changes or decline",
      });
    }
  });
export type DecideInput = z.input<typeof decideInput>;

/**
 * The reviewer cancelling a PUBLISHED event. A reason is mandatory here and
 * optional nowhere: the owning head is not asked first, so the record must say
 * why. `event.withdraw` needs no schema of its own — it reuses eventIdInput.
 */
export const reviewerCancelInput = z.object({
  eventID: eventIDField,
  reason: z.string().trim().min(1).max(EVENT_DECISION_REASON_MAX),
});
export type ReviewerCancelInput = z.input<typeof reviewerCancelInput>;

/* -------------------------------------------------------------------------- */
/* Owner display                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The label a hall-wide event's owner line renders. Exactly "Hall" — not
 * "Hall-wide", not "Raffles Hall", not "JCRC". Defined once, here, so the six
 * display sites cannot drift.
 */
export const HALL_OWNER_LABEL = "Hall";

/**
 * The owner label for an event. THE ONLY WAY to render an event's owner.
 *
 * IT KEYS ON ccaID, NEVER ON ccaName, and that is the whole reason it takes both
 * arguments. "Hall-wide" and "the CCA was deleted" are different facts that both
 * produce a null ccaName: deleteCcaCascade does not remove a CCA's events, so an
 * orphaned event already resolves ccaName null today. If a null NAME meant
 * "Hall", an orphan would be silently relabelled as a JCRC event. A null ID
 * means Hall; a present id with no name falls through to `CCA #{id}`.
 *
 * Use it UNCONDITIONALLY — never `{ccaName && <span>{ccaName}</span>}`. That
 * guard renders NOTHING for a hall event: no error, no warning, no tsc
 * complaint, just an owner line missing from the DOM. `ownerLabel` always
 * returns a non-empty string, so the guard is retired rather than relocated.
 */
export function ownerLabel(
  ccaID: number | null,
  ccaName: string | null,
): string {
  if (ccaID == null) return HALL_OWNER_LABEL;
  return ccaName ?? `CCA #${ccaID}`;
}

export const eventIdInput = z.object({ eventID: eventIDField });

/**
 * Sign up, optionally answering the event's custom questions.
 *
 * `answers` IS OPTIONAL AND THE SHAPE IS PERMISSIVE. Two separate reasons, and
 * both matter:
 *
 *   - The client does not know the authoritative question list — it knows what
 *     it last fetched, which a co-head may have changed since. Only the server,
 *     holding the stored rows, can judge whether an answer is CORRECT, so this
 *     schema judges only whether it is well-FORMED. Same posture, same
 *     argument, as updateEventInput's docblock above.
 *   - A retry that carries no answers at all — a stale tab, a re-fired mutation
 *     after a network blip, any client that resends `{ eventID }` alone — must
 *     still succeed for a resident who is ALREADY signed up. Making `answers`
 *     required would turn that into a validation error about a form they have
 *     already submitted. See D-43a.
 *
 * Content is checked by `validateAnswers` in schemas/eventQuestion.ts, against
 * the STORED questions, inside withEventLock.
 */
export const eventSignupInput = z.object({
  eventID: eventIDField,
  answers: z.array(answerValueSchema).max(EVENT_MAX_QUESTIONS).optional(),
});
export type EventSignupInput = z.input<typeof eventSignupInput>;
/**
 * The owner list key. `ccaID: null` selects the HALL-WIDE events. Nullable
 * rather than a separate procedure because listForOwner's `where` clause is
 * literally `{ ccaID: input.ccaID }` and Prisma renders null as a null match —
 * which is exactly why every writer must set the field EXPLICITLY (a document
 * with no ccaID key at all matches nothing).
 */
export const ccaIdInput = z.object({ ccaID: ccaIDField.nullable() });
