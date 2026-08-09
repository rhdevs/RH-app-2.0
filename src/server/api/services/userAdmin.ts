import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { canonicalUserID, type CanonicalUserID } from "~/lib/identity";
import { getUserRoles } from "./access";
import { resolvePrincipalID } from "./authAllowlist";
import { ADMIN_ROLE } from "./roles";

/**
 * SERVICE LAYER for admin CRUD over USER DETAILS (/admin/users detail dialog).
 *
 * Everything here is keyed on the `User` ObjectId the operator clicked, and the
 * canonical identity is DERIVED server-side from the stored email. There is no
 * client-supplied userID anywhere in this file, on purpose:
 *
 *   `User.userID` IS NOT THE IDENTITY. It holds an A-format matric on ~515 rows
 *   and, on the split-identity rows, ANOTHER LIVE HUMAN'S canonical key —
 *   scripts/remediation/fix-claresta-duplicate.mjs documents an account whose
 *   stored userID is E1156816, which is a different person's key. Keying a
 *   cascade on that column is how you delete a stranger's 25 bookings.
 *
 * The same pattern services/ccaMembers.ts already establishes for
 * `removeCcaMember`: the caller hands us the User.id the table deduped on, and
 * we recompute the key set from the User document.
 *
 * ROLES ARE NOT WRITTEN HERE. `deleteUserAccountCascade` REMOVES the whole
 * `UserRole` document; it never writes a role set, so I-14 ("cca_head is
 * written only by the CCA path") and I-8c ("resident cannot be stripped by a
 * role write") are untouched — there is no role write to get wrong.
 *
 * NO AUDIT ROW IS WRITTEN FROM THIS FILE except by the target guard, which
 * takes its writer as a PARAMETER (see AuditWriter below). Every other audit
 * row is the router's job, AFTER the transaction returns (I-15).
 */

/* ========================================================================== */
/* 1. THE KILL SWITCH                                                         */
/* ========================================================================== */

/**
 * `admin.userDelete.enabled` -> "on" | anything else.
 *
 * Same shape and the same reasoning as `cca.management.enabled` in ccaScope.ts,
 * and DIFFERENT from the three enforcement switches in access.ts. Those gate
 * whether NEW enforcement applies to an EXISTING path, so they fail OPEN —
 * "behave as the app did yesterday". Behave as yesterday for a surface that did
 * not exist yesterday means DISABLED. An absent row and an unreachable flag both
 * return false.
 *
 * This is the only irreversible write in the admin surface, against a
 * production database of ~1382 real accounts, and the SystemFlag row is the only
 * brake that does not need a Vercel redeploy (env vars are snapshotted per
 * deployment — see the SystemFlag model comment). To arm the feature:
 *   db.systemFlag.upsert({ where: { key: "admin.userDelete.enabled" },
 *     create: { key: "admin.userDelete.enabled", value: "on" },
 *     update: { value: "on" } })
 * It takes effect within FLAG_TTL_MS on each lambda; no redeploy.
 */
const DELETE_FLAG_KEY = "admin.userDelete.enabled";
const FLAG_TTL_MS = 15_000;

let deleteFlagCache: { at: number; on: boolean } | null = null;

export async function isUserDeleteEnabled(db: PrismaClient): Promise<boolean> {
  if (deleteFlagCache && Date.now() - deleteFlagCache.at < FLAG_TTL_MS) {
    return deleteFlagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: DELETE_FLAG_KEY },
    });
    const on = row?.value === "on";
    deleteFlagCache = { at: Date.now(), on };
    return on;
  } catch {
    // Fail CLOSED, and deliberately NOT cached — the next request retries
    // rather than pinning "disabled" for 15s on a transient Atlas hiccup.
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetUserDeleteCache(): void {
  deleteFlagCache = null;
}

/**
 * Assert the switch is on. Called at the TOP of the delete mutation, before
 * anything else — the page-level check is cosmetic, this one is the boundary.
 */
export async function assertUserDeleteEnabled(db: PrismaClient): Promise<void> {
  if (!(await isUserDeleteEnabled(db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "USER_DELETE_DISABLED",
    });
  }
}

/* ========================================================================== */
/* 2. THE RESOLVED TARGET                                                     */
/* ========================================================================== */

/**
 * One user, resolved from an ObjectId. This is the ONLY way any procedure in
 * the admin user-detail surface learns who it is acting on.
 */
export type AdminUserTarget = {
  userObjectId: string;
  email: string;
  /** DERIVED from the email, never client-supplied. null for a non-NUS row. */
  canonicalUserID: CanonicalUserID | null;
  /** The STORED legacy column. Display + mismatch detection ONLY. */
  legacyUserID: string | null;
  displayName: string | null;
  telegramHandle: string | null;
  bio: string | null;
  block: number | null;
};

/**
 * Load the target by `User._id`.
 *
 * THE SELECT IS A SECURITY CONTROL, not tidiness — the same one
 * user.getCurrentUserData carries. #9: passwordHash must never reach the client
 * or the React Query cache. I-2: schema.prisma declares passwordHash optional
 * precisely because PrismaAdapter-created (Google) rows may lack it, and Prisma
 * 6's Mongo connector throws when it deserializes a document missing a required
 * non-list scalar — an explicit select keeps this path off the field entirely.
 * Never replace this with a bare `findUnique`.
 */
export async function loadAdminUserTarget(
  db: PrismaClient,
  userObjectId: string,
): Promise<AdminUserTarget> {
  const row = await db.user.findUnique({
    where: { id: userObjectId },
    select: {
      id: true,
      email: true,
      userID: true,
      displayName: true,
      telegramHandle: true,
      bio: true,
      block: true,
    },
  });

  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_USER" });
  }

  return {
    userObjectId: row.id,
    email: row.email,
    /**
     * I-1 STILL HOLDS: this is derived from the EMAIL and from nowhere else.
     * `row.userID` is NOT consulted for it — that column is carried alongside,
     * for display and for the mismatch check, because on ~515 rows it holds an
     * A-format matric and on the split-identity rows it holds ANOTHER LIVE
     * HUMAN'S key.
     *
     * It now resolves the `EXT:` namespace too, so an allowlist-pinned account's
     * admin record is keyed exactly the way the session keys it. Three
     * consequences, each verified rather than assumed:
     *
     *  - userAdmin.get reads the target's roles under the right key, so the
     *    role-aware profile gate agrees with the session. WITHOUT THIS the
     *    role-awareness is inert for exactly the accounts it was added for, and
     *    the admin surface reports "missing matric/block/telegram" for a user
     *    the gate is not holding — a false alarm on the one page whose job is
     *    diagnosing the gate.
     *  - assertMayManageUserProfileOf's CANNOT_MODIFY_AN_UNKEYED_ACCOUNT branch
     *    stops firing, so A JCRC CAN NOW EDIT A PINNED ACCOUNT'S displayName /
     *    block / bio. ACCEPTED, and stated here rather than discovered: it is
     *    identical to how every resident is already treated (`scrc` is not
     *    `admin`), it does not reach roles, matric-as-identity or email, and
     *    the alternative — leaving `cid` null — breaks the bullet above and
     *    re-opens the delete hazard below by a different door.
     *  - computeDeleteRefusals' ABSENT_CANONICAL_ID and LEGACY_KEY_MISMATCH
     *    stop firing, which makes DELETE reachable. That is why
     *    PINNED_ALLOWLIST_ACCOUNT exists — see it.
     */
    canonicalUserID: await resolvePrincipalID(db, row.email),
    legacyUserID: row.userID,
    displayName: row.displayName,
    telegramHandle: row.telegramHandle,
    bio: row.bio,
    block: row.block,
  };
}

