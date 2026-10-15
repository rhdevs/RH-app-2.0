import { z } from "zod";
import { DURATIONS } from "./duration";
import {
  isDateInAcademicYear,
  isRealIsoDate,
  isValidAcademicYear,
} from "./academicYear";

/**
 * INPUT RULES for the transcript management procedures. PURE, so every bound is
 * unit-tested without a server.
 *
 * All text is PLAIN TEXT: trimmed, length-bounded and stored raw (React escapes
 * on render; nothing here handles HTML). Control characters are rejected: in a
 * single-line field every one of them, in a multi-line field every one except
 * the newline (CRLF is normalised to LF first).
 */

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

/**
 * Invisible and direction-changing characters: zero-width space, joiners and
 * marks (U+200B-200F), bidirectional embeddings and overrides (U+202A-202E),
 * word joiner and invisible operators (U+2060-2064), bidirectional isolates
 * (U+2066-2069) and the byte order mark (U+FEFF). On a formal document they
 * reorder or hide text, so no free-text field accepts them.
 */
export const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
const NO_INVISIBLE = "INVISIBLE_CHARACTERS_NOT_ALLOWED";

/** A required single-line text field. */
export const line = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(min, min === 1 ? "REQUIRED" : `AT_LEAST_${min}_CHARACTERS`)
        .max(max, `AT_MOST_${max}_CHARACTERS`)
        .refine((s) => !CONTROL.test(s), "CONTROL_CHARACTERS_NOT_ALLOWED")
        .refine((s) => !INVISIBLE.test(s), NO_INVISIBLE),
    );

/** A required multi-line text field (newlines allowed). */
export const block = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.replace(/\r\n?/g, "\n").trim())
    .pipe(
      z
        .string()
        .min(min, min === 0 ? undefined : "REQUIRED")
        .max(max, `AT_MOST_${max}_CHARACTERS`)
        .refine(
          (s) => !CONTROL_EXCEPT_NEWLINE.test(s),
          "CONTROL_CHARACTERS_NOT_ALLOWED",
        )
        .refine((s) => !INVISIBLE.test(s), NO_INVISIBLE),
    );

/**
 * An OPTIONAL override. `undefined` = leave as it is; `null` or blank = clear it;
 * anything else = set it (validated).
 */
const clearable = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .union([z.null(), z.string().max(2000)])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : v === null || v.trim() === "" ? null : v,
    )
    .pipe(z.union([z.undefined(), z.null(), inner]));

export const academicYearInput = z
  .string()
  .max(16)
  .refine(isValidAcademicYear, "INVALID_ACADEMIC_YEAR");

export const ccaIDInput = z.number().int().positive().max(1_000_000);

/** A resident's key, as the client names them. Never trusted for "self". */
export const userIDInput = line(1, 100);

export const durationInput = z.enum(DURATIONS);

export const isoDateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "INVALID_DATE")
  .refine(isRealIsoDate, "INVALID_DATE");

/** Hours: 0.25 to 200 in steps of 0.25 (a quarter hour is exact in binary). */
export const hoursInput = z
  .number()
  .min(0.25, "HOURS_TOO_SMALL")
  .max(200, "HOURS_TOO_LARGE")
  .refine((h) => Number.isInteger(h * 4), "HOURS_MUST_BE_QUARTERS");

export const searchQueryInput = line(3, 60);

/* ---- procedure inputs ---------------------------------------------------- */

export const rosterScope = z.object({
  ccaID: ccaIDInput,
  academicYear: academicYearInput,
});

export const rosterUpsertInput = rosterScope.extend({
  userID: userIDInput,
  duration: clearable(durationInput),
  roleLabel: clearable(line(1, 60)),
  roleDuration: clearable(durationInput),
  extraContribution: clearable(block(1, 500)),
});

export const volunteerCreateInput = rosterScope
  .extend({
    userID: userIDInput,
    kind: z.enum(["regular", "oneoff"]),
    activity: line(1, 120),
    activityDate: isoDateInput.optional(),
    hours: hoursInput,
  })
  .superRefine((v, ctx) => {
    if (v.kind === "oneoff") {
      if (!v.activityDate) {
        ctx.addIssue({
          code: "custom",
          path: ["activityDate"],
          message: "DATE_REQUIRED_FOR_ONEOFF",
        });
      } else if (!isDateInAcademicYear(v.activityDate, v.academicYear)) {
        ctx.addIssue({
          code: "custom",
          path: ["activityDate"],
          message: "DATE_OUTSIDE_ACADEMIC_YEAR",
        });
      }
    } else if (v.activityDate) {
      ctx.addIssue({
        code: "custom",
        path: ["activityDate"],
        message: "DATE_ONLY_FOR_ONEOFF",
      });
    }
  });

export const awardCreateInput = z.object({
  academicYear: academicYearInput,
  userID: userIDInput,
  title: line(1, 120),
  citation: z
    .union([z.null(), z.string()])
    .optional()
    .transform((v) => (v == null || v.trim() === "" ? null : v))
    .pipe(z.union([z.null(), line(1, 300)])),
});

/** One row of a JCRC member's "Contributions during the year" table. */
const contributionRow = z.object({
  activity: line(1, 80),
  role: line(0, 60),
  description: block(0, 300),
});

const jcrcFields = {
  portfolio: line(0, 80),
  position: line(0, 80),
  description: block(0, 800),
  contributions: z
    .array(contributionRow)
    .max(10, "AT_MOST_10_CONTRIBUTIONS"),
  testimonial: block(0, 1500),
};

export const jcrcSaveMineInput = z.object({
  academicYear: academicYearInput,
  ...jcrcFields,
});

export const jcrcSaveForInput = jcrcSaveMineInput.extend({
  userID: userIDInput,
});

export const idInput = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/i, "INVALID_ID"),
});
