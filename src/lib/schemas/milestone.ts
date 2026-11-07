import { z } from "zod";

import { EVIDENCE_UNATTACHED_TTL_MS } from "~/lib/schemas/milestoneEvidence";
import { parseAcademicYear } from "~/lib/transcript/academicYear";

/**
 * Milestone filing inputs and limits (merge proposal 4.10, PR 16).
 * Server-import-free, so the screens run the same checks as the procedures.
 */

export const MILESTONE_SCORE_MIN = 1;
export const MILESTONE_SCORE_MAX = 5;
/** A short text: enough for a few sentences, not an essay. */
export const MILESTONE_TEXT_MAX = 600;
/** Most photos one submission may hold. */
export const MILESTONE_MAX_EVIDENCE = 12;

/**
 * An unattached photo is deleted by lazy cleanup once it is older than the TTL
 * (B121). The delete removes the file and then the row, so an attach in
 * between would point at a deleted file (B127). An item within this margin of
 * the TTL is refused at attach time; the compare-and-set on the unattached
 * state does the rest.
 */
export const EVIDENCE_ATTACH_MARGIN_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_ATTACH_MAX_AGE_MS =
  EVIDENCE_UNATTACHED_TTL_MS - EVIDENCE_ATTACH_MARGIN_MS;

const HEX_ID = /^[a-f\d]{24}$/i;

export const milestoneRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("event"),
    eventID: z.number().int().positive().max(2_147_483_647),
  }),
  z.object({
    kind: z.literal("proposal"),
    proposalID: z.string().regex(HEX_ID),
  }),
]);

const score = z
  .number()
  .int()
  .min(MILESTONE_SCORE_MIN)
  .max(MILESTONE_SCORE_MAX);
const text = z.string().trim().min(1).max(MILESTONE_TEXT_MAX);

/** `null` means "nothing is filed yet": the save creates the filing. */
const expectedVersion = z.number().int().min(0).max(1_000_000).nullable();

export const milestoneGetInput = z.object({ ref: milestoneRefSchema });

export const milestoneSaveRatingInput = z.object({
  ref: milestoneRefSchema,
  expectedVersion,
  score,
  text,
});

export const milestoneAttachInput = z.object({
  ref: milestoneRefSchema,
  expectedVersion,
  evidenceIDs: z
    .array(z.string().regex(HEX_ID))
    .min(1)
    .max(MILESTONE_MAX_EVIDENCE),
});

export const milestoneDetachInput = z.object({
  ref: milestoneRefSchema,
  expectedVersion: z.number().int().min(0).max(1_000_000),
  evidenceID: z.string().regex(HEX_ID),
});

export const milestoneRateInput = z.object({
  ref: milestoneRefSchema,
  /** The `seen` token of the view the director rated from (B151). */
  seen: z.string().regex(/^[0-9a-f]{16}$/),
  score,
  text,
});

export const milestoneYearInput = z.object({
  ccaID: z.number().int().positive(),
  /** "AY2026/27"; the current academic year when absent. */
  year: z
    .string()
    .refine((v) => parseAcademicYear(v) !== null)
    .optional(),
});
