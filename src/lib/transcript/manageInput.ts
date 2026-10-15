import { z } from "zod";
import {
  ACTIVITY_DESCRIPTION_MAX,
  ACTIVITY_PERIODS,
  ACTIVITY_TITLE_MAX,
  MAX_PARTICIPANTS,
  PARTICIPANT_DESCRIPTION_MAX,
  PARTICIPANT_ROLE_MAX,
} from "./activities";
import {
  AWARD_CITATION_MAX,
  AWARD_NAME_MAX,
  MAX_ASSIGN,
  MAX_BULK,
} from "./awards";
import { DURATIONS } from "./duration";
import {
  MAX_VOLUNTEER_PEOPLE,
  VOLUNTEER_DESCRIPTION_MAX,
  VOLUNTEER_HOURS_MAX,
  VOLUNTEER_HOURS_MIN,
  VOLUNTEER_KINDS,
  VOLUNTEER_TITLE_MAX,
} from "./volunteer";
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
  contributions: z.array(contributionRow).max(10, "AT_MOST_10_CONTRIBUTIONS"),
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

/* ---- CCA activities ------------------------------------------------------ */

const activityFields = {
  title: line(1, ACTIVITY_TITLE_MAX),
  description: block(0, ACTIVITY_DESCRIPTION_MAX),
  period: z.enum(ACTIVITY_PERIODS),
};

export const activityCreateInput = rosterScope.extend(activityFields);

/** The year is the activity's own; the CCA is checked against it. */
export const activityUpdateInput = idInput.extend({
  ccaID: ccaIDInput,
  ...activityFields,
});

export const activityRefInput = idInput.extend({ ccaID: ccaIDInput });

export const activityListInput = rosterScope.extend({
  includeRemoved: z.boolean().optional(),
});

const participantRow = z.object({
  userID: userIDInput,
  role: line(0, PARTICIPANT_ROLE_MAX),
  description: block(0, PARTICIPANT_DESCRIPTION_MAX),
});

export const participantsSetInput = activityRefInput.extend({
  participants: z
    .array(participantRow)
    .max(MAX_PARTICIPANTS, `AT_MOST_${MAX_PARTICIPANTS}_PARTICIPANTS`),
});

/* ---- volunteer activities ------------------------------------------------ */

const volunteerHours = z
  .number()
  .min(VOLUNTEER_HOURS_MIN, "HOURS_TOO_SMALL")
  .max(VOLUNTEER_HOURS_MAX, "HOURS_TOO_LARGE")
  .refine((h) => Number.isInteger(h * 4), "HOURS_MUST_BE_QUARTERS");

const volunteerFields = {
  title: line(1, VOLUNTEER_TITLE_MAX),
  description: block(0, VOLUNTEER_DESCRIPTION_MAX),
  defaultHours: volunteerHours.nullable().optional(),
};

export const volunteerActivityCreateInput = rosterScope
  .extend({
    ...volunteerFields,
    kind: z.enum(VOLUNTEER_KINDS),
    /** One-off only: its single session. */
    date: isoDateInput.optional(),
    hours: volunteerHours.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "oneoff") {
      if (!v.date) {
        ctx.addIssue({
          code: "custom",
          path: ["date"],
          message: "DATE_REQUIRED_FOR_ONEOFF",
        });
      } else if (!isDateInAcademicYear(v.date, v.academicYear)) {
        ctx.addIssue({
          code: "custom",
          path: ["date"],
          message: "DATE_OUTSIDE_ACADEMIC_YEAR",
        });
      }
      if (v.hours === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["hours"],
          message: "HOURS_REQUIRED_FOR_ONEOFF",
        });
      }
    } else if (v.date !== undefined || v.hours !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["date"],
        message: "DATE_ONLY_FOR_ONEOFF",
      });
    }
  });

/** The year is the activity's own. Date and hours apply to a one-off's session. */
export const volunteerActivityUpdateInput = idInput.extend({
  ccaID: ccaIDInput,
  ...volunteerFields,
  date: isoDateInput.optional(),
  hours: volunteerHours.optional(),
});

export const volunteerActivityRefInput = idInput.extend({ ccaID: ccaIDInput });

export const volunteerSessionAddInput = z.object({
  activityID: idInput.shape.id,
  ccaID: ccaIDInput,
  date: isoDateInput.optional(),
  hours: volunteerHours.optional(),
});

export const volunteerSessionUpdateInput = z.object({
  sessionID: idInput.shape.id,
  ccaID: ccaIDInput,
  date: isoDateInput.optional(),
  hours: volunteerHours.optional(),
});

export const volunteerSessionRefInput = z.object({
  sessionID: idInput.shape.id,
  ccaID: ccaIDInput,
});

export const volunteerPeopleSetInput = z.object({
  activityID: idInput.shape.id,
  ccaID: ccaIDInput,
  userIDs: z
    .array(userIDInput)
    .max(MAX_VOLUNTEER_PEOPLE, `AT_MOST_${MAX_VOLUNTEER_PEOPLE}_PEOPLE`),
});

/** Cells changed in one save; one tick or un-tick each. */
export const MAX_ATTENDANCE_CHANGES = 20_000;

export const volunteerAttendanceSaveInput = z.object({
  activityID: idInput.shape.id,
  ccaID: ccaIDInput,
  changes: z
    .array(
      z.object({
        sessionID: idInput.shape.id,
        userID: userIDInput,
        attended: z.boolean(),
        hoursOverride: volunteerHours.nullable().optional(),
      }),
    )
    .max(MAX_ATTENDANCE_CHANGES, "TOO_MANY_CHANGES"),
});

/* ---- awards -------------------------------------------------------------- */

/** A blank citation is null; anything else is a plain single line. */
const awardCitation = z
  .union([z.null(), z.string()])
  .optional()
  .transform((v) => (v == null || v.trim() === "" ? null : v))
  .pipe(z.union([z.null(), line(1, AWARD_CITATION_MAX)]));

const awardIdInput = idInput.shape.id;

export const awardTypeCreateInput = z.object({
  name: line(1, AWARD_NAME_MAX),
  defaultCitation: awardCitation,
});

export const awardTypeUpdateInput = awardTypeCreateInput.extend({
  id: awardIdInput,
});

export const awardTypesListInput = z.object({
  includeArchived: z.boolean().optional(),
});

export const awardsListInput = z.object({
  academicYear: academicYearInput,
  search: z.string().max(60).optional(),
  includeRemoved: z.boolean().optional(),
});

export const awardsAssignInput = z.object({
  academicYear: academicYearInput,
  awardTypeID: awardIdInput,
  recipients: z
    .array(z.object({ userID: userIDInput, citation: awardCitation }))
    .min(1, "REQUIRED")
    .max(MAX_ASSIGN, `AT_MOST_${MAX_ASSIGN}_RECIPIENTS`),
});

export const awardUpdateInput = z.object({
  id: awardIdInput,
  title: line(1, AWARD_NAME_MAX),
  citation: awardCitation,
});

export const awardsBulkInput = z.object({
  ids: z
    .array(awardIdInput)
    .min(1, "REQUIRED")
    .max(MAX_BULK, `AT_MOST_${MAX_BULK}_AWARDS`),
});

export const awardBatchesListInput = z.object({
  academicYear: academicYearInput,
});

export const awardBatchUndoInput = z.object({ batchId: awardIdInput });
