import { z } from "zod";
import {
  PARTICIPANT_DESCRIPTION_MAX,
  PARTICIPANT_ROLE_MAX,
} from "./activities";
import {
  academicYearInput,
  block,
  ccaIDInput,
  clearable,
  durationInput,
  idInput,
  line,
  userIDInput,
} from "./manageInput";

/**
 * INPUT RULES for the per-resident corrections screens (admin and jcrc only).
 * Every procedure names ONE resident and ONE academic year.
 */

export const residentScope = z.object({
  userID: userIDInput,
  academicYear: academicYearInput,
});

/** Why an unlock or a hold happens: required, so the history always says. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const reasonInput = line(REASON_MIN, REASON_MAX);

/** An optional note on a relock or release. */
export const noteInput = block(0, REASON_MAX).optional();

export const unlockInput = residentScope.extend({ reason: reasonInput });
export const relockInput = residentScope.extend({ note: noteInput });
export const withholdInput = residentScope.extend({ reason: reasonInput });
export const releaseInput = residentScope.extend({ note: noteInput });

/** A manual CCA entry: create or edit (one per resident, CCA and year). */
export const manualSaveInput = residentScope.extend({
  ccaID: ccaIDInput,
  duration: clearable(durationInput),
  roleLabel: clearable(line(1, 60)),
  roleDuration: clearable(durationInput),
  extraContribution: clearable(block(1, 500)),
});

export const manualRefInput = residentScope.extend({ ccaID: ccaIDInput });

export const manualListInput = residentScope.extend({
  includeRemoved: z.boolean().optional(),
});

/** Add, edit or remove the resident on ONE CCA activity (of any CCA). */
export const participationSetInput = residentScope.extend({
  activityID: idInput.shape.id,
  role: line(0, PARTICIPANT_ROLE_MAX),
  description: block(0, PARTICIPANT_DESCRIPTION_MAX),
});

export const participationRemoveInput = residentScope.extend({
  activityID: idInput.shape.id,
});

/** Every live activity of the year, for "add to an existing activity". */
export const activityOptionsInput = z.object({
  academicYear: academicYearInput,
});

export const awardsOfInput = residentScope.extend({
  includeRemoved: z.boolean().optional(),
});

export const jcrcRefInput = residentScope;

/** The history of one resident's year. */
export const historyInput = residentScope;