/* ========================================================================== */
/* 3. THE TARGET GUARD — G3 restated for this path                            */
/* ========================================================================== */

/**
 * The audit entry shape this module needs. Structurally a subset of admin.ts's
 * `AuditEntry`, so `writeAudit` is directly assignable to `AuditWriter`.
 *
 * NOTE `targetUserID?: string` — NOT `string | null`. The absent identity must
 * be spent as `undefined` (which writeAudit turns into a stored null), never as
 * `""`. That is the sentinel bug class, and the type is what stops it here.
 */
export type AdminAuditEntry = {
  actorUserID: string;
  actorRoles?: string[];
  targetUserID?: string;
  action: string;
  rolesBefore?: string[];
  rolesAfter?: string[];
  reason?: string;
  ok?: boolean;
  denyReason?: string;
  batchId?: string;
};

/**
 * The audit writer, INJECTED rather than imported.
 *
 * `writeAudit` lives in routers/admin.ts, which pulls in `node:crypto` and
 * `~/env`. ccaAdmin.ts imports it across that boundary and that is acceptable;
 * this module takes it as a parameter instead, deliberately, so that
 * `services/` never depends on `routers/` — the same reason redeemPendingGrants
 * keeps its own local writer. Pick one per module and say which; this one is
 * injection.
 */
export type AuditWriter = (
  db: PrismaClient,
  entry: AdminAuditEntry,
) => Promise<void>;

/**
 * G3 for the user-detail path. The generic role guards are not reachable from
 * here, so the target guard is re-stated: a jcrc must not be able to reach an
 * admin's document through the profile-edit endpoints either.
 *
 * APPLIED ON EVERY PROCEDURE IN THIS SURFACE, READ INCLUDED — `get`,
 * `updateProfile`, `getDeletionImpact`, `delete`.
 *
 * `get` was exempt at first, to avoid an admin-enumeration oracle: for a target
 * WITH a canonical id this guard denies if and only if that target holds admin,
 * so one click per table row separates the admins from everyone else — the exact
 * enumeration D-2's
 * `listUsers` redaction (routers/admin.ts, "a jcrc must not be handed an
 * enumeration of who holds admin") goes to the trouble of hiding, and each probe
 * writes a `denied` row on the highest-signal action this system records.
 *
 * That reasoning was real, but it bought the wrong thing. `get` returns matric,
 * telegramHandle, bio and the profile gaps, and NONE of those is in the
 * `listUsers` projection — so leaving the read open handed every jcrc any
 * admin's matriculation number and contact handle. Redaction does not rescue it
 * either: blanking exactly those fields for admin targets IS the same oracle one
 * field over, and blanking them for all targets would remove the data the
 * surface exists to repair.
 *
 * So the enumeration is the ACCEPTED cost, and it is the cheaper of the two: it
 * was already reachable by attempting one SAVE per row (the write-shaped oracle
 * the house accepts in assertMayManageCcaHeadOf and deletePendingGrant), the
 * `denied` rows make a jcrc paging the table visible rather than silent, and
 * "a jcrc must never reach an admin's document" is the stated rule for this
 * surface. `get` still applies D-2's `admin` redaction on top, so a manager
 * reading a NON-admin's record still never learns who else holds admin.
 *
 * THERE ARE TWO DENIALS, not one. `CANNOT_MODIFY_AN_ADMIN` is the target-holds-
 * admin case above; `CANNOT_MODIFY_AN_UNKEYED_ACCOUNT` refuses a non-admin actor
 * on a target with no canonical id at all, where the target's authority cannot be
 * evaluated in either direction. The full argument is on the branch itself. That
 * second denial adds NO oracle: the address is already in the table's email
 * column, so a jcrc can see which rows are not @u.nus.edu without clicking.
 *
 * Modelled on assertMayManageCcaHeadOf (routers/admin.ts). Denials are audited
 * on `db`, OUTSIDE any transaction (I-15) — a denial row written inside the
 * transaction it is denying is rolled back by the throw, which erases exactly
 * the event that most needs a trail.
 *
 * THERE IS DELIBERATELY NO E-FORMAT TEST HERE. `g.s_samuel@u.nus.edu` ->
 * G.S_SAMUEL and `chuamingyuan@u.nus.edu` -> CHUAMINGYUAN are real accounts
 * (L-27). E_FORMAT is a validation rule for GRANT TARGETS only (guard G7);
 * applying it here would make those residents' records unreachable.
 */
export async function assertMayManageUserProfileOf(
  db: PrismaClient,
  actorUserID: string,
  actorRoles: readonly string[],
  target: AdminUserTarget,
  writeAudit: AuditWriter,
): Promise<void> {
  const deny = async (reason: string): Promise<never> => {
    await writeAudit(db, {
      actorUserID,
      actorRoles: [...actorRoles],
      // undefined, never "" — see AdminAuditEntry.
      targetUserID: target.canonicalUserID ?? undefined,
      action: "denied",
      ok: false,
      denyReason: reason,
      reason: `user detail: ${target.email}`,
    });
    throw new TRPCError({ code: "FORBIDDEN", message: reason });
  };

  /* ---- NO CANONICAL ID: ADMIN ONLY, and this branch used to PASS -------------
   * It passed on the premise that "an account with no canonical id holds NO
   * stored roles by construction — UserRole is canonical-keyed, so there is no
   * key under which such a row could have been written". THAT PREMISE IS FALSE,
   * and it is refuted by the ABSENT_CANONICAL_ID note in this very file: before
   * the eligibility cutover src/server/auth.ts derived a key from ANY address
   * with an unanchored replace, so `alice@gmail.com` became "ALICE@GMAIL.COM",
   * and rows written in that era are still filed under it. `UserRole` is in
   * rbac-doctor.mjs's OWNED_BY_USERID list precisely so `--nonnus` can enumerate
   * them. So a cid-less row CAN carry a `UserRole` holding `admin` — under a key
   * this deploy can no longer derive.
   *
   * IT IS UNEVALUABLE AUTHORITY, NOT ABSENT AUTHORITY, and the two get opposite
   * treatment. `getUserRoles` keys on the canonical id, so such a string is inert
   * everywhere in the live app and no privilege is reachable through it — but
   * "this account's roles cannot be read" is not a licence for a lesser role to
   * open its record. `get` returns matric, telegramHandle and bio (none of which
   * is in the listUsers projection) and `updateProfile` rewrites the displayName
   * that renders to other users on every booking listing. The stated rule for
   * this surface is that a jcrc never reaches a document whose authority they
   * cannot be shown not to hold; failing OPEN on the one population whose
   * authority cannot be evaluated at all inverts it.
   *
   * SO: admin passes, everyone else is denied and audited. The refusal is worth
   * the friction — these accounts are among the messiest in the collection, and
   * the edit form is nearly inert for them anyway (matric disabled, WALL 1
   * suppressed, "correcting the address needs a developer"), while `delete`
   * already refuses every one of them with ABSENT_CANONICAL_ID.
   *
   * STILL NO `getUserRoles(db, null)`. The decision is made from the actor's
   * roles alone, so no absent id reaches a `where: { userID }` clause — the
   * sentinel rule is intact, and getUserRoles' own `if (!userID) return []`
   * remains a guard rather than a licence.
   *
   * NAMED `CANNOT_MODIFY_AN_UNKEYED_ACCOUNT`, not `NO_CANONICAL_IDENTITY`: that
   * second string is already updateProfile's matric refusal in the client's
   * shared error map (src/app/admin/_lib/userDetail.ts), and reusing it would
   * print "this account has no matric record" as the reason a jcrc was refused
   * the whole dialog. Same call ABSENT_CANONICAL_ID's own naming note makes.
   */
  if (target.canonicalUserID === null) {
    if (!actorRoles.includes(ADMIN_ROLE)) {
      await deny("CANNOT_MODIFY_AN_UNKEYED_ACCOUNT");
    }
    return;
  }

  if (!actorRoles.includes(ADMIN_ROLE)) {
    // I-5: the TARGET's roles are re-read from the database, never taken from
    // any session or from a list projection. A stale copy here is a jcrc
    // reaching a freshly-promoted admin's record.
    const targetRoles = await getUserRoles(db, target.canonicalUserID);
    if (targetRoles.includes(ADMIN_ROLE)) await deny("CANNOT_MODIFY_AN_ADMIN");
  }
}

