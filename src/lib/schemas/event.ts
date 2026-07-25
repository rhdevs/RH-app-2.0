import { z } from "zod";

import { CCA_BLOB_HOST } from "~/lib/schemas/cca";

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
 *   draft      — created, proposal being filled; PDF uploadable (needs eventID)
 *   submitted  — sent to JCRC, awaiting a decision
 *   approved   — JCRC said yes; head may now add public content
 *   rejected   — JCRC said no; editable and resubmittable
 *   published  — head added banner/photos/desc and published; visible to all
 *   canceled   — head withdrew a published/approved event; TERMINAL
 */
export const EVENT_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "published",
  "canceled",
] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** A head may edit the proposal fields only in these states. */
export const PROPOSAL_EDITABLE: readonly EventStatus[] = ["draft", "rejected"];
/** A head may edit the public content only in these states. */
export const PUBLIC_EDITABLE: readonly EventStatus[] = ["approved", "published"];

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

export const EVENT_UPLOAD_KINDS = ["proposal", "banner", "photo"] as const;
export type EventUploadKind = (typeof EVENT_UPLOAD_KINDS)[number];

export const EVENT_IMAGE_CONTENT_TYPES = [
  "image/webp",
  "image/png",
  "image/jpeg",
] as const;
export const EVENT_PDF_CONTENT_TYPES = ["application/pdf"] as const;

/** Images are client-downscaled to WebP; the cap stops a crafted upload. */
export const EVENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** Proposals are real PDFs, so a larger ceiling — still bounded. */
export const EVENT_PDF_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The upload constraints Vercel enforces when it mints a token, chosen by kind.
 * The route passes these straight into `onBeforeGenerateToken`.
 */
export function eventUploadConstraints(kind: EventUploadKind): {
  allowedContentTypes: string[];
  maximumSizeInBytes: number;
} {
  if (kind === "proposal") {
    return {
      allowedContentTypes: [...EVENT_PDF_CONTENT_TYPES],
      maximumSizeInBytes: EVENT_PDF_MAX_BYTES,
    };
  }
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
  const m = /^event\/(\d+)\/(proposal|banner|photo)$/.exec(pathname);
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
 * Create a draft. Only `ccaID` is required — a draft is work-in-progress and
 * everything else is filled in and validated for completeness at submit time.
 * Returning an eventID immediately is what lets the proposal PDF (whose blob
 * path needs the id) be uploaded next.
 */
export const createDraftInput = z
  .object({
    ccaID: ccaIDField,
    title: titleField.optional(),
    description: descriptionField.optional(),
    startTime: epochSecondsField.optional(),
    endTime: epochSecondsField.optional(),
    location: locationField.optional(),
    capacity: capacityField.nullable().optional(),
  })
  .superRefine(refineTimes);
export type CreateDraftInput = z.input<typeof createDraftInput>;

/**
 * Patch a draft's proposal fields (and attach the proposal PDF URL). All
 * optional — the form saves partial progress. proposalUrl is validated against
 * this event's own blob prefix; null clears it.
 */
export const updateDraftInput = z
  .object({
    eventID: eventIDField,
    title: titleField.optional(),
    description: descriptionField.optional(),
    startTime: epochSecondsField.optional(),
    endTime: epochSecondsField.nullable().optional(),
    location: locationField.optional(),
    capacity: capacityField.nullable().optional(),
    proposalUrl: z.string().url().nullable().optional(),
  })
  .superRefine((val, ctx) => {
    refineTimes(val, ctx);
    if (
      typeof val.proposalUrl === "string" &&
      !isOwnEventBlobUrl(val.proposalUrl, val.eventID, "proposal")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposalUrl"],
        message: "NOT_A_VALID_EVENT_BLOB_URL",
      });
    }
  });
export type UpdateDraftInput = z.input<typeof updateDraftInput>;

/**
 * The public content a head adds after approval. bannerUrl / photoUrls are
 * validated against this event's own blob prefix, exactly like ccaProfileInput.
 * null bannerUrl removes the banner; an empty photoUrls array clears the gallery.
 */
export const updatePublicContentInput = z
  .object({
    eventID: eventIDField,
    publicDescription: z
      .string()
      .trim()
      .max(EVENT_PUBLIC_DESCRIPTION_MAX)
      .optional(),
    bannerUrl: z.string().url().nullable().optional(),
    photoUrls: z.array(z.string().url()).max(EVENT_MAX_PHOTOS).optional(),
  })
  .superRefine((val, ctx) => {
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
export type UpdatePublicContentInput = z.input<typeof updatePublicContentInput>;

/** JCRC decision. A rejection must carry a reason; approval's reason is optional. */
export const decideInput = z
  .object({
    eventID: eventIDField,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(EVENT_DECISION_REASON_MAX).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.decision === "reject" && !val.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "A reason is required when rejecting",
      });
    }
  });
export type DecideInput = z.input<typeof decideInput>;

export const eventIdInput = z.object({ eventID: eventIDField });
export const ccaIdInput = z.object({ ccaID: ccaIDField });
