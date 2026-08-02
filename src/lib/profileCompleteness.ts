/**
 * Shared profile-completeness rules — the ONE definition of "this user's
 * details are filled in and not misused". Used by BOTH the session callback
 * (server, to raise the gate flag) and the forced completion dialog (client, to
 * mirror it), so the two can never disagree about who is gated.
 *
 * No server imports, so it is safe to value-import into a `"use client"`
 * component (same rule as src/lib/schemas/profile.ts).
 *
 * The mandatory set is a product decision: a real display name, a Telegram
 * handle, a block, and a matriculation number. Bio stays optional.
 */

export type ProfileField = "displayName" | "telegramHandle" | "block" | "matric";

/** The fields a user must have before they may use the app. */
export const REQUIRED_PROFILE_FIELDS: ProfileField[] = [
  "displayName",
  "telegramHandle",
  "block",
  "matric",
];

/** Human copy for each field, used in the completion dialog's checklist. */
export const PROFILE_FIELD_LABEL: Record<ProfileField, string> = {
  displayName: "a proper display name (not your NUSNET ID)",
  telegramHandle: "your Telegram handle",
  block: "your block",
  matric: "your matriculation number",
};

/**
 * The ONE shape a display name may not take: an E-format NUSNET id.
 *
 * Narrow ON PURPOSE. The first version of this rule gated on the user's own
 * identifiers rather than on the SHAPE of what they typed — it refused any name
 * that contained their userID. That is right for an opaque id and UNSATISFIABLE
 * for a name-derived one: "KE BANGYAN" over userID "BANGYAN" was refused every
 * time it was typed, so that resident could not get through the gate at all, and
 * 52 accounts here have digit-free, name-derived userIDs of the same shape. The
 * rule is now purely about the string. "E1234567" is not a name; what else a
 * resident calls themselves is their business.
 *
 * UNANCHORED, so the "id with a bit tacked on" placeholder ("E1234567 Tan") is
 * refused too. Tested against the lowercased name, hence the lowercase `e`.
 */
const E_FORMAT_ID = /e\d{7}/;

/**
 * A display name is "proper" when it is present and is not an E-format NUSNET
 * id. That is the whole rule — nothing about the account's own identity is
 * consulted; see E_FORMAT_ID for why.
 */
export function isDisplayNameValid(
  displayName: string | null | undefined,
): boolean {
  const name = (displayName ?? "").trim();
  if (name.length < 2) return false;
  return !E_FORMAT_ID.test(name.toLowerCase());
}

export type ProfileSnapshot = {
  displayName: string | null | undefined;
  telegramHandle: string | null | undefined;
  block: number | null | undefined;
  matric: string | null | undefined;
};

/**
 * The required fields this user has NOT satisfied. Empty => their profile is
 * complete and proper, and the gate lets them through.
 */
export function computeProfileGaps(profile: ProfileSnapshot): ProfileField[] {
  const gaps: ProfileField[] = [];
  if (!isDisplayNameValid(profile.displayName)) gaps.push("displayName");
  if (!(profile.telegramHandle ?? "").trim()) gaps.push("telegramHandle");
  if (profile.block == null) gaps.push("block");
  if (!(profile.matric ?? "").trim()) gaps.push("matric");
  return gaps;
}