/* ========================================================================== */
/* 4. THE REFUSAL SET — one implementation, used by preview AND commit         */
/* ========================================================================== */

/**
 * Why a delete is refused. Returned as DATA so the preview and the mutation can
 * share ONE implementation; two copies of a refusal list is how the preview
 * starts saying yes to something the mutation refuses.
 */
export type DeleteRefusal =
  | "CANNOT_DELETE_SELF"
  | "CANNOT_DELETE_AN_ADMIN"
  | "ABSENT_CANONICAL_ID"
  | "LEGACY_KEY_MISMATCH"
  | "SHARED_CANONICAL_ID"
  | "PINNED_ALLOWLIST_ACCOUNT"
  | `SOLE_HEAD_OF_CCA:${number}`;

/**
 * Every OTHER live `User` row whose email canonicalises to the same key.
 *
 * WHY THIS EXISTS — and why LEGACY_KEY_MISMATCH does not already cover it.
 * That refusal proves the canonical key is COMPLETE for this row: nothing of
 * theirs is filed under some other id. It does NOT prove the key is EXCLUSIVE
 * to it, and the cascade needs BOTH. `deleteUserAccountCascade` removes ONE
 * User document by `_id` but cleans thirteen collections with
 * `deleteMany({ where: { userID: cid } })`. If a second User row canonicalises
 * to the same cid, every one of those deleteManys takes the OTHER account's
 * rows — its UserRole, its CcaHead scopes, its matric, its bookings — while its
 * User row survives untouched. The survivor is then a LIVE account stripped of
 * everything but a self-healed `resident` (auth.ts is explicit that `jcrc` and
 * `cca_head` have no self-heal path: nothing puts them back), and because the
 * rows were DELETED rather than orphaned, no orphan check afterwards can see
 * that it happened. It is the same destruction LEGACY_KEY_MISMATCH exists to
 * prevent, reached through a different door.
 *
 * THE POPULATION IS MEASURED, NOT HYPOTHETICAL. `email_unique_ci` folds CASE
 * but not WHITESPACE, while `canonicalUserID` trims — so `"e0425010@u.nus.edu "`
 * and `"e0425010@u.nus.edu"` are two rows to the index and ONE identity to the
 * app. Neither trips LEGACY_KEY_MISMATCH, because that compares the STORED
 * `User.userID` column against cid and on these rows it is null or already
 * equal. scripts/remediation/merge-by-canonical.mjs exists to merge exactly
 * these sets, and the 2026-07-19 census counted 66 of them.
 *
 * THE QUERY IS DELIBERATELY OVER-BROAD, THEN FILTERED IN MEMORY BY THE ONE
 * DERIVATION. `contains` + `mode: "insensitive"` compiles to a regex on the
 * Mongo connector, so a localpart containing `.` or `%` matches MORE rows than
 * it should — which is safe, because `canonicalUserID` is the decider here and
 * it is the same function the cascade keys on. Never narrow this to an equality
 * on `${cid}@u.nus.edu`: the whitespace variant is precisely what it must catch.
 */
export async function findCanonicalIdCollisions(
  db: Omit<PrismaClient, `$${string}`>,
  cid: CanonicalUserID,
  selfObjectId: string,
): Promise<{ id: string; email: string }[]> {
  const candidates = await db.user.findMany({
    where: { email: { contains: cid, mode: "insensitive" } },
    select: { id: true, email: true },
  });
  return candidates.filter(
    (u) => u.id !== selfObjectId && canonicalUserID(u.email) === cid,
  );
}

/**
 * Compute every reason this account may not be deleted.
 *
 * NEVER AUDITS AND NEVER THROWS. It is called by the preview as well as by the
 * mutation, and a preview must not emit denial rows for a hypothetical — the
 * DryRunDenied precedent in routers/admin.ts. The mutation writes ONE denial row
 * itself when this returns a non-empty list.
 */
