import { z } from "zod";

import { PROPOSAL_CATEGORIES } from "~/lib/proposals/categories";
import { docLinkField, normalizePosterUrl } from "~/lib/schemas/proposalFiles";

/**
 * Shared proposal validation. Under `src/lib/` and server-import-free so the
 * form runs the same `safeParse` as the procedure (see schemas/feedback.ts).
 * These are the limits of a SAVE; whether a proposal is complete enough to
 * submit is `missingForSubmit` (lib/proposals/categories.ts).
 */

export const PROPOSAL_TITLE_MAX = 200;
export const PROPOSAL_DESCRIPTION_MAX = 5000;
export const PROPOSAL_BLAST_MAX = 2000;

/** Drop control and zero-width characters, but keep line breaks and tabs. */
const clean = (s: string) =>
  s
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""))
    .trim();

const text = (max: number) => z.string().max(max).transform(clean);

/** Epoch seconds, a whole number after 2000 and before 2200. */
/**
 * The stored columns are 32-bit integers, so the upper bound is the largest
 * one (January 2038), not a far-future date a database write would overflow on.
 */
const MAX_EPOCH_SECONDS = 2_147_483_647;
const epochSeconds = z.number().int().min(946_684_800).max(MAX_EPOCH_SECONDS);

const ccaID = z.number().int().positive();
const proposalId = z.string().regex(/^[a-f\d]{24}$/i);

const fields = {
  category: z.enum(PROPOSAL_CATEGORIES),
  title: text(PROPOSAL_TITLE_MAX).pipe(z.string().min(1)),
  description: text(PROPOSAL_DESCRIPTION_MAX),
  blastMessage: text(PROPOSAL_BLAST_MAX)
    .transform((s) => (s === "" ? null : s))
    .nullable(),
  plannedStart: epochSeconds.nullable(),
  plannedEnd: epochSeconds.nullable(),
};

const endAfterStart = (v: {
  plannedStart?: number | null | undefined;
  plannedEnd?: number | null | undefined;
}) =>
  v.plannedStart == null ||
  v.plannedEnd == null ||
  v.plannedEnd > v.plannedStart;
const END_MESSAGE = { message: "The end must be after the start" };

export const proposalCreateInput = z
  .object({
    ccaID,
    category: fields.category,
    title: fields.title,
    description: fields.description.default(""),
    blastMessage: fields.blastMessage.default(null),
    plannedStart: fields.plannedStart.default(null),
    plannedEnd: fields.plannedEnd.default(null),
    // A poster needs the proposal's id, so it can only be added by an update.
    docLink: docLinkField.default(null),
  })
  .refine(endAfterStart, END_MESSAGE);

/**
 * `version` is the value the editor loaded. The save applies only if it is
 * still current, so two tabs cannot silently overwrite each other.
 */
export const proposalUpdateInput = z
  .object({
    id: proposalId,
    version: z.number().int().min(0),
    category: fields.category.optional(),
    title: fields.title.optional(),
    description: fields.description.optional(),
    blastMessage: fields.blastMessage.optional(),
    plannedStart: fields.plannedStart.optional(),
    plannedEnd: fields.plannedEnd.optional(),
    /** An address from the poster upload, or null to remove the poster. */
    posterUrl: z.string().max(2048).nullable().optional(),
    /** An https document link, or null / blank to clear it. */
    docLink: docLinkField.optional(),
  })
  .refine(endAfterStart, END_MESSAGE)
  .superRefine((v, ctx) => {
    if (
      typeof v.posterUrl === "string" &&
      normalizePosterUrl(v.posterUrl, v.id) === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["posterUrl"],
        message: "That poster does not belong to this proposal",
      });
    }
  })
  // Store the canonical spelling, so the replace check compares like with like.
  .transform((v) => ({
    ...v,
    posterUrl:
      typeof v.posterUrl === "string"
        ? (normalizePosterUrl(v.posterUrl, v.id) ?? v.posterUrl)
        : v.posterUrl,
  }));

/** Submit names the version it validated; see Proposal.version. */
export const proposalSubmitInput = z.object({
  id: proposalId,
  version: z.number().int().min(0),
});

/**
 * The director's three moves each name the version the director read, so an
 * approval cannot land on content that was returned, edited and resubmitted
 * since (the head's tab and the director's are different tabs).
 */
export const PROPOSAL_NOTE_MAX = 500;
const versionField = z.number().int().min(0);

/** The optional note on an approval (Q32). Blank means none. */
export const proposalApproveInput = z.object({
  id: proposalId,
  version: versionField,
  note: text(PROPOSAL_NOTE_MAX)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional(),
});

/** A return needs a short reason, kept in the history for the head. */
export const proposalReturnInput = z.object({
  id: proposalId,
  version: versionField,
  reason: text(PROPOSAL_NOTE_MAX).pipe(z.string().min(1)),
});

export const proposalFinishInput = z.object({
  id: proposalId,
  version: versionField,
});

/**
 * One page of the review queue. `cursor` is the opaque value the previous
 * page returned: the submission time (epoch milliseconds, or "none") and id of
 * the LAST row that page showed, joined by "_". The next page is every row
 * after that position, so it holds even if that row has left review.
 */
export const QUEUE_CURSOR = /^(\d{1,16}|none)_([a-f\d]{24})$/i;
export const proposalQueueInput = z.object({
  cursor: z.string().regex(QUEUE_CURSOR).optional(),
});

export const proposalIdInput = z.object({ id: proposalId });
export const proposalListInput = z.object({ ccaID });

export type ProposalCreateInput = z.infer<typeof proposalCreateInput>;
export type ProposalUpdateInput = z.infer<typeof proposalUpdateInput>;
