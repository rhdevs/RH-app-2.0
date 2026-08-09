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
 *
 * THE FIRST AND ONLY EXCEPTION to an always-on gate. This gate was deliberately
 * built with NO kill switch (see the session callback in src/server/auth.ts:
 * "evaluated for EVERY identified session"), so carving anything out of it is a
 * significant act and is contained on purpose. The default `roles = []` on
 * `computeProfileGaps` is load-bearing: a caller that forgets to pass roles gets
 * the STRICT set, so the failure mode of forgetting is over-prompting, never
 * over-admitting. Read MINIMAL_PROFILE_ROLES below before adding anything to it.
 */

export type ProfileField = "displayName" | "telegramHandle" | "block" | "matric";

/**
 * A required-field set that is STRUCTURALLY INCAPABLE OF BEING EMPTY.
 *
 * `readonly` blocks `.push` / `.pop` / index assignment; the `[A, ...A[]]`
 * shape makes `= []` a compile error. Both halves are needed and both exist
 * because the comments below make a claim — "nobody can make the exempt set
 * empty by accident" — and a claim that only a comment enforces is not a
 * mechanism. An empty required set is not "one fewer field"; it is the gate
 * switched off, which is a much larger decision than any edit to this file
 * should be able to express by accident.
 */
type NonEmptyProfileFields = readonly [ProfileField, ...ProfileField[]];

/**
 * The fields a user must have before they may use the app — the STRICT set, and
 * the closed vocabulary of field names.
 *
 * UNCHANGED by the role-aware exemption below, deliberately: the admin surfaces
 * (UserDetailDialog, and the "known field" filter in userAdmin's WALL 2) filter
 * against this constant and must keep seeing all four names, or a field a deploy
 * does not recognise gets dropped. Only the PER-USER derivation
 * (`requiredProfileFieldsFor`) is role-aware.
 */
export const REQUIRED_PROFILE_FIELDS: NonEmptyProfileFields = Object.freeze([
  "displayName",
  "telegramHandle",
  "block",
  "matric",
] as const);

/**
 * THE EXEMPTION LIST — and it is a `Record`, not an array, ON PURPOSE.
 *
 * The key is a role string; the value is the JUSTIFICATION for exempting it. A
 * bare `["scrc"]` would let a future edit widen an always-on gate with a
 * five-character diff and no argument attached to it. A justification map forces
 * whoever adds a role to write down WHY in the same edit, in the same file the
 * reviewer is already reading, next to every other reason. That is the whole
 * point of the shape — do not "simplify" it to a list or a Set.
 *
 * THE ROLE STRING IS DUPLICATED FROM src/server/api/services/roles.ts ON
 * PURPOSE. This module must stay server-import-free (see the header): it is
 * value-imported by `"use client"` components, and importing SCRC_ROLE from the
 * server tree would drag the server module — and eventually Prisma — into the
 * browser bundle. The duplication is made safe by a COMPILE-TIME SUBSET
 * ASSERTION at the bottom of roles.ts (`_minimalRolesAreRealRoles`), which types
 * `Object.keys(MINIMAL_PROFILE_ROLES)` as `readonly Role[]`. A typo or an
 * invented role here is therefore a `tsc --noEmit` error, not a silently inert
 * exemption that nobody notices for months.
 *
 * REVIEWER CHECK: this object should have exactly one key. If it has grown, the
 * question to ask is whether the gate still protects anybody.
 */
export const MINIMAL_PROFILE_ROLES = Object.freeze({
  scrc: "Hall office staff. Not a resident: no matric to hold, no hall block to live in, and no reason to publish a Telegram handle to residents. Their display name is the only field the app renders about them.",
} as const);

/**
 * THE FLOOR. An exemption reduces the required set TO THIS CONSTANT — never to
 * `[]`. `displayName` stays mandatory for exempt roles because it is the one
 * field the app renders about them (on booking listings, via the owner join), so
 * an empty or NUSNET-shaped one is an impersonation surface exactly as it is for
 * a resident. `isDisplayNameValid` therefore still runs for exempt roles; see
 * `computeProfileGaps`.
 *
 * NOBODY CAN MAKE THE EXEMPT SET EMPTY BY ACCIDENT, and that is now enforced
 * rather than asserted: `NonEmptyProfileFields` makes `= []` a compile error and
 * `readonly` + `Object.freeze` block mutation at compile time and at runtime
 * respectively. An empty floor would turn the exemption into "no gate at all",
 * which is a different and much larger decision than "one fewer field", and it
 * should not be expressible as a typo.
 */
export const MINIMAL_REQUIRED_PROFILE_FIELDS: NonEmptyProfileFields =
  Object.freeze(["displayName"] as const);