export async function computeDeleteRefusals(
  db: PrismaClient,
  actorUserID: string,
  target: AdminUserTarget,
): Promise<DeleteRefusal[]> {
  const out: DeleteRefusal[] = [];
  const cid = target.canonicalUserID;

  // --- there is no canonical key at all -------------------------------------
  // THE SAME CLASS AS LEGACY_KEY_MISMATCH, one step further along: there the key
  // is not provably COMPLETE, here there is no key to prove anything about.
  // `canonicalUserID` returns null for every address that is not @u.nus.edu, and
  // `deleteUserAccountCascade` therefore cleans NOTHING for such a row — every
  // dependent delete sits inside `if (cid !== null)`, so the transaction removes
  // the `User` document alone.
  //
  // "NO CANONICAL KEY" IS NOT THE SAME STATEMENT AS "OWNS NOTHING", and this
  // function used to imply it was (see the corollary further down, and the
  // preview panel that printed "Nothing else is attached to it" off the all-zero
  // footprint). Before the eligibility cutover src/server/auth.ts derived a key
  // from ANY address with an unanchored replace — `alice@gmail.com` became
  // "ALICE@GMAIL.COM" — and rows written in that era are still filed under it.
  // The population is real enough to have its own report:
  // `node scripts/remediation/rbac-doctor.mjs --nonnus` step [2] exists to
  // enumerate "rows owned under the legacy key" for exactly these accounts.
  // Destroying the owning `User` row on top of them leaves Bookings holding
  // facility slots on the calendar under a key no live account resolves to, which
  // no user-facing cancel path can reach and no orphan sweep can attribute.
  //
  // COUNTING THEM INSTEAD OF REFUSING WAS THE OTHER OPTION, AND IT IS WORSE. It
  // needs the pre-cutover derivation restated in src/ — a second identity
  // derivation, which I-12 forbids and which
  // scripts/remediation/verify-identity-parity.mjs enforces by sweeping
  // src/**/*.ts for precisely that — and the cascade still could not clean what
  // it found, so the blast-radius panel would be reporting rows that SURVIVE the
  // delete. The remedy is the hand-audited script, same as LEGACY_KEY_MISMATCH.
  //
  // NAMED `ABSENT_CANONICAL_ID`, NOT `NO_CANONICAL_IDENTITY`. That second string
  // is already in the client's shared error map (src/app/admin/_lib/userDetail.ts)
  // as `updateProfile`'s matric refusal, and `friendlyError` serves BOTH dialogs —
  // reusing it would print "this account has no matric record" as the reason a
  // delete was refused.
  if (cid === null) out.push("ABSENT_CANONICAL_ID");

  // --- the identity was ISSUED BY AN ALLOWLIST PIN --------------------------
  // A pinned account is now DELETABLE as far as every other refusal here is
  // concerned: loadAdminUserTarget resolves the EXT namespace, so cid is
  // non-null (ABSENT_CANONICAL_ID does not fire) and provisioning writes the
  // pin into `User.userID` (LEGACY_KEY_MISMATCH does not fire either). Without
  // this refusal the delete would go through.
  //
  // AND `deleteUserAccountCascade` DOES NOT KNOW ABOUT AuthAllowlist. It cleans
  // thirteen collections and that is not one of them, so the delete would leave
  // the pin standing. Re-creating a `User` row on that address — which anyone
  // could then do, because maySignIn still admits it — RE-ATTACHES the identity,
  // and with it any UserRole document the cascade did not reach. That is
  // 07-cca-future.md §5's hazard exactly, and it is the same shape as the attack
  // the whole collection is designed against: a key spent by a party who was
  // never granted it.
  //
  // REFUSING RATHER THAN EXTENDING THE CASCADE, deliberately. The pin is an
  // ADMIN-ISSUED CREDENTIAL. Destroying it should be a separate, deliberate,
  // audited act on the surface that issued it (admin.removeAuthAllowlistEntry),
  // not a silent side effect inside a thirteen-collection transaction that also
  // carries a retention special case for Bookings. The operator's path is:
  // revoke the roles, remove the pin, then delete the account — three audit
  // rows instead of one.
  //
  // PAIRED WITH removeAuthAllowlistEntry's PIN_STILL_HOLDS_ROLES, which refuses
  // the OPPOSITE order. Two locks on opposite doors: you cannot delete the
  // account while the pin lives, and you cannot remove the pin while it holds
  // roles. The only way through is the one that leaves a complete trail.
  if (cid !== null) {
    const pin = await db.authAllowlist.findUnique({
      where: { pinnedUserID: cid },
      select: { id: true },
    });
    if (pin) out.push("PINNED_ALLOWLIST_ACCOUNT");
  }

  // --- self -----------------------------------------------------------------
  // Without this an admin can delete themselves straight out of the last-admin
  // guard: that guard lives inside applyRoleChange's transaction and cannot see
  // a deletion, and there is deliberately no in-app path to mint the first
  // admin. (Subsumed by CANNOT_DELETE_AN_ADMIN for an admin actor, but stated
  // separately so the UI can say "you can't delete your own account" and so it
  // still holds if the capability tier is ever widened.)
  if (cid !== null && cid === actorUserID) out.push("CANNOT_DELETE_SELF");

  // --- the target holds admin ----------------------------------------------
  // Applies to EVERY actor, admins included. Removing an admin is a two-step:
  // revoke `admin` via admin.setUserRoles (which DOES hold the transactional
  // last-admin guard), then delete. A blanket refusal is trivially provable; a
  // remaining-admin count inside the delete transaction would be a second copy
  // of a guard that already exists, and the second copy is the one that rots.
  if (cid !== null) {
    const targetRoles = await getUserRoles(db, cid);
    if (targetRoles.includes(ADMIN_ROLE)) out.push("CANNOT_DELETE_AN_ADMIN");
  }

  // --- split identity -------------------------------------------------------
  // This is exactly admin.listUsers' `keyMismatch` flag. Those rows are the
  // split identities the one-off scripts exist for —
  // fix-claresta-duplicate.mjs documents an account whose stored userID is
  // ANOTHER LIVE USER'S canonical key. Cleaning dependents under a key that is
  // not provably this row's is how you delete a stranger's 25 bookings. Refuse;
  // the operator uses a hand-audited script.
  //
  // For every OTHER row `userID` is either null or equal to the canonical id, so
  // cleaning under the canonical key alone is provably complete — that is what
  // this refusal buys the cascade below.
  //
  // COROLLARY, AND THE FALSE CONCLUSION IT USED TO CARRY: when cid is null any
  // non-empty stored value differs from null and refuses here too. That is now
  // belt-and-braces — ABSENT_CANONICAL_ID above refuses every cid-less row —
  // and it is stated this way deliberately, because the sentence it used to
  // justify ("so a non-NUS junk account is deletable and simply has no keyed
  // dependents") was wrong. No CANONICAL-keyed dependents is not "no
  // dependents"; see ABSENT_CANONICAL_ID for what such a row can still own.
  if (
    typeof target.legacyUserID === "string" &&
    target.legacyUserID.length > 0 &&
    target.legacyUserID !== (cid as string | null)
  ) {
    out.push("LEGACY_KEY_MISMATCH");
  }

  // --- a SECOND User row resolves to the same canonical id ------------------
  // The other half of the proof LEGACY_KEY_MISMATCH only half-supplies: that
  // key must be EXCLUSIVE to this row, not merely complete for it. Without
  // this, deleting the junk half of a whitespace-variant pair silently strips
  // the live half of its roles, headships, matric and bookings while leaving
  // its User row standing. See findCanonicalIdCollisions for the full argument
  // and for why the query is over-broad and then filtered.
  if (cid !== null) {
    const collisions = await findCanonicalIdCollisions(
      db,
      cid,
      target.userObjectId,
    );
    if (collisions.length > 0) out.push("SHARED_CANONICAL_ID");
  }

  // --- sole head of a CCA ---------------------------------------------------
  // setCcaHeads: "a headless CCA is the unrecoverable state". Transfer with
  // admin.transferCcaHead first. Counted per ccaID rather than in aggregate,
  // because a head of three CCAs may be the only head of exactly one of them.
  if (cid !== null) {
    const heads = await db.ccaHead.findMany({
      where: { userID: cid },
      select: { ccaID: true },
    });
    for (const { ccaID } of heads) {
      const total = await db.ccaHead.count({ where: { ccaID } });
      if (total === 1) out.push(`SOLE_HEAD_OF_CCA:${ccaID}`);
    }
  }

  return out;
}

/* ========================================================================== */
/* 5. THE IMPACT COUNTS (preview)                                             */
/* ========================================================================== */

