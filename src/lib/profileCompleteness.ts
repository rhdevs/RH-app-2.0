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

const norm = (s: string) => s.trim().toLowerCase();

/** The local-part of an @-address, lowercased; "" if it is not an address. */
function emailLocalPart(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return norm(at === -1 ? email : email.slice(0, at));
}

/**
 * A display name is "proper" when it is present and is NOT just the user's own
 * identifiers. Blank, too short, equal to or containing their NUSNET id, or
 * equal to their email local-part or matric all count as improper — those are
 * exactly the auto-filled / placeholder names we are stamping out (a lot of
 * accounts currently have their NUSNET id as their name).
 */
export function isDisplayNameValid(
  displayName: string | null | undefined,
  identity: {
    userID?: string | null;
    email?: string | null;
    matric?: string | null;
  },
): boolean {
  const name = (displayName ?? "").trim();
  if (name.length < 2) return false;
  const n = norm(name);

  const uid = identity.userID ? norm(identity.userID) : "";
  // Equal to OR containing the NUSNET id: "E1234567" and "E1234567 Tan" are both
  // rejected — the second is the "id with a bit tacked on" placeholder.
  if (uid && (n === uid || n.includes(uid))) return false;

  const local = emailLocalPart(identity.email);
  if (local && n === local) return false;

  const matric = identity.matric ? norm(identity.matric) : "";
  if (matric && n === matric) return false;

  return true;
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
export function computeProfileGaps(
  profile: ProfileSnapshot,
  identity: { userID?: string | null; email?: string | null },
): ProfileField[] {
  const gaps: ProfileField[] = [];
  if (
    !isDisplayNameValid(profile.displayName, {
      ...identity,
      matric: profile.matric,
    })
  ) {
    gaps.push("displayName");
  }
  if (!(profile.telegramHandle ?? "").trim()) gaps.push("telegramHandle");
  if (profile.block == null) gaps.push("block");
  if (!(profile.matric ?? "").trim()) gaps.push("matric");
  return gaps;
}
