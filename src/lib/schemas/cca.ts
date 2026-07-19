import { z } from "zod";

/**
 * Shared CCA-profile validation. Deliberately NOT under `src/server/`: the
 * client mirrors this validation with a real `safeParse`, so it needs the
 * runtime VALUE, and a `"use client"` component value-importing from the server
 * tree risks pulling Prisma into the browser bundle. Same reasoning, same
 * location, as `profile.ts` beside it.
 */

export const CCA_DESCRIPTION_MAX = 1000;

/**
 * SECURITY: this schema must NEVER gain a `ccaName`, `category`, `userID` or
 * `roles` key.
 *
 * `ccaName` and `category` live on the validator-guarded `CCA` collection and
 * are renamed only by admins through `ccaAdmin.rename`; letting a CCA head
 * submit them here would hand every head the ability to rename any CCA they
 * head, bypassing that gate. `ccaID` is present but is the TARGET, not a
 * payload field — `assertHeadsCca` authorises it per request.
 *
 * zod strips unknown keys, so the only way a head writes something they
 * shouldn't is if someone ADDS the key here.
 */
export const ccaProfileInput = z.object({
  // .positive(), not .nonnegative(): ccaID 0 is RESERVED — see the guards in
  // src/server/api/services/cascade.ts.
  ccaID: z.number().int().positive(),

  /**
   * Trim and length ONLY — no sanitization, matching `bio` in profile.ts.
   *
   * React escapes this on render, which is what prevents XSS. `sanitizeName`
   * exists for `displayName` alone, because that value is rendered AS AN
   * IDENTITY on other people's bookings and is therefore an impersonation
   * vector (homoglyphs, bidi overrides). A CCA description is prose displayed
   * as prose; stripping format characters from it would corrupt legitimate
   * text for no security gain. Do not copy sanitizeName here.
   *
   * "" is allowed and means "no description" — clearing one is a normal edit,
   * not an error.
   */
  description: z
    .string()
    .trim()
    .max(
      CCA_DESCRIPTION_MAX,
      `Description must be ${CCA_DESCRIPTION_MAX} characters or fewer`,
    ),
});

export type CcaProfileInput = z.input<typeof ccaProfileInput>;