/**
 * The collections `deleteUserAccountCascade` removes, in report order.
 *
 * `bookings` is the ONE partial entry: the count here is what will actually be
 * destroyed, which excludes the reservations a live Event or CcaInterviewSlot is
 * standing on. Those are reported apart, as `UserFootprint.retainedBookings`,
 * and rendered under "what survives" — a blast-radius panel that over-reports is
 * as misleading as one that under-reports.
 *
 * `order` IS DELIBERATELY ABSENT, and was here until the supper domain was taken
 * out of the cascade entirely — see the residue block at the foot of this file.
 * A count promising to destroy rows the cascade no longer touches is the same
 * defect as an absent count, pointing the other way.
 */
export const FOOTPRINT_COLLECTIONS = [
  "ccaHead",
  "userRole",
  "pendingRoleGrant",
  "userMatric",
  "profileCompletion",
  "eventSignup",
  "ccaInterviewNote",
  "ccaApplication",
  "userCCA",
  "bookings",
  "posts",
  "gym",
] as const;

export type FootprintCollection = (typeof FOOTPRINT_COLLECTIONS)[number];

export type UserFootprint = {
  counts: Record<FootprintCollection, number>;
  /** The CCAs this user heads — the UI resolves names for its copy. */
  headOfCcaIDs: number[];
  /**
   * Bookings of theirs that the cascade KEEPS because a CCA record depends on
   * them. Reported separately from `counts.bookings` (which is what will
   * actually be destroyed) and rendered under "What survives", not under "What
   * will be destroyed". See findInstitutionalBookings.
   */
  retainedBookings: number;
};

/**
 * Of a user's own Bookings rows, the ones that are somebody ELSE's reservation.
 *
 * WHY THIS EXISTS. A Bookings row is not always the personal reservation it
 * looks like. `event.ts` auto-books the room for an APPROVED event with
 * `userID: event.createdBy` and stores the `bookingID` back on the Event;
 * `ccaApplicationsHead.ts` does the same for a batch of interview slots and
 * stores it on every CcaInterviewSlot in the batch. Those two records are
 * DELIBERATELY KEPT by this cascade — see the residue block at the foot of this
 * file, "an event belongs to the CCA, not to the head who filed it" — so
 * deleting the Bookings row underneath them leaves a published event and live
 * interview slots whose room is silently free again: `findFacilityConflict`
 * sees nothing, another CCA books over the top, and `autoBookFailed` stays
 * false so the CCA's own UI still reports the room as held. Nothing surfaces
 * the loss, which is what makes it worse than a refusal.
 *
 * A canceled event or a canceled slot is NOT holding anything, so its booking
 * is the departing person's to take with them.
 */
export async function findInstitutionalBookings(
  db: Omit<PrismaClient, `$${string}`>,
  bookingIDs: number[],
): Promise<Set<number>> {
  const held = new Set<number>();
  if (bookingIDs.length === 0) return held;

  const [events, slots] = await Promise.all([
    db.event.findMany({
      // `not` compiles to $ne, which also matches a null/absent status — the
      // right answer here, since only an explicit "canceled" releases the room.
      where: { bookingID: { in: bookingIDs }, status: { not: "canceled" } },
      select: { bookingID: true },
    }),
    db.ccaInterviewSlot.findMany({
      where: { bookingID: { in: bookingIDs }, canceledAt: null },
      select: { bookingID: true },
    }),
  ]);
  for (const e of events) if (e.bookingID !== null) held.add(e.bookingID);
  for (const s of slots) if (s.bookingID !== null) held.add(s.bookingID);
  return held;
}

const ZERO_FOOTPRINT = (): Record<FootprintCollection, number> =>
  Object.fromEntries(FOOTPRINT_COLLECTIONS.map((k) => [k, 0])) as Record<
    FootprintCollection,
    number
  >;

/**
 * What a delete would destroy, per collection. Read-only.
 *
 * The operator must see the blast radius before typing anything; a confirmation
 * over an unknown quantity is theatre.
 *
 * When the canonical id is absent, this returns all zeros WITHOUT querying.
 * `where: { userID: null }` would be a Prisma type error and `where: { userID:
 * "" }` would count a ""-keyed stranger's rows as this account's — the sentinel
 * bug class, and the reason the count is not merely "skipped" but structurally
 * unreachable.
 *
 * THOSE ZEROS MEAN "NO CANONICAL-KEYED ROWS", NOT "NOTHING IS ATTACHED", and
 * they must never be rendered as the second statement. A pre-cutover account can
 * still own rows under the legacy derivation this app no longer computes (see
 * ABSENT_CANONICAL_ID on computeDeleteRefusals), and nothing here looks for them.
 * What keeps the zeros honest is that the delete REFUSES on this state, so the
 * panel showing them is describing an operation that will not run.
 */
export async function countUserFootprint(
  db: PrismaClient,
  target: AdminUserTarget,
): Promise<UserFootprint> {
  const cid = target.canonicalUserID;
  if (cid === null)
    return { counts: ZERO_FOOTPRINT(), headOfCcaIDs: [], retainedBookings: 0 };

  const where = { userID: cid };

  // CcaApplication is read (not just counted) because CcaInterviewNote is
  // reachable ONLY through applicationID — the same reason the cascade reads it
  // before deleting. See the note there on why authorUserID is not the key.
  const apps = await db.ccaApplication.findMany({
    where,
    select: { applicationID: true },
  });
  const applicationIDs = apps.map((a) => a.applicationID);

  const heads = await db.ccaHead.findMany({ where, select: { ccaID: true } });

  // Bookings are READ rather than counted, for the same reason CcaApplication
  // is: the count the operator must see is what will be DESTROYED, and the
  // reservations held for a live event or interview batch are not destroyed.
  const bookingRows = await db.bookings.findMany({
    where,
    select: { bookingID: true },
  });
  const heldBookings = await findInstitutionalBookings(
    db,
    bookingRows.map((b) => b.bookingID),
  );

  const [
    userRole,
    pendingRoleGrant,
    userMatric,
    profileCompletion,
    eventSignup,
    ccaInterviewNote,
    userCCA,
    posts,
    gym,
  ] = await Promise.all([
    db.userRole.count({ where }),
    db.pendingRoleGrant.count({ where }),
    db.userMatric.count({ where }),
    db.profileCompletion.count({ where }),
    db.eventSignup.count({ where }),
    applicationIDs.length
      ? db.ccaInterviewNote.count({
          where: { applicationID: { in: applicationIDs } },
        })
      : Promise.resolve(0),
    db.userCCA.count({ where }),
    db.posts.count({ where }),
    db.gym.count({ where }),
  ]);

  return {
    counts: {
      ccaHead: heads.length,
      userRole,
      pendingRoleGrant,
      userMatric,
      profileCompletion,
      eventSignup,
      ccaInterviewNote,
      ccaApplication: apps.length,
      userCCA,
      bookings: bookingRows.length - heldBookings.size,
      posts,
      gym,
    },
    headOfCcaIDs: heads.map((h) => h.ccaID),
    retainedBookings: heldBookings.size,
  };
}

/* ========================================================================== */
/* 6. THE CASCADE                                                             */
/* ========================================================================== */

/**
 * EXPLICIT, because Prisma's defaults are twelve times tighter than the limit
 * the cascade below reasons about. `$transaction(fn)` with no options is
 * `{ maxWait: 2000, timeout: 5000 }`, and src/server/db.ts sets no
 * `transactionOptions` — so the binding cap was 5 SECONDS, not Mongo's 60s
 * `transactionLifetimeLimitSeconds`. See the note on deleteUserAccountCascade
 * for what crossing it looks like from the operator's side.
 *
 * A NAMED CONSTANT rather than an inline object literal, so the options can be
 * passed after the transaction body without prettier re-wrapping 190 lines.
 */