/**
 * Does this role set earn the minimal profile requirement?
 *
 * ONE PREDICATE, consulted by the profile gate AND by the matric gate
 * (`matricProcedure` / `requireMatric` in src/server/api/trpc.ts). Two gates, one
 * definition, one place to widen, and greppable. Without the matric gate sharing
 * it, flipping the unrelated `rbac.matric.enforcement` switch would silently
 * strip the hall office's booking rights months later with no obvious cause.
 *
 * Takes `readonly string[]` rather than a `Role[]` so it can be handed a raw
 * session role list without a cast at every call site.
 *
 * `some`, NOT `every` — MOST-PRIVILEGED-EXEMPTION-WINS, and that is intended.
 * A holder of `["resident", "scrc"]` IS exempt. The alternative (`every`) would
 * mean a hall-office member who also happens to hold `resident` is gated on a
 * matric they do not have, which is the exact lockout this exemption exists to
 * prevent — and `resident` is minted by ensureBaseline for anyone with an
 * @u.nus.edu address, so the combination is not exotic. It is also consistent
 * with how the rest of the role system composes (`assignableBy` unions,
 * `canBookWithRoles` is `some`): holding MORE roles never takes something away.
 * Moot for the two EXT accounts this shipped for — they receive no `resident`
 * baseline at all (08 §3.4) — but it is the rule for anyone who is granted
 * `scrc` on a normal NUS account, and `scrc` is admin-grantable only.
 *
 * `hasOwnProperty.call` and NOT `MINIMAL_PROFILE_ROLES[r] !== undefined`: the
 * latter walks the prototype chain, so a stored role string of `"constructor"`
 * or `"__proto__"` would resolve to a truthy Object.prototype member and exempt
 * its holder from the profile gate. Unreachable today — `normalizeStoredRoles`
 * drops anything outside GRANTABLE_ROLES before these ever reach a session —
 * but the safe spelling costs nothing and does not depend on that staying true.
 */
export function isMinimalProfileRole(
  roles: readonly string[] | null | undefined,
): boolean {
  if (!roles) return false;
  return roles.some((r) =>
    Object.prototype.hasOwnProperty.call(MINIMAL_PROFILE_ROLES, r),
  );
}

/**
 * The required-field set for a specific user, given their roles.
 *
 * This is the ONLY per-user derivation. `REQUIRED_PROFILE_FIELDS` itself is
 * unchanged and stays the strict global vocabulary — the admin surfaces filter
 * against it and must keep seeing all four field names.
 *
 * Note the default: NO argument, or an empty list, yields the STRICT set. Every
 * call site that has not been taught about roles keeps byte-identical behaviour,
 * and the failure mode of forgetting to thread roles through is over-prompting.
 */
export function requiredProfileFieldsFor(
  roles: readonly string[] | null | undefined,
): ProfileField[] {
  // A COPY, not the constant itself — and the reason CHANGED when the two
  // source arrays became `readonly` + `Object.freeze`d, so it is restated
  // rather than left to rot. It is no longer "a caller could splice the
  // constant and rewrite the gate for every user in this lambda"; that is now
  // impossible. It is that this function's declared return type is a MUTABLE
  // `ProfileField[]`, and the value is handed to client components as a prop.
  // Returning a frozen array behind a mutable type would turn an ordinary
  // `.sort()` or `.push()` in a consumer into a runtime TypeError in
  // production. Hand back something that is actually what the signature says.
  return [
    ...(isMinimalProfileRole(roles)
      ? MINIMAL_REQUIRED_PROFILE_FIELDS
      : REQUIRED_PROFILE_FIELDS),
  ];
}

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
 * Is one field satisfied? Split out so `computeProfileGaps` can ITERATE the
 * required set rather than restate it as a fixed list of `if`s. That is not a
 * style preference: the previous body hardcoded all four checks, so the required
 * set and the gap computation were two independent statements of the same thing
 * and a role-aware set could silently disagree with them. Iterating
 * `requiredProfileFieldsFor()` makes disagreement unrepresentable.
 *
 * The `switch` is exhaustive over `ProfileField`, so adding a field to the type
 * without teaching this function about it is a compile error.
 */
function isFieldSatisfied(
  field: ProfileField,
  profile: ProfileSnapshot,
): boolean {
  switch (field) {
    case "displayName":
      return isDisplayNameValid(profile.displayName);
    case "telegramHandle":
      return Boolean((profile.telegramHandle ?? "").trim());
    case "block":
      return profile.block != null;
    case "matric":
      return Boolean((profile.matric ?? "").trim());
  }
}

/**
 * The required fields this user has NOT satisfied. Empty => their profile is
 * complete and proper, and the gate lets them through.
 *
 * `roles` DEFAULTS TO `[]`, AND THAT DEFAULT IS LOAD-BEARING. An empty role list
 * is never exempt, so every call site that does not pass roles — today and in
 * any future edit — gets the STRICT four-field set, byte for byte what this
 * function returned before roles existed. An exemption is reachable only by a
 * caller that deliberately hands over a role list. Forgetting therefore
 * OVER-PROMPTS (a recoverable annoyance) and can never OVER-ADMIT.
 *
 * Order of the result follows the required-field list, so the completion
 * dialog's "Please add X, Y and Z" copy reads in a stable order.
 */
export function computeProfileGaps(
  profile: ProfileSnapshot,
  roles: readonly string[] = [],
): ProfileField[] {
  return requiredProfileFieldsFor(roles).filter(
    (field) => !isFieldSatisfied(field, profile),
  );
}