const CASCADE_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

/**
 * Delete one account and everything keyed on its canonical identity.
 *
 * NOT deleteUserCascade. That helper takes a userID STRING and ends in
 * `user.deleteMany({ where: { userID } })`, which matches the STORED legacy
 * column — a column holding an A-format matric on ~515 rows and another live
 * human's canonical key on the split-identity rows. It also leaves UserRole,
 * CcaHead, UserMatric, ProfileCompletion, CcaApplication and PendingRoleGrant
 * behind. An orphaned UserRole is INHERITED by whoever next signs in on that NUS
 * address (docs/plans/rbac/05-verification.md §613): escalation reachable with
 * zero privilege. An orphaned CcaHead keeps a dead `cca_head` string alive
 * forever, because revokeCcaHead drops the string only when `remaining === 0`
 * and that count never reaches zero (cascade.ts GUARD 2).
 *
 * ORDER MATTERS — PRIVILEGE ROWS FIRST, THE User ROW LAST. A crash mid-way must
 * leave a survivor with LESS privilege and intact data, which re-running
 * repairs. The reverse order leaves a live grant with no owner, which is the
 * escalation residue above. Do not reorder for tidiness.
 *
 * CH-1 ("a user holds the `cca_head` string IFF they have >= 1 CcaHead row") is
 * preserved in BOTH directions because the string — carried on the UserRole
 * document — and every CcaHead row disappear in the SAME transaction. Afterwards
 * the invariant holds vacuously: no string, no rows.
 *
 * THIS DOES NOT BY ITSELF REVOKE A LIVE SESSION. Auth is `strategy: "jwt"` with
 * a 30-day maxAge and there is no server-side session store to delete, so the
 * departing person's browser still holds a valid token after this returns. What
 * closes that window is src/server/auth.ts's session callback: it reads the
 * `User` row by `_id` on every request and, when that read PROVABLY returns no
 * row (as opposed to faulting), returns early — skipping `ensureBaseline`,
 * without which the very next request would upsert a fresh
 * `UserRole { roles: ["resident"] }` under this canonical id and re-create the
 * orphan this cascade deletes in step 2. If that branch is ever removed, this
 * function stops being a delete.
 *
 * NOTE that the branch leaves `eligible` alone when another live row
 * canonicalises to the same id, because the same "row is gone" state is produced
 * by an account MERGE deleting the losing row — see the branch itself. That
 * probe FAILS CLOSED: an unproven collision revokes, because both outcomes land
 * on /onboarding/ineligible and both are resolved by signing out, so a timed-out
 * collection scan must not be a way for a deleted account to keep its authority.
 * The early return, and therefore the anti-resurrection guarantee above, applies
 * in both cases; only `eligible` is conditional.
 *
 * THE BINDING TIMEOUT IS PRISMA'S, NOT MONGO'S, and the two differ by twelve
 * times. Mongo aborts an interactive transaction at 60s
 * (`transactionLifetimeLimitSeconds`), but Prisma's own default for
 * `$transaction(fn)` is `{ maxWait: 2000, timeout: 5000 }` and src/server/db.ts
 * sets no `transactionOptions`, so WITHOUT the explicit options below this body
 * had 5 seconds. That is not academic: the common path is ~20 sequential round
 * trips and the institutional-booking loop below adds one more PER held booking,
 * so a departing CCA head with a batch of interview slots and several events is
 * comfortably past 5s on a Vercel lambda that is not co-located with the
 * cluster. The failure mode is P2028, which is a Prisma error rather than a
 * TRPCError, so `sanitizeErrors` rewrites it to "Something went wrong." and the
 * dialog tells the operator to retry something that will fail identically —
 * the heaviest accounts become undeletable through the UI. 30s leaves a wide
 * margin under Mongo's 60s while still bounding a wedged transaction.
 *
 * IF IT EVER TIMES OUT ANYWAY the fix is NOT to drop the transaction. Split it
 * at the PRIVILEGE BOUNDARY — steps 1-3 in one transaction, the rest in a
 * second — because the guarantee that matters is "privilege rows die first,
 * atomically". Un-atomicising the guard is the one change that turns a slow
 * delete into a security defect. Every delete below is a deleteMany on an
 * indexed field, and the only reads inside the transaction beyond the re-checks
 * are the applicationID list, the bookings list and ONE successor lookup for the
 * whole booking loop (see there — it was per-booking, which made the round-trip
 * count scale with the number of rooms the departing head had reserved).
 */
export async function deleteUserAccountCascade(
  db: PrismaClient,
  target: AdminUserTarget,
  actorUserID: string,
): Promise<{ deleted: Record<string, number>; retainedBookings: number }> {
  const cid = target.canonicalUserID;
  const deleted: Record<string, number> = {};
  let retainedBookings = 0;

  /* THE SECOND BOUNDARY ON ABSENT_CANONICAL_ID — not a duplicate of the first.
   * computeDeleteRefusals is the refusal SET, evaluated by the router and
   * rendered by the preview; this is the property that makes "remove the User
   * row and clean nothing" structurally unreachable rather than dependent on
   * every caller remembering to consult that list. Every dependent delete below
   * is inside `if (cid !== null)`, so without this a cid-less target would run
   * the whole transaction, skip all of them, and destroy the account anyway —
   * orphaning whatever it owns under the pre-cutover legacy key (rbac-doctor
   * --nonnus step [2] is the report that enumerates those rows).
   *
   * BEFORE the transaction opens, deliberately: there is nothing to roll back,
   * and a refusal does not need 30 seconds of interactive-transaction budget.
   */
  if (cid === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "ABSENT_CANONICAL_ID",
    });
  }

  await db.$transaction(async (tx) => {
    /* ---- (a) RE-CHECK INSIDE THE TRANSACTION -------------------------------
     * Exactly the pattern applyRoleChange uses for its last-admin count:
     * read-then-write outside a transaction is not enough. The preflight ran
     * seconds ago in OPERATOR time; a concurrent revokeCcaHead on the co-head,
     * or a concurrent setUserRoles granting admin, lands comfortably inside
     * that window. The worst case here is a PRECONDITION_FAILED at commit time
     * instead of a bad delete.
     *
     * WHAT "INSIDE THE TRANSACTION" DOES AND DOES NOT BUY, because the four
     * checks below are not equally strong and reading them as one guarantee is
     * how the weak one gets trusted. Mongo gives snapshot isolation and detects
     * conflicts ONLY on documents two transactions both WRITE — there is no
     * predicate or gap locking, so a count read in here is not stable against a
     * concurrent transaction that has not yet committed. A re-check is therefore
     * airtight exactly when the row that would falsify it is a row THIS
     * transaction goes on to write:
     *
     *   CANNOT_DELETE_AN_ADMIN — AIRTIGHT. A concurrent setUserRoles writes the
     *     very UserRole document step 2 below deletes, so one of the two aborts.
     *   CANNOT_DELETE_SELF — AIRTIGHT; it compares two values, not stored state.
     *   SHARED_CANONICAL_ID — narrows the window to the transaction rather than
     *     closing it: a signup committing between this read and our commit is
     *     invisible here and writes a User row we never touch. It is still worth
     *     running, because the operator-time window it removes is seconds long
     *     and this one is milliseconds.
     *   SOLE_HEAD_OF_CCA — the WEAK one. See the loop.
     */
    if (cid !== null) {
      if (cid === actorUserID) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "CANNOT_DELETE_SELF",
        });
      }

      const roleRow = await tx.userRole.findUnique({ where: { userID: cid } });
      const stored = roleRow?.roles?.length
        ? roleRow.roles
        : roleRow?.role
          ? [roleRow.role]
          : [];
      if (stored.includes(ADMIN_ROLE)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "CANNOT_DELETE_AN_ADMIN",
        });
      }

      // Re-checked here for the SAME reason as the two above, and with a
      // sharper race: a signup on the whitespace variant of this address —
      // which `email_unique_ci` does NOT prevent, because it folds case and not
      // whitespace — can land in the operator's confirmation window and turn a
      // safe delete into one that strips the new account. Everything below this
      // point deletes by `where: { userID: cid }`, so this is the last moment
      // the key can be proved exclusive.
      const collisions = await findCanonicalIdCollisions(
        tx,
        cid,
        target.userObjectId,
      );
      if (collisions.length > 0) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "SHARED_CANONICAL_ID",
        });
      }

      /* THE RESIDUAL RACE, STATED RATHER THAN CLAIMED CLOSED. Two concurrent
       * deletes of the two co-heads of one CCA both read `total === 2` in their
       * own snapshots and each deletes only ITS OWN CcaHead document. The
       * conflicting row is the CO-HEAD's, which this transaction never writes,
       * so Mongo sees no write conflict, both commit, and the CCA ends headless
       * — the state setCcaHeads calls unrecoverable. Being inside the
       * transaction does not fix this; see the taxonomy in (a).
       *
       * WHY IT IS NOT FORCED TO CONFLICT. The mechanical fix is to make both
       * transactions write one shared document (bump a per-CCA row, or touch the
       * sibling CcaHead rows) so one aborts. Every version of it costs more than
       * it buys HERE:
       *   - a no-op touch is not reliable — Mongo skips a $set that changes
       *     nothing, so no write intent is registered and no conflict occurs;
       *   - a real bump needs a field or a row that does not exist, i.e. a
       *     migration, on a collection whose $jsonSchema validators reject
       *     undeclared fields at write time (see CcaProfile in schema.prisma);
       *   - withCcaLock is an advisory lock taken OUTSIDE a transaction, on the
       *     `ccaApp:` keyspace that serialises the applications workflow, and
       *     locking one CCA per headship means ordered multi-lock acquisition
       *     inside the app's only irreversible write.
       * And none of them would deliver the invariant anyway, because
       * admin.revokeCcaHead has NO sole-head guard at all: it will remove the
       * last head of a CCA on its own, today, with no race required. A headless
       * CCA is therefore a repairable state this codebase already permits —
       * grantCcaHead and setCcaHeads both accept a CCA with zero heads — not one
       * this check can promise to prevent.
       *
       * SO WHAT THIS CHECK IS FOR: the OPERATOR-time window, which is the one
       * that actually happens. The preview was rendered, read and confirmed by a
       * human; seconds to minutes passed; a co-head may have been revoked in
       * them. Same posture as assertMatricUnclaimed — racy in principle, and the
       * residue is a state the system can already be talked into rather than a
       * new failure mode. Do not upgrade the wording of this comment without
       * upgrading the mechanism.
       */
      const heads = await tx.ccaHead.findMany({
        where: { userID: cid },
        select: { ccaID: true },
      });
      for (const { ccaID } of heads) {
        const total = await tx.ccaHead.count({ where: { ccaID } });
        if (total === 1) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `SOLE_HEAD_OF_CCA:${ccaID}`,
          });
        }
      }
    }

    /* ---- (b)/(c) the keyed dependents --------------------------------------
     * The WHOLE block is guarded on a non-null canonical id. A
     * `where: { userID: "" }` (or a null laundered into one) here would delete a
     * ""-keyed stranger's rows: the sentinel bug class, spending an ABSENT
     * identity as a real one.
     *
     * A cid-less row therefore falls straight through to (d) and this function
     * deletes ONLY the `User` document for it — which is why such a row is
     * refused outright at the top of this function and by
     * computeDeleteRefusals' ABSENT_CANONICAL_ID. It is NOT true that a non-NUS
     * account has no dependents; it has no CANONICAL-keyed ones, and the
     * pre-cutover legacy key it may own rows under is not derivable here.
     */
    if (cid !== null) {
      const where = { userID: cid };

      // 1. CcaHead — the scope rows. First, with UserRole, so a crash cannot
      //    leave a head row pointing at a deleted user.
      deleted.ccaHead = (await tx.ccaHead.deleteMany({ where })).count;

      // 2. UserRole — THE escalation-critical row. An orphan here is inherited
      //    by whoever next signs in on this NUS address.
      deleted.userRole = (await tx.userRole.deleteMany({ where })).count;

      // 3. PendingRoleGrant — a bearer credential for this exact address. Left
      //    behind, it is redeemed by whoever next controls it.
      deleted.pendingRoleGrant = (
        await tx.pendingRoleGrant.deleteMany({ where })
      ).count;

      /* ---- privilege boundary. Everything below is DATA, not authority. ---- */

      deleted.userMatric = (await tx.userMatric.deleteMany({ where })).count;
      deleted.profileCompletion = (
        await tx.profileCompletion.deleteMany({ where })
      ).count;
      deleted.eventSignup = (await tx.eventSignup.deleteMany({ where })).count;

      // CcaInterviewNote BEFORE CcaApplication. ORDER MATTERS: a note is
      // reachable only through `applicationID`, so deleting the applications
      // first orphans every note attached to them with no way left to find it.
      //
      // NOT `where: { authorUserID: cid }` — a note AUTHORED by this user is a
      // record ABOUT SOMEONE ELSE's interview and belongs to that CCA. Deleting
      // by author destroys another CCA's interview record.
      const apps = await tx.ccaApplication.findMany({
        where,
        select: { applicationID: true },
      });
      const applicationIDs = apps.map((a) => a.applicationID);
      deleted.ccaInterviewNote = applicationIDs.length
        ? (
            await tx.ccaInterviewNote.deleteMany({
              where: { applicationID: { in: applicationIDs } },
            })
          ).count
        : 0;
      deleted.ccaApplication = (
        await tx.ccaApplication.deleteMany({ where })
      ).count;

      deleted.userCCA = (await tx.userCCA.deleteMany({ where })).count;

      /* ---- Bookings: NOT a blanket deleteMany ----------------------------
       * Their PERSONAL reservations go. The ones an Event or a live
       * CcaInterviewSlot is standing on do NOT — see
       * findInstitutionalBookings for why deleting those silently frees a room
       * that a published event still claims.
       *
       * ORDER MATTERS: this runs AFTER step 1 removed their CcaHead rows, so the
       * successor lookup below can only return a head who actually survives. A
       * reservation with no surviving head of its CCA is KEPT anyway, still
       * keyed on the departed id: an inert row that holds a room is strictly
       * better than a live event whose room is quietly available again.
       */
      const ownBookings = await tx.bookings.findMany({
        where,
        select: { bookingID: true, ccaID: true },
      });
      const held = await findInstitutionalBookings(
        tx,
        ownBookings.map((b) => b.bookingID),
      );
      /* ONE successor lookup for the whole loop, not one per booking. This ran
       * inside the loop and made the transaction's round-trip count scale with
       * the number of rooms a departing head had reserved — a head with a batch
       * of interview slots plus a few events added two round trips each, which
       * is how this body reached the interactive-transaction timeout on the
       * heaviest (and most likely) accounts. The lookup is per CCA, and the
       * number of CCAs one person heads is single digits, so a findMany over the
       * affected ccaIDs answers every iteration in one query.
       *
       * ORDER STILL MATTERS: this reads AFTER step 1 removed their CcaHead rows,
       * so a returned head is one who actually survives. `userID: { not: cid }`
       * is kept as belt-and-braces for the same reason it was there before.
       */
      const heldCcaIDs = [
        ...new Set(
          ownBookings.filter((b) => held.has(b.bookingID)).map((b) => b.ccaID),
        ),
      ];
      const successors = new Map<number, string>();
      if (heldCcaIDs.length > 0) {
        const rows = await tx.ccaHead.findMany({
          where: { ccaID: { in: heldCcaIDs }, userID: { not: cid } },
          select: { ccaID: true, userID: true },
        });
        // First writer wins, matching the previous `findFirst`: any surviving
        // head is an equally valid custodian of the reservation.
        for (const r of rows) {
          if (!successors.has(r.ccaID)) successors.set(r.ccaID, r.userID);
        }
      }
      for (const b of ownBookings) {
        if (!held.has(b.bookingID)) continue;
        const successor = successors.get(b.ccaID);
        // A reservation with no surviving head of its CCA is KEPT anyway, still
        // keyed on the departed id: an inert row that holds a room is strictly
        // better than a live event whose room is quietly available again.
        if (!successor) continue;
        await tx.bookings.update({
          where: { bookingID: b.bookingID },
          data: { userID: successor },
        });
      }
      retainedBookings = held.size;
      // `notIn: []` is a legal no-op filter, but spelling the empty case out
      // keeps the common path a plain indexed deleteMany.
      deleted.bookings = (
        await tx.bookings.deleteMany({
          where:
            held.size === 0
              ? where
              : { userID: cid, bookingID: { notIn: [...held] } },
        })
      ).count;

      deleted.posts = (await tx.posts.deleteMany({ where })).count;
      // NO `tx.order.deleteMany` HERE. The supper domain is left whole, on
      // purpose and as a unit — see the residue block below for the argument.
      deleted.gym = (await tx.gym.deleteMany({ where })).count;
    }

    /* ---- (d) the User row, LAST and BY ObjectId ---------------------------
     * By _id, never `deleteMany({ where: { userID } })`: that column is not
     * unique and is wrong on ~515 rows, so a deleteMany can match TWO people.
     * `delete` by _id also lets Prisma's native `onDelete: Cascade` take
     * Session / Account / Authenticator with it, which a deleteMany on a
     * non-unique scalar does not reliably express.
     *
     * The explicit `select` is the same #9 / I-2 control loadAdminUserTarget
     * carries: a bare delete deserialises the whole row, including passwordHash,
     * and throws on a Google-adapter row that lacks it.
     */
    await tx.user.delete({
      where: { id: target.userObjectId },
      select: { id: true },
    });
    deleted.user = 1;
  }, CASCADE_TX_OPTIONS);

  return { deleted, retainedBookings };
}

/* --------------------------------------------------------------------------
 * DELIBERATELY NOT DELETED, and why. Each of these mentions the departing user
 * somewhere; none of them is theirs to take. A blanket "delete every row
 * mentioning this userID" reads tidy and quietly destroys other people's data.
 *
 *   RoleAuditLog          Append-only by code contract (schema.prisma:
 *                         "There is no update or delete path in any router, and
 *                         none may be added"). The delete's OWN audit row must
 *                         outlive its subject — it is the only surviving record
 *                         of what privilege was destroyed.
 *   BookingLogs           A log. Same class as the above.
 *   Event.createdBy       An event belongs to the CCA, not to the head who filed
 *                         it. Deleting a departing head's account must not erase
 *                         the CCA's published events.
 *   CcaInterviewSlot      .createdBy is provenance; other applicants hold seats
 *                         on that slot.
 *   Bookings              ...the ones those two records STAND ON. Keeping the
 *                         Event and dropping its auto-booked room would leave a
 *                         published event whose facility is silently free —
 *                         findFacilityConflict sees nothing, another CCA books
 *                         over it, and `autoBookFailed` stays false so the CCA's
 *                         own UI still says the room is held. The coupling is
 *                         Event.bookingID / CcaInterviewSlot.bookingID; see
 *                         findInstitutionalBookings. Their PERSONAL bookings do
 *                         go.
 *   CcaProfile.updatedBy  A provenance string, not a reference.
 *   CcaInterviewNote      ...where authorUserID is this user: see the note in
 *                         the cascade. Their notes about OTHER applicants belong
 *                         to those applications.
 *   Order, SupperGroup,   THE WHOLE SUPPER DOMAIN, and it is left whole ON
 *   FoodOrder             PURPOSE. `Order` used to be deleted here while
 *                         SupperGroup and FoodOrder were listed as residue, and
 *                         that pairing was incoherent in both of its possible
 *                         outcomes. If `Order.userID` really is the canonical
 *                         key, the deleteMany removed a member's order from a
 *                         still-open group whose DENORMALIZED aggregates —
 *                         numOrders, userIdList, totalPrice, currentFoodCost —
 *                         still counted it, and orphaned the FoodOrder documents
 *                         that order's `foodIds` was the only pointer to (nothing
 *                         else references them: deleteSupperGroupCascade deletes
 *                         Orders by supperGroupId and never reads foodIds, so
 *                         they are unreachable forever). If it is NOT the
 *                         canonical key — which is exactly what "UNRESOLVED" in
 *                         the old comment meant — the deleteMany matched nothing
 *                         and the blast-radius panel reported "0 supper orders"
 *                         for an account that has some. The operator could not
 *                         tell those two apart from the panel.
 *
 *                         So the domain goes or stays as a UNIT, and it stays:
 *                         no router in this app touches SupperGroup or Order
 *                         (grep — cascade.ts is the only other reference), the
 *                         key format is still unresolved (rbac-doctor --nonnus
 *                         reports which format those collections actually use),
 *                         and repairing a group's aggregates means recomputing
 *                         `totalPrice` / `currentFoodCost`, which are Json
 *                         columns holding a mix of Float and Int in production.
 *                         `order` is out of FOOTPRINT_COLLECTIONS to match, so
 *                         the panel no longer promises it. Raise it with the
 *                         owner rather than guessing at the key.
 *
 * None of these is a privilege row, so none is an escalation vector. That is the
 * line being drawn: authority dies with the account; other people's records do
 * not.
 * -------------------------------------------------------------------------- */
