import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { env } from "~/env";
import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
  roleManagerProcedure,
  scrcProcedure,
} from "../trpc";
import { assertScrcEnabled } from "../services/scrcFlag";
import {
  allowlistPinExists,
  pinnedUserIDsFor,
  resetAuthAllowlistCache,
} from "../services/authAllowlist";
import { isExtUserID, normalizeEmail } from "~/lib/identity";
import {
  evaluateBooking,
  getEnforcementMode,
  getFacilityRequiredRoles,
  getUserRoles,
} from "../services/access";
import {
  ADMIN_ROLE,
  BASELINE_ROLE,
  CCA_HEAD_ROLE,
  FACILITY_ROLES,
  GRANTABLE_ROLES,
  JCRC_ROLE,
  SCRC_ROLE,
  assignableBy,
  asStoredCanonicalUserID,
  canonicalFromNusnetID,
  canonicalUserID,
  type CanonicalUserID,
  computeCapabilities,
  forbiddenRoleCombination,
  isGrantableRole,
  isEFormatUserID,
  isNusStudentEmail,
  legacyMirror,
  revocableFromOthersBy,
  userIDSchema,
  ccaHeadTargetSchema,
  extUserIDSchema,
  roleTargetUserIDSchema,
  type Capabilities,
  type GrantableRole,
} from "../services/roles";
import { MATRIC_RE } from "~/lib/schemas/profile";

/**
 * The admin / role-management router (02-backend-authz.md §§6-8).
 *
 * WHAT LIVES HERE AND WHY IT IS ONE FILE. The plan's file map splits this
 * across `roleService.ts` (guards + audit), `capabilities.ts`
 * (`requireCapability`) and `admin.ts` (procedures). They are consolidated here
 * by explicit instruction, following the same consolidation the core RBAC agent
 * applied to roles.ts/access.ts. The split was never load-bearing in this
 * direction: every caller of the guards is a procedure in this file, and
 * `requireCapability` could not live in roles.ts anyway because it needs
 * TRPCError and roles.ts is deliberately runtime-pure so client components can
 * import the vocabulary (roles.ts header). If a second router ever needs the
 * chokepoint, lift sections A/B into `services/roleService.ts` verbatim — they
 * take a `PrismaClient` and know nothing about tRPC context.
 *
 * THE ONE RULE FOR ANYONE EDITING THIS FILE: there is exactly ONE write to
 * `UserRole.roles` on the generic role path (`applyRoleChange`) and exactly one
 * on the CCA path (`writeCcaHeadString`). Both construct the written set so
 * that `resident` cannot be absent from it (I-8c). Adding a third writer, or
 * writing a client-supplied array, silently strips the booking baseline from
 * whoever it touches.
 */

/* ========================================================================== */
/* SECTION A — schemas, capability assertion, plan tokens                     */
/* ========================================================================== */

/**
 * Roles are keyed on the canonical E-format id. Re-enforced in guard G7.
 *
 * Defined in `../services/roles` so the audit-log filter UI can parse with the
 * SAME predicate instead of a hand-rolled `/^E\d{7}$/` that rejects what this
 * accepts and then silently drops the filter (I-12, 09 §2.6). Behaviour here is
 * unchanged at all 11 input sites.
 */

/**
 * z.enum, never z.string() — unknown strings die at the boundary.
 *
 * `resident` is absent because it is absent from GRANTABLE_ROLES (I-8e), so a
 * payload cannot express it in EITHER direction: not to grant it, and — because
 * `removed` is computed from a grantable-only `before` — not to remove it.
 * `cca_head` IS expressible here and is then rejected by the delta guard,
 * because ASSIGNABLE_BY / REVOCABLE_FROM_OTHERS_BY contain it for nobody
 * (I-14). It travels only the dedicated CCA endpoints below.
 */
const roleSchema = z.enum(GRANTABLE_ROLES);

/**
 * `extUserIDSchema` / `roleTargetUserIDSchema` are DEFINED IN
 * ../services/roles.ts, beside `userIDSchema`, and imported here — not declared
 * locally. That module is runtime-pure and client-importable; this one pulls in
 * `node:crypto` and `~/env`, so a `"use client"` component that needed the
 * schema (AuditLogTable's filter parse) could not import it from here without
 * dragging both into the browser bundle.
 *
 * THE ENUMERATION OF WHERE roleTargetUserIDSchema IS APPLIED IS THE CONTAINMENT,
 * so it is written out rather than left implicit. Three sites in this file:
 *
 *   setUserRoles   — the ONLY way to grant `scrc` to an allowlist-pinned
 *                    hall-office account.
 *   explainAccess  — read-only, audited; the only tool for triaging "why can't
 *                    the hall office book room N".
 *   listAuditLog   — read-only, adminProcedure; the surface whose whole job is
 *                    oversight of this role.
 *
 * Every OTHER target site in this file stays on the bare `userIDSchema`:
 *
 *   resolveIdentifier (bulk import + pending grants) — so a pasted `EXT:…` in a
 *       1000-row CSV comes back UNRESOLVED. THIS IS THE CONTAINMENT ON M4: the
 *       EXT namespace is unreachable from a spreadsheet.
 *   createPendingGrants / revokePendingGrant — a pending grant is redeemed at
 *       FIRST LOGIN against a canonical id; a deferred grant to a pinned
 *       identity would be a second, unaudited provisioning path.
 *   grantCcaHead / revokeCcaHead / transferCcaHead — the hall office must not
 *       become a CCA head.
 *   setJcrcRole / listJcrcRoster / resolveJcrcCandidate — all three target
 *       RESIDENTS. EXCLUSIVE_ROLE_PAIRS makes an `scrc` target impossible
 *       anyway (G8 denies jcrc+scrc), so widening them would only let the hall
 *       office aim its one power at the EXT namespace for no purpose.
 */

/**
 * Facilities require a DIFFERENT vocabulary than users are granted: `resident`
 * is requirable but not grantable, and `admin` is grantable but must never be
 * stored as a requirement (it is an implicit bypass; storing it invites someone
 * to delete it and lock every admin out of a room). min(1) removes the ambiguous
 * empty state from the write path, since [] and missing-row are now the same
 * state (I-10).
 */
const facilityRoleSchema = z.enum(FACILITY_ROLES);

/**
 * Prisma's Mongo `contains` compiles to $regex. Unescaped operator input is a
 * catastrophic-backtracking vector, and role managers are students.
 */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The shape `resolveJcrcCandidate` returns.
 *
 * DELIBERATELY NOT `HeadCandidateResult`, which it originally mirrored. That
 * union distinguishes NOT_FOUND from NOT_SIGNED_IN, and this procedure ALSO had
 * to refuse a target holding `admin`. Three negative outcomes plus a positive
 * one turned the admin refusal into an ORACLE: a non-existent address answered
 * NOT_SIGNED_IN or NOT_FOUND, an ordinary account answered FOUND, and only an
 * ADMIN answered NOT_FOUND-after-resolving — so the branch written to hide
 * admins was the one thing that uniquely marked them, and a loop over the hall's
 * addresses enumerated the admin list exactly.
 *
 * So there are now TWO outcomes, not four. NOT_AVAILABLE is returned, byte for
 * byte, for every negative: the identifier did not resolve, it resolved to
 * somebody who has never signed in, it resolved to an admin, or it resolved to
 * another HALL-OFFICE account. No status, no message, no field, and no shape
 * difference separates them. It carries NO userID — echoing the resolved id back
 * would have re-opened the same oracle one field lower down.
 *
 * The `scrc` case joined that list late, and only because of COMPOSITION: alone,
 * reporting a hall-office account as FOUND leaked nothing this role could not
 * already see, but paired with setJcrcRole's opaque refusal it eliminated every
 * other cause and identified them exactly. See the screen in the procedure.
 *
 * AMBIGUOUS survives as its own status, and that is a considered exception. It
 * is decided ENTIRELY by `userMatric.findMany().length > 1`, before any role or
 * account lookup happens at all, so it cannot separate an admin from anyone
 * else — an admin with a unique matric answers NOT_AVAILABLE like every other
 * refusal, and a resident with a duplicated one answers AMBIGUOUS. The only bit
 * it discloses is "the matric YOU just typed is claimed by more than one
 * account", which the identical branch in cca.resolveHeadCandidate already
 * discloses to every CCA head, and which the operator needs in order to know to
 * try a NUSNET id instead.
 *
 * `holdsJcrc` on the FOUND branch lets the UI offer Revoke instead of Grant.
 */
export type JcrcCandidateResult =
  | {
      status: "FOUND";
      userID: string;
      displayName: string | null;
      email: string | null;
      holdsJcrc: boolean;
    }
  /** A matric matched more than one account. Decided before any role lookup. */
  | { status: "AMBIGUOUS" }
  /**
   * No usable grant target. Covers "no such identifier", "never signed in" and
   * "holds admin", indistinguishably and on purpose. Do NOT add a field, a
   * reason code or a sub-status to this branch — the whole point is that the
   * caller cannot tell which of the three it got.
   */
  | { status: "NOT_AVAILABLE" };

/**
 * Guard messages that describe THE TARGET rather than the CALLER, and which
 * `admin.setJcrcRole` therefore flattens to `SCRC_TARGET_UNAVAILABLE` before
 * they reach a hall-office client.
 *
 * WHY A LIST AND NOT A BLANKET CATCH. `sanitizeErrors` in trpc.ts rewrites
 * INTERNAL_SERVER_ERROR only; every FORBIDDEN message is passed through to the
 * client verbatim, by design, because for admin and jcrc the specific reason IS
 * the product. That is right for them and wrong for `scrc`, whose reachable
 * target set is the whole hall: a message that varies with a property of the
 * target turns one repeatable call into an enumeration of that property.
 *
 * Each entry, and what it would otherwise disclose:
 *   CANNOT_MODIFY_AN_ADMIN     — G3. "this account holds admin". The one that
 *                                reopened the oracle resolveJcrcCandidate had
 *                                just been rewritten to close.
 *   CANNOT_HOLD_JCRC_AND_SCRC  — G8. "this account holds scrc", i.e. an
 *                                enumeration of the hall office itself.
 *   NOT_A_CANONICAL_USERID     — G7. Unreachable from setJcrcRole (userIDSchema
 *                                already enforces E-format at the boundary),
 *                                listed so it stays closed if that ever changes.
 *   CANNOT_REMOVE_LAST_ADMIN   — applyRoleChange. Unreachable here for the same
 *                                structural reason (this mutation only ever
 *                                adds or removes `jcrc`), listed for the same
 *                                defensive reason.
 *   USE_CCA_HEAD_ENDPOINT      — G4, when `cca_head` lands in the delta. "this
 *                                account heads a CCA". Race-only from
 *                                setJcrcRole: the requested set is built from a
 *                                pre-check read, so `cca_head` can only enter
 *                                the delta if the target gains or loses a
 *                                headship between that read and the guard's.
 *   CANNOT_REVOKE_SCRC_FROM_OTHERS
 *                              — G4 removals. `revocableFromOthersBy(["scrc"])`
 *                                is exactly {jcrc}, so this fires if `scrc` ever
 *                                appears in the removal set — again only via the
 *                                same race, and again it would answer "this
 *                                account holds scrc".
 *
 * The last two are the races this allowlist is FOR: it exists precisely because
 * the pre-checks in setJcrcRole read the target in an earlier statement than the
 * guards do, and a list that covered only the messages the pre-checks already
 * pre-empt would be documentation rather than a backstop.
 *
 * DELIBERATELY ABSENT: CANNOT_GRANT_JCRC, CANNOT_REVOKE_JCRC_FROM_OTHERS,
 * NOT_A_ROLE_MANAGER, CANNOT_SELF_ASSIGN, CAPABILITY_REQUIRED:*, SCRC_DISABLED
 * and CONFLICT_ROLES_CHANGED. Every one of those is identical for every target
 * — they describe the ACTOR or a race — so they leak nothing and are worth far
 * more to the operator stated plainly.
 *
 * If a future guard's message depends on the target, add it here.
 */
const TARGET_DISCRIMINATING = new Set<string>([
  "CANNOT_MODIFY_AN_ADMIN",
  "CANNOT_HOLD_JCRC_AND_SCRC",
  "NOT_A_CANONICAL_USERID",
  "CANNOT_REMOVE_LAST_ADMIN",
  "USE_CCA_HEAD_ENDPOINT",
  "CANNOT_REVOKE_SCRC_FROM_OTHERS",
]);

const listInput = z.object({
  search: z.string().trim().max(100).optional(),
  role: roleSchema.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

/**
 * Server-side capability assertion. Use in EVERY procedure whose gate is a
 * capability rather than a bare role — the procedure middleware only answers
 * "may they reach the surface", this answers "may they do this thing".
 */
function requireCapability<K extends keyof Capabilities>(
  caps: Capabilities,
  key: K,
): void {
  const v = caps[key];
  if (v === false || (Array.isArray(v) && v.length === 0)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `CAPABILITY_REQUIRED:${String(key)}`,
    });
  }
}

const caps = (roles: readonly string[] | undefined) =>
  computeCapabilities(roles ?? []);

/* -- bulk plan tokens ------------------------------------------------------ */

/** Preview→commit binding lifetime. Long enough for a 1000-row wizard. */
const PLAN_TTL_MS = 30 * 60 * 1000;

/**
 * The low-confidence / resolution gate must be SERVER-enforced: a `confirmed:
 * true` boolean from the client is not evidence, and `expectedBefore` is not a
 * secret (it is just the target's current roles, obtainable from listUsers).
 * So every previewed row is signed, and commitBulkChunk will not act on a tuple
 * it did not itself produce.
 *
 * Signed PER ROW rather than as one blob over the whole plan: the client commits
 * in 25-row chunks and must be able to resume a truncated chunk, so the server
 * has to verify a subset without holding per-batch state between requests.
 */
function planSecret(): string {
  const s = env.NEXTAUTH_SECRET;
  if (!s) {
    // Fail closed. Without a secret the token is unforgeable-by-nobody, which
    // is worse than an outage of the bulk surface.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "PLAN_TOKEN_SECRET_MISSING",
    });
  }
  return s;
}

type SignedRow = {
  batchId: string;
  actorUserID: string;
  expiresAt: number;
  /**
   * THE IMPORT MODE IS PART OF THE SIGNATURE, and it is not optional.
   *
   * The token exists so that the signed tuple DETERMINES what the server will
   * do. Without `mode` it did not: `beginBulkImport` takes a client-supplied
   * mode and a client-supplied batchId with no check that either matches the
   * preview, and `commitBulkChunk` derives `requested` from `header.mode`. So a
   * plan previewed as additive (`add`, roles ["jcrc"], expectedBefore matching)
   * could be committed as `set` — every rowToken still verifies, the drift
   * check still passes because expectedBefore is unchanged, and `removed`
   * becomes `before \ ["jcrc"]`: an additive plan the operator reviewed
   * silently executes as a mass demotion.
   *
   * Signing the mode makes a mode swap fail closed. commitBulkChunk recomputes
   * with the mode it is ABOUT TO APPLY, so if the header disagrees with the
   * preview every row returns PLAN_TOKEN_INVALID and nothing is written.
   */
  mode: string;
  userID: string;
  roles: string[];
  expectedBefore: string[];
  via: string;
  confidence: string;
};

/**
 * DOMAIN SEPARATION, AND IT COMES FIRST IN THE PAYLOAD — the same rule
 * `services/eventQr.ts` states for its own tokens, applied to the second signer
 * in the codebase.
 *
 * IT MATTERS MORE HERE THAN THERE, because this signer does NOT have a key of
 * its own: `planSecret()` returns NEXTAUTH_SECRET, which is also the key
 * next-auth uses to sign every session JWT. Two different message formats under
 * one key is the precondition for a cross-protocol forgery — the day a third
 * thing is signed with this secret, an unprefixed payload from one signer that
 * can be made to look like a payload from another verifies against both. The
 * prefix makes an `admin-bulk-role-import` message unrepresentable as any other
 * kind, so the collision cannot be constructed even if the field layouts
 * otherwise line up.
 *
 * ADDING THIS INVALIDATES OUTSTANDING PREVIEW TOKENS — every rowToken minted
 * before this deploy stops verifying, and an operator mid-import sees
 * PLAN_TOKEN_INVALID and has to re-run the preview. That is acceptable and
 * self-correcting: the tokens already carry a short `expiresAt`, the failure is
 * loud rather than silent, and it fails CLOSED (nothing is written).
 *
 * SEPARATE KEYS WOULD BE BETTER STILL. If a dedicated BULK_IMPORT_SECRET is ever
 * added to env.js, this prefix stays anyway — belt and braces cost one string.
 */
const SIGN_PURPOSE = "admin-bulk-role-import";

function signRow(r: SignedRow): string {
  const payload = [
    SIGN_PURPOSE,
    r.batchId,
    r.actorUserID,
    String(r.expiresAt),
    r.mode,
    r.userID,
    [...r.roles].sort().join("+"),
    [...r.expectedBefore].sort().join("+"),
    r.via,
    r.confidence,
  ].join("|");
  return createHmac("sha256", planSecret()).update(payload).digest("hex");
}

/** Constant-time compare — a length-leaking `===` on an HMAC is a bad habit. */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* -- identifier resolution ------------------------------------------------- */

/**
 * RESOLVE A CCA-HEAD GRANT TARGET TO THE KEY A SESSION WILL ACTUALLY PRODUCE.
 *
 * Takes whatever an admin typed — a canonical id, an E-number, or a matric that
 * happens to sit in `User.userID` — finds the person, and returns
 * `canonicalUserID(their email)`. THAT is the value written to `CcaHead`,
 * because it is the value `session.user.userID` equals at runtime.
 *
 * WHY RESOLUTION RATHER THAN A WIDER REGEX. The old rule was `/^E\d{7}$/`,
 * which locked out 420 of 1624 real accounts (L-27). Simply widening the shape
 * would have swapped one bug for a worse one: `A0345036J` would then pass, a
 * `CcaHead` row would be written under a MATRIC, and that key never equals the
 * holder's session id — so they would hold a headship the app cannot see, with
 * nothing erroring. `prisma/schema.prisma` states the rule being protected:
 * "NEVER key on User.userID: ~515 users have an A-format matric there."
 *
 * So this is STRICTER than the rule it replaces, not looser. E-format proved
 * only that a string looked like an id; this proves an account exists and
 * returns the one key that will match it.
 *
 * G7 IS PRESERVED, and stated directly instead of by proxy. An `EXT:` pin has
 * no `@u.nus.edu` address, so `canonicalUserID` returns null and the grant is
 * refused — which is what G7 always meant: "the hall office must not become a
 * CCA head".
 */
async function resolveCcaHeadTarget(
  db: PrismaClient,
  raw: string,
): Promise<string> {
  const key = raw.trim().toUpperCase();

  // Both halves of how a person can be addressed: the canonical id implied by
  // their email, and whatever happens to sit in the `userID` column. Never a
  // bare read — passwordHash must not be selected (I-2).
  const user = await db.user.findFirst({
    where: {
      OR: [
        { email: { equals: `${key.toLowerCase()}@u.nus.edu`, mode: "insensitive" } },
        { userID: key },
      ],
    },
    select: { email: true, userID: true, displayName: true },
  });

  if (!user) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "NO_SUCH_ACCOUNT",
    });
  }

  const canonical = canonicalUserID(user.email);
  if (!canonical) {
    // A non-NUS address: an EXT allowlist principal, or a Google account that
    // never had one. Either way there is no canonical student id to key a
    // headship on, and G7 says the hall office is not eligible regardless.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "NOT_A_NUS_ACCOUNT",
    });
  }
  return canonical;
}


/**
 * Tier-ordered resolution, restricted to the two HIGH-CONFIDENCE tiers.
 *
 * The plan's full resolver (§8, `services/identityResolver.ts`) adds matric and
 * display-name tiers. They are deliberately NOT implemented here: matric is
 * self-asserted (user.setMatric upserts whatever the logged-in user types), so a
 * matric-resolved grant is claimable by anyone who types that matric, and
 * `User.displayName` is nullable and non-unique. Both need the ambiguity
 * buckets and the confirmation UI that doc 03 owns. Until then this resolver
 * returns UNRESOLVED for them, which is a refusal, not a silent guess.
 */
function resolveIdentifier(
  raw: string,
): { userID: string; via: "email" | "nusnet" } | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes("@")) {
    const id = canonicalUserID(s);
    return id ? { userID: id, via: "email" } : null;
  }
  const upper = s.toUpperCase();
  return isEFormatUserID(upper) ? { userID: upper, via: "nusnet" } : null;
}

/**
 * THE SAME RESOLUTION, EXTENDED TO NUSNET IDS THAT ARE NOT E-FORMAT — and
 * extended ONLY AS FAR AS A LIVE ACCOUNT REACHES.
 *
 * `resolveIdentifier` above is a pure shape test, and `/^E\d{7}$/` was standing
 * in for "is a NUSNET id" while describing only 1204 of 1624 of them. Pasting a
 * CCA's heads therefore refused a quarter of the hall (25.9%, measured
 * 2026-08-28) with UNRESOLVED_IDENTIFIER — the same L-27 lockout e57abcc fixed
 * in `grantCcaHead`, still standing in the surface that feeds it.
 *
 * WHY THIS ONE TIER NEEDS A DATABASE READ AND THE OTHER TWO DO NOT. Both
 * existing tiers are self-proving shapes: an address is an address, and
 * `E1234567` cannot be typed by accident. `MARCUS-CHUA` cannot be told apart
 * from a stray spreadsheet cell by looking at it — `canonicalFromNusnetID`
 * converts any single word, `ASDF` included. Resolving a word to a grant target
 * on shape alone is precisely the silent wrong-key grant that resolveCcaHeadTarget
 * exists to prevent, one surface upstream and 1000 rows at a time. So the
 * widened tier resolves ONLY when a `User` row answers to the derived key, and
 * an unmatched word still lands on UNRESOLVED_IDENTIFIER exactly as today.
 *
 * That makes the new tier STRICTLY STRONGER than the E-format one beside it,
 * which asserts nothing about whether anybody is there. It is not made to match:
 * tightening E-format would move rows that import cleanly today into refusals,
 * which is a different change with a different blast radius.
 *
 * ONE QUERY, SKIPPED ENTIRELY WHEN NOTHING NEEDS IT — the rows that already
 * resolve never reach it, and its ids are a subset of the ones the caller is
 * about to fetch anyway.
 *
 * NOT USED BY createPendingGrants, deliberately. A pending grant is for somebody
 * who does NOT have an account yet — it refuses a target that does, with
 * USER_EXISTS_GRANT_DIRECTLY — so there is nothing for this gate to check
 * against, and widening it there would let a stray cell queue a grant redeemable
 * at a stranger's first login. That path keeps the bare shape test.
 */
async function bulkResolver(
  db: PrismaClient,
  rows: readonly { identifier: string }[],
): Promise<
  (raw: string) => { userID: string; via: "email" | "nusnet" } | null
> {
  const provisional = new Map<string, string>();
  for (const r of rows) {
    if (resolveIdentifier(r.identifier)) continue; // already a high-confidence tier
    const cid = canonicalFromNusnetID(r.identifier);
    if (cid) provisional.set(r.identifier, cid);
  }

  let backed = new Set<string>();
  if (provisional.size > 0) {
    const ids = [...new Set(provisional.values())];
    const users = await db.user.findMany({
      where: {
        email: {
          in: ids.map((i) => `${i.toLowerCase()}@u.nus.edu`),
          mode: "insensitive",
        },
      },
      // Never a bare read: passwordHash must not be selected (I-2).
      select: { email: true },
    });
    // Keyed on the canonical id of the row that came BACK, not on the id that
    // was searched for: the guessed address is a `contains`-free equality, but
    // the key that gets spent must still be derived from a real stored address.
    // C9: absent ids are dropped rather than landing under a sentinel key.
    backed = new Set(
      users.flatMap((u) => {
        const cid = canonicalUserID(u.email);
        return cid === null ? [] : [cid as string];
      }),
    );
  }

  return (raw: string) => {
    const hit = resolveIdentifier(raw);
    if (hit) return hit;
    const cid = provisional.get(raw);
    return cid && backed.has(cid)
      ? { userID: cid, via: "nusnet" as const }
      : null;
  };
}

/* ========================================================================== */
/* SECTION B — audit, the escalation guards, and the write chokepoint         */
/* ========================================================================== */

export type AuditEntry = {
  actorUserID: string;
  actorRoles?: string[];
  targetUserID?: string;
  targetFacilityID?: number;
  targetCcaID?: number;
  targetEventID?: number;
  action: string;
  rolesBefore?: string[];
  rolesAfter?: string[];
  reason?: string;
  ok?: boolean;
  denyReason?: string;
  batchId?: string;
};

/**
 * Audit writer.
 *
 * CRITICAL (I-15): takes a PrismaClient, NEVER a transaction client. A denial
 * audit written inside the transaction it is denying is rolled back by the
 * throw, leaving no trace of exactly the event that most needs one — which
 * defeats abuse detection on the surface most likely to be probed. Every guard
 * below audits on `db`, outside any tx.
 *
 * An audit failure never rolls back an authorization decision, but a failure on
 * a DENIED row is the highest-signal security event this system produces, so it
 * is logged structurally rather than swallowed.
 */
export async function writeAudit(
  db: PrismaClient,
  e: AuditEntry,
): Promise<void> {
  try {
    await db.roleAuditLog.create({
      data: {
        actorUserID: e.actorUserID,
        actorRoles: e.actorRoles ?? [],
        targetUserID: e.targetUserID ?? null,
        targetFacilityID: e.targetFacilityID ?? null,
        targetCcaID: e.targetCcaID ?? null,
        targetEventID: e.targetEventID ?? null,
        action: e.action,
        rolesBefore: e.rolesBefore ?? [],
        rolesAfter: e.rolesAfter ?? [],
        reason: e.reason ?? null,
        ok: e.ok ?? true,
        denyReason: e.denyReason ?? null,
        batchId: e.batchId ?? null,
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "audit_write_failed",
        action: e.action,
        ok: e.ok ?? true,
        actorUserID: e.actorUserID,
        targetUserID: e.targetUserID,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Thrown by the guards when `dryRun` is set, so a preview can report the same
 * denial reason the real call would produce WITHOUT writing an audit row
 * (I-15's inverse case: a 500-row preview must not emit 500 denial rows for a
 * hypothetical). Caught by previewBulkImport; never escapes to a client.
 */
export class DryRunDenied extends Error {
  constructor(public readonly denyReason: string) {
    super(denyReason);
    this.name = "DryRunDenied";
  }
}

const forbid = (msg: string): never => {
  throw new TRPCError({ code: "FORBIDDEN", message: msg });
};

/**
 * THE privilege-escalation firewall. Computes the resulting role set for a
 * `set`-style request and validates it, or throws and audits the denial.
 *
 *  G1 CALLER      caller must hold admin, jcrc or scrc. Also enforced by the
 *                 procedure middleware — belt and braces, because this function
 *                 is the thing every future surface will call.
 *                 `scrc` (hall office) was added when it gained
 *                 ASSIGNABLE_BY.scrc = ["jcrc"]: G1 is a REACHABILITY gate, and
 *                 leaving it out would have refused the hall office here with
 *                 NOT_A_ROLE_MANAGER before its (narrow, legitimate) delta was
 *                 ever evaluated by G4. What `scrc` may actually do to whom is
 *                 still decided entirely by G3/G4/G5/G6 and the maps — this
 *                 line grants nothing.
 *                 Deliberately NOT rewritten as `assignableBy(actorRoles).size
 *                 === 0`, which would be tidier and WRONG: a jcrc's set is
 *                 empty, so that form would newly deny jcrc HERE with
 *                 NOT_A_ROLE_MANAGER instead of at G4 with CANNOT_GRANT_JCRC,
 *                 silently changing the denyReason on existing audit rows.
 *  G2 VOCABULARY  every requested role must be a known GRANTABLE role. Zod
 *                 rejects most of these first; this survives a router that
 *                 forgets. `resident` fails G2 by design (I-8e).
 *  G3 TARGET      a non-admin may not touch ANY role of a user who holds admin.
 *                 Without this a jcrc calls set(admin_user, ["cca_head"]) —
 *                 every role in the PAYLOAD is inside jcrc's world, so an
 *                 additions-only check passes, and the sole admin is stripped.
 *                 This is escalation-by-demotion and it is the single most
 *                 important line in this file.
 *  G4 DELTA       BOTH added and removed must be permitted. Checking only
 *                 additions is the same hole as G3 from another angle: a
 *                 set-payload that merely OMITS a role is a revocation.
 *  G5 REVOKE      revoking from ANOTHER user uses the narrower
 *                 REVOCABLE_FROM_OTHERS_BY map. Self-revocation (stepping down)
 *                 of a non-admin role is always allowed. Under D-3 a jcrc who
 *                 steps down can be restored only by an ADMIN.
 *  G6 SELF-GRANT  a non-admin may not grant themselves a role they lack.
 *                 Scoped to non-admins deliberately: an admin already outranks
 *                 every role, and blocking them would leave the bootstrap admin
 *                 unable to give themselves jcrc with no in-app path to fix it.
 *  G7 KEY         the target must be an E-format userID (I-1), OR an `EXT:`
 *                 allowlist pin WITH A LIVE AuthAllowlist ROW. Without this the
 *                 dashboard writes rows keyed on an A-format matric that no
 *                 session ever matches: the grant appears to succeed and does
 *                 nothing. It is a REACHABILITY guard, not an authorization one
 *                 — which is why the EXT branch demands a row rather than a
 *                 shape: a pin is admin-typed, so `EXT:TYPO` is a well-formed
 *                 key that no session can produce, i.e. exactly the failure this
 *                 guard exists to prevent. The `||` short-circuits, so an
 *                 E-format target still pays nothing.
 *  G8 EXCLUSION   the RESULTING set must not contain a mutually exclusive pair
 *                 (EXCLUSIVE_ROLE_PAIRS in roles.ts — today, jcrc + scrc). The
 *                 only guard here that constrains the SHAPE of the result
 *                 rather than the actor or the delta, and the only one an
 *                 ADMIN cannot override: an admin may grant either role to
 *                 anyone, and still may not produce that combination in one
 *                 person, because the hole it opens is not about who granted
 *                 it. Read EXCLUSIVE_ROLE_PAIRS for what composes.
 *
 * It re-reads BOTH actor and target roles from the database rather than
 * trusting the session (I-5); this also closes the TOCTOU where the actor is
 * demoted mid-request.
 *
 * The LAST-ADMIN guard is NOT here: it must be transactional, and lives in
 * applyRoleChange.
 */
export async function assertCanMutateRoles(opts: {
  db: PrismaClient;
  actorUserID: string;
  targetUserID: string;
  requestedRoles: string[];
  /** Preview only: evaluate the guards identically, but do not audit. */
  dryRun?: boolean;
}): Promise<{
  actorRoles: string[];
  before: GrantableRole[];
  after: GrantableRole[];
  /** The authorised delta. applyRoleChange asserts on THESE. */
  added: GrantableRole[];
  removed: GrantableRole[];
}> {
  const { db, actorUserID, targetUserID, requestedRoles, dryRun } = opts;

  const [actorAll, targetAll] = await Promise.all([
    getUserRoles(db, actorUserID),
    getUserRoles(db, targetUserID),
  ]);

  // Restrict both sides to GRANTABLE roles. Under the STORED baseline this is
  // no longer tidiness — IT IS THE STICKY MECHANISM (I-8c). `removed` below is
  // `before.filter(...)`, so confining `before` to GRANTABLE_ROLES (which
  // excludes `resident`) means the baseline is not filtered out of the removal
  // set: it is INCAPABLE OF ENTERING IT. Widen this line and every role edit
  // silently strips every touched user's ability to book.
  const actorRoles = actorAll.filter(isGrantableRole);
  const before = targetAll.filter(isGrantableRole);

  const actorIsAdmin = actorRoles.includes(ADMIN_ROLE);
  const isSelf = actorUserID === targetUserID;

  const deny = async (reason: string): Promise<never> => {
    if (dryRun) throw new DryRunDenied(reason);
    // Audited BEFORE throwing, on `db` and outside any transaction (I-15):
    // there is no state change to lose, and a probing attempt is exactly what
    // must leave a trail.
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID,
      action: "denied",
      rolesBefore: before,
      rolesAfter: requestedRoles,
      ok: false,
      denyReason: reason,
    });
    return forbid(reason);
  };

  // G7 KEY. E-format, OR A PROVEN ALLOWLIST PIN.
  //
  // NOT A WIDER REGEX — A PROOF. G7 asks "can any session ever produce this
  // target key" (see its entry in the guard table above): it is a REACHABILITY
  // guard, not an authorization one, and it exists because a grant keyed on
  // something no session matches SUCCEEDS AND DOES NOTHING, silently.
  //
  // An `EXT:` id does correspond to a session — but ONLY if an AuthAllowlist
  // row exists, and the shape alone cannot tell you that: a pin is
  // admin-supplied, so `EXT:NGOCANH_MIA` is a well-formed typo that would write
  // a UserRole row no login ever reaches. So the EXT branch demands a LIVE ROW.
  // That makes this branch strictly STRONGER than the shape test it sits beside,
  // not weaker.
  //
  // COSTS NOTHING FOR EXISTING TRAFFIC: `||` short-circuits, so an E-format
  // target never evaluates the right side and never issues the query. Same
  // denyReason on failure, so no existing audit string moves and every historic
  // NOT_A_CANONICAL_USERID row keeps meaning what it meant.
  const targetKeyed =
    isEFormatUserID(targetUserID) ||
    (isExtUserID(targetUserID) && (await allowlistPinExists(db, targetUserID)));
  if (!targetKeyed) await deny("NOT_A_CANONICAL_USERID"); // G7
  if (
    !actorIsAdmin &&
    !actorRoles.includes(JCRC_ROLE) &&
    !actorRoles.includes(SCRC_ROLE)
  ) {
    await deny("NOT_A_ROLE_MANAGER"); // G1
  }
  for (const r of requestedRoles) {
    if (!isGrantableRole(r)) await deny("UNKNOWN_ROLE"); // G2
  }
  if (!actorIsAdmin && before.includes(ADMIN_ROLE)) {
    await deny("CANNOT_MODIFY_AN_ADMIN"); // G3
  }

  const requested = [...new Set(requestedRoles)] as GrantableRole[];

  // G8 EXCLUSION. Evaluated on the RESULTING SET, not the delta: a payload that
  // merely omits one half of a forbidden pair is still a payload that produces
  // the other half, and a delta check would wave through a set that already
  // contained both. Placed after G2 (so every member is known) and before G4 (so
  // the answer is "that combination is forbidden" rather than a confusing
  // "you may not grant jcrc" aimed at someone who may). See
  // EXCLUSIVE_ROLE_PAIRS — this is the invariant that stops a jcrc+scrc holder
  // reaching setUserRoles and bulkAssign with the scrc grant power attached and
  // the scrc kill switch bypassed.
  const combination = forbiddenRoleCombination(requested);
  if (combination) await deny(combination); // G8

  const added = requested.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !requested.includes(r));

  const canAssign = assignableBy(actorRoles);
  const canRevokeOthers = revocableFromOthersBy(actorRoles);

  for (const r of added) {
    // G4 (additions). cca_head fails here for EVERYONE, admin included: it is
    // in no ASSIGNABLE_BY entry (I-14), so the generic path cannot write it and
    // UserRole/CcaHead cannot drift.
    if (!canAssign.has(r)) {
      await deny(
        r === CCA_HEAD_ROLE
          ? "USE_CCA_HEAD_ENDPOINT"
          : `CANNOT_GRANT_${r.toUpperCase()}`,
      );
    }
    // G6
    if (isSelf && !actorIsAdmin && !actorRoles.includes(r)) {
      await deny("CANNOT_SELF_ASSIGN");
    }
  }
  for (const r of removed) {
    // G4 (removals) + G5
    if (isSelf) {
      if (r === ADMIN_ROLE && !actorIsAdmin) await deny("CANNOT_REVOKE_ADMIN");
      continue;
    }
    if (!canRevokeOthers.has(r)) {
      await deny(
        r === CCA_HEAD_ROLE
          ? "USE_CCA_HEAD_ENDPOINT"
          : `CANNOT_REVOKE_${r.toUpperCase()}_FROM_OTHERS`,
      );
    }
  }

  return { actorRoles, before, after: requested, added, removed };
}

/**
 * The legacy `role` mirror, with the I-9 sentinel applied.
 *
 * `legacyMirror` in roles.ts returns `string | null`, but 02-backend-authz.md §6
 * requires the INSERT branch to write `""` and not null: the still-deployed
 * pre-v2 client declares `UserRole.role` required and throws on absence AND on
 * null, whereas `""` is defined for it and is falsy, so the old
 * `row?.role ?? DEFAULT_ROLE` read degrades safely. The coercion lives here
 * rather than in roles.ts because roles.ts is not this phase's file to edit;
 * flag it if the two are ever reconciled. Applied on BOTH branches so a revoke
 * clears a stale mirror instead of leaving a dropped role behind.
 */
const mirror = (roles: readonly string[]): string => legacyMirror(roles) ?? "";

/**
 * Applies a validated role change with the LAST-ADMIN guard held INSIDE a
 * transaction. Read-then-write outside a transaction is not enough: with two
 * admins, two concurrent self-revocations both observe count === 2, both pass,
 * and the system reaches zero admins — unrecoverable, because there is
 * deliberately no in-app path to mint the first admin.
 *
 * THE STICKY CHOKEPOINT (I-8c). This is the ONE write on the generic
 * role-mutation path. setUserRoles, every bulk-import row (add AND set mode)
 * and every bulk-undo row route through it, which is why "bulk is sticky" needs
 * no separate mechanism. The fourth role-write surface, deferred-grant
 * redemption, does not come through here and is additive-only by construction
 * (it $addToSets and never removes).
 */
export async function applyRoleChange(opts: {
  db: PrismaClient;
  actorUserID: string;
  actorRoles: string[];
  targetUserID: string;
  before: GrantableRole[];
  after: GrantableRole[];
  added: GrantableRole[];
  removed: GrantableRole[];
  reason?: string;
  batchId?: string;
}): Promise<GrantableRole[]> {
  const {
    db,
    actorUserID,
    actorRoles,
    targetUserID,
    before,
    after,
    removed,
    reason,
    batchId,
  } = opts;
  const losingAdmin =
    before.includes(ADMIN_ROLE) && !after.includes(ADMIN_ROLE);

  // I-8c, ASSERTED rather than assumed. `removed` comes from
  // assertCanMutateRoles, where it is `before.filter(...)` over a
  // grantable-only `before` — so this can only fire if someone widens that
  // line or calls this function by hand. Cheap, and it fails loudly instead of
  // stripping 515 baselines.
  if (removed.some((r) => !isGrantableRole(r))) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "NON_GRANTABLE_IN_REMOVAL",
    });
  }

  // G8's backstop at the chokepoint, ASSERTED rather than assumed, exactly like
  // the line above. `after` comes from assertCanMutateRoles, which already
  // refused a forbidden pair — so this can only fire if someone adds a caller
  // that skips the guard, which is precisely the mistake worth failing loudly
  // on. Checking `after` is sufficient and not merely convenient: the written
  // set below is (stored non-grantable) ∪ after, and both halves of every
  // EXCLUSIVE_ROLE_PAIR are grantable, so nothing in the first term can
  // reintroduce a pair. INTERNAL_SERVER_ERROR, not FORBIDDEN — a client cannot
  // cause this, and calling it a permission problem would misdirect whoever
  // reads the log.
  const combination = forbiddenRoleCombination(after);
  if (combination) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `EXCLUSIVE_PAIR_AT_CHOKEPOINT:${combination}`,
    });
  }

  if (losingAdmin && actorUserID === targetUserID) {
    await writeAudit(db, {
      actorUserID,
      actorRoles,
      targetUserID,
      action: "denied",
      rolesBefore: before,
      rolesAfter: after,
      ok: false,
      denyReason: "CANNOT_SELF_REVOKE_ADMIN",
    });
    forbid("CANNOT_SELF_REVOKE_ADMIN");
  }

  try {
    await db.$transaction(async (tx) => {
      if (losingAdmin) {
        const remaining = await tx.userRole.count({
          where: {
            userID: { not: targetUserID },
            // Legacy-tolerant so an admin still on the singular shape is not
            // invisible to the count. Narrowing this to roles-only before doc
            // 06's gate proves no legacy-only row remains would permit removing
            // the real last admin.
            OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }],
          },
        });
        if (remaining < 1) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "CANNOT_REMOVE_LAST_ADMIN",
          });
        }
      }

      // Read the CURRENT full stored set INSIDE the transaction, so the write
      // below is a compare-and-set against a pre-image observed under the same
      // session as the last-admin count.
      const row = await tx.userRole.findUnique({
        where: { userID: targetUserID },
      });
      const current = row?.roles?.length
        ? row.roles
        : row?.role
          ? [row.role]
          : [];

      // OPTIMISTIC CONCURRENCY. `added`/`removed` were computed from a `before`
      // read in assertCanMutateRoles, in an EARLIER statement. With two
      // concurrent edits and no check, actor A setting [admin] and actor B
      // setting [jcrc] interleave to a state neither requested — and worse, a
      // REVOKE can be silently undone by a concurrent grant, i.e. privilege
      // retention after an apparently successful revocation, with an audit row
      // asserting a rolesAfter that never existed. So: if the target's
      // grantable set has moved since the guards read it, refuse.
      const currentGrantable = current.filter(isGrantableRole);
      const moved =
        currentGrantable.length !== before.length ||
        currentGrantable.some((r) => !before.includes(r));
      if (moved) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "CONFLICT_ROLES_CHANGED",
        });
      }

      // STICKY BY CONSTRUCTION. The written set is
      //   (everything stored that is NOT grantable) ∪ (the authorised final set)
      // `resident` is not grantable, so it lands in the first term and is
      // PRESERVED. It is not filtered out of a removal payload; it is incapable
      // of entering one.
      //
      // Note what this deliberately does NOT do: it does not ADD `resident` to
      // a target that lacks it. `targetUserID` is admin/jcrc-supplied input
      // whose NUS provenance was never established (G7 checks E-format SHAPE,
      // not provenance). Minting a baseline here would grant it to principals
      // that may not exist and were never email-verified. Granting is
      // ensureBaseline's job and only ensureBaseline's job (I-8a/I-8d).
      const keptNonGrantable = current.filter((r) => !isGrantableRole(r));
      const written = [...new Set([...keptNonGrantable, ...after])];

      await tx.userRole.upsert({
        where: { userID: targetUserID },
        create: {
          userID: targetUserID,
          roles: written,
          role: mirror(after),
          updatedAt: new Date(),
          updatedBy: actorUserID,
        },
        update: {
          roles: written,
          role: mirror(after),
          updatedAt: new Date(),
          updatedBy: actorUserID,
        },
      });
      // WHY A TYPED upsert AND NOT $runCommandRaw($pull/$addToSet):
      //  1. Prisma's MongoDB connector does NOT run raw commands inside the
      //     interactive transaction's session — a raw write executes OUTSIDE
      //     the transaction and commits independently of rollback. That would
      //     silently un-atomicise the last-admin guard above and re-open
      //     exactly the zero-admins race this transaction exists to prevent.
      //  2. A raw `updates: [$pull, $addToSet]` array is TWO document writes,
      //     not one: entry 1 succeeding and entry 2 failing leaves the target
      //     stripped of the revoked roles with none of the additions applied.
      //  3. $set and $setOnInsert may never name the same path — MongoDB
      //     rejects that with ConflictingUpdateOperators at parse time (I-9).
      //     No $setOnInsert appears here: `mirror()` already writes `role` on
      //     BOTH branches, and returns "" (never null) so the I-9 sentinel
      //     holds on insert.
      // This IS a set-payload, which I-13 forbids in its BLIND form — the
      // compare-and-set above is what makes it legal, and it is strictly
      // stronger than an unguarded delta. Do not remove the pre-image check
      // "for speed".
    });
  } catch (err) {
    // I-15 again, from the transactional side: a denial raised INSIDE the
    // transaction rolls its own audit row back, so the two guards that can only
    // be evaluated in there are audited HERE, after the rollback, on `db`.
    if (
      err instanceof TRPCError &&
      (err.message === "CANNOT_REMOVE_LAST_ADMIN" ||
        err.message === "CONFLICT_ROLES_CHANGED")
    ) {
      await writeAudit(db, {
        actorUserID,
        actorRoles,
        targetUserID,
        action: "denied",
        rolesBefore: before,
        rolesAfter: after,
        ok: false,
        denyReason: err.message,
        reason,
        batchId,
      });
    }
    throw err;
  }

  await writeAudit(db, {
    actorUserID,
    actorRoles,
    targetUserID,
    action: "set",
    rolesBefore: before,
    rolesAfter: after,
    reason,
    batchId,
    ok: true,
  });
  return after;
}

/**
 * The CCA-path role-string write (I-14). Separate from applyRoleChange because
 * `cca_head` is in no ASSIGNABLE_BY entry, so the generic guards reject it by
 * design — this is the only way it can be written, and it maintains the
 * `CcaHead` row in the SAME transaction so CH-1 (`holds the string` iff `has
 * >=1 CcaHead row`) cannot drift.
 *
 * Same sticky construction as the chokepoint: every stored role other than
 * `cca_head` is carried through verbatim, so `resident`, `jcrc` and `admin` are
 * untouched by a CCA edit.
 */
async function writeCcaHeadString(
  tx: Omit<PrismaClient, `$${string}`>,
  targetUserID: string,
  present: boolean,
  actorUserID: string,
): Promise<string[]> {
  const row = await tx.userRole.findUnique({ where: { userID: targetUserID } });
  const current = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
  const kept = current.filter((r) => r !== CCA_HEAD_ROLE);
  const written = present ? [...kept, CCA_HEAD_ROLE] : kept;
  await tx.userRole.upsert({
    where: { userID: targetUserID },
    create: {
      userID: targetUserID,
      roles: written,
      role: mirror(written.filter(isGrantableRole)),
      updatedAt: new Date(),
      updatedBy: actorUserID,
    },
    update: {
      roles: written,
      role: mirror(written.filter(isGrantableRole)),
      updatedAt: new Date(),
      updatedBy: actorUserID,
    },
  });
  return written;
}

/**
 * OVERWRITE a CCA's head set to exactly `newHeadUserIDs`.
 *
 * The primitive behind head-initiated handover (`cca.handoverHeads`). It reuses
 * `writeCcaHeadString` above — the SOLE writer of the `cca_head` string — so
 * CH-1 (`holds "cca_head"` iff `has >= 1 CcaHead row`) cannot drift, exactly as
 * grantCcaHead / revokeCcaHead / transferCcaHead maintain it.
 *
 * BOUNDED AUTHORITY. It touches only the `cca_head` string and `CcaHead` rows
 * for this one ccaID; every other stored role is carried through verbatim by
 * writeCcaHeadString. So a caller can neither escalate nor strip
 * admin/jcrc/resident from anyone — which is why the head path that calls this
 * needs no admin-target guard (assertMayManageCcaHeadOf): the escalation that
 * guard prevents is not expressible here.
 *
 * GRANT-BEFORE-REVOKE, like transferCcaHead: a crash mid-way must leave a CCA
 * with EXTRA heads, never ZERO. The caller is responsible for refusing an empty
 * `newHeadUserIDs` (a headless CCA is the unrecoverable state).
 *
 * Callers audit the returned diff under one batchId; this function writes no
 * audit row of its own.
 */
export async function setCcaHeads(
  db: PrismaClient,
  ccaID: number,
  newHeadUserIDs: readonly string[],
  actorUserID: string,
): Promise<{ granted: string[]; revoked: string[]; batchId: string }> {
  const desiredSet = new Set(newHeadUserIDs);
  const batchId = randomUUID();

  const current = await db.ccaHead.findMany({
    where: { ccaID },
    select: { userID: true },
  });
  const currentSet = new Set(current.map((r) => r.userID));

  const toGrant = [...desiredSet].filter((u) => !currentSet.has(u));
  const toRevoke = [...currentSet].filter((u) => !desiredSet.has(u));

  await db.$transaction(async (tx) => {
    // Grants first — see the ordering note above.
    for (const userID of toGrant) {
      await tx.ccaHead.upsert({
        where: { userID_ccaID: { userID, ccaID } },
        create: { userID, ccaID, grantedBy: actorUserID },
        update: { grantedBy: actorUserID },
      });
      await writeCcaHeadString(tx, userID, true, actorUserID);
    }
    for (const userID of toRevoke) {
      await tx.ccaHead.deleteMany({ where: { userID, ccaID } });
      // CH-1: the string goes only when the LAST scope goes. A head of two CCAs
      // handed out of one keeps the role.
      const remaining = await tx.ccaHead.count({ where: { userID } });
      await writeCcaHeadString(tx, userID, remaining > 0, actorUserID);
    }
  });

  return { granted: toGrant, revoked: toRevoke, batchId };
}

/**
 * G3 for the CCA path. The generic guards are not reachable from here, so the
 * target guard is re-stated: a jcrc must not be able to reach an admin's role
 * document through the CCA endpoints either.
 */
async function assertMayManageCcaHeadOf(
  db: PrismaClient,
  actorUserID: string,
  actorRoles: readonly string[],
  targetUserID: string,
  /**
   * `dryRun` and `batchId` exist for the BULK CCA-head surface and change no
   * behaviour for the three single-user callers, which pass neither.
   *
   * `dryRun` mirrors assertCanMutateRoles' own dry-run exactly: identical
   * decision, DryRunDenied instead of an audit row, so a 200-row preview of a
   * jcrc's list containing two admins emits zero audit rows (I-15's inverse
   * case). `batchId` stamps the denial rows a bulk commit does write, so a
   * refused row is findable under the same batch as the applied ones.
   */
  opts?: { dryRun?: boolean; batchId?: string },
): Promise<void> {
  const deny = async (reason: string): Promise<never> => {
    if (opts?.dryRun) throw new DryRunDenied(reason);
    await writeAudit(db, {
      actorUserID,
      actorRoles: [...actorRoles],
      targetUserID,
      action: "denied",
      ok: false,
      denyReason: reason,
      batchId: opts?.batchId,
    });
    return forbid(reason);
  };
  // G7 — THE HALL OFFICE MUST NOT BECOME A CCA HEAD (phase 1 non-goal #6).
  // `cca_head` hands out assertHeadsCca and with it every CCA write, the member
  // directory and the attendee PII export, so the EXT namespace stays out.
  //
  // THIS NOW TESTS THE THING IT MEANS. It used to be `!isEFormatUserID(...)`,
  // which excluded EXT only as a side effect of demanding `/^E\d{7}$/` — and in
  // doing so it also excluded every genuine student whose email localpart is not
  // E-format. Measured 2026-08-28: 420 of 1624 NUS accounts, 25.9%, could not be
  // made a CCA head by anyone. `marcus-chua@u.nus.edu` -> `MARCUS-CHUA` was one
  // of them. That is lockout mode L-27, which identity.ts warns about while
  // calling this site the safe place for E_FORMAT; it was not.
  //
  // The security property is unchanged — an EXT pin is still refused — and the
  // grant path additionally resolves its target to a real account first, so this
  // guard now sees a key that provably belongs to somebody.
  if (isExtUserID(targetUserID)) await deny("NOT_A_CANONICAL_USERID"); // G7
  if (!actorRoles.includes(ADMIN_ROLE)) {
    const targetRoles = await getUserRoles(db, targetUserID);
    if (targetRoles.includes(ADMIN_ROLE)) await deny("CANNOT_MODIFY_AN_ADMIN");
  }
}

/* ========================================================================== */
/* SECTION C — the router                                                     */
/* ========================================================================== */

export const adminRouter = createTRPCRouter({
  /**
   * D-2's single source of client-side truth. NOT roleManagerProcedure: the
   * header calls this for every signed-in user, and a FORBIDDEN on every page
   * load is not acceptable. A non-manager simply receives an all-false
   * capability set.
   */
  whoAmI: protectedProcedure.query(({ ctx }) => {
    const roles = ctx.session.user.roles ?? [];
    return {
      userID: ctx.session.user.userID,
      roles, // includes the stored "resident"
      capabilities: caps(roles),
    };
  }),

  listUsers: roleManagerProcedure
    .input(listInput)
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      const { search, role, limit, cursor } = input;

      /** D-2: a jcrc must not be handed an enumeration of who holds admin. */
      const redact = (roles: string[]) =>
        c.seeAdminIdentities ? roles : roles.filter((r) => r !== ADMIN_ROLE);

      // ---- role-filtered branch: page the SMALL collection first ----------
      if (role) {
        if (role === ADMIN_ROLE) requireCapability(c, "seeAdminIdentities");
        const roleRows = await ctx.db.userRole.findMany({
          where: { OR: [{ roles: { has: role } }, { role }] }, // legacy-tolerant
          take: limit + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          orderBy: { id: "asc" },
        });
        const page = roleRows.slice(0, limit);
        const nextCursor =
          roleRows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

        // Hydrate. There is no reverse E-format -> email Mongo query, so probe
        // the conventional address and left-join in memory. A role may
        // legitimately exist for a user with no User row (a claimed pending
        // grant, a hand-seeded admin), so a miss renders as a bare id — never
        // as an omission, which would hide a live grant from the audit surface.
        const emails = page.map((r) => `${r.userID.toLowerCase()}@u.nus.edu`);
        const users = await ctx.db.user.findMany({
          where: { email: { in: emails, mode: "insensitive" } },
          // NEVER a bare findMany: passwordHash must not reach the client, and
          // passwordHash-less Google-adapter rows would throw on a full read
          // (I-2).
          select: { id: true, email: true, displayName: true, userID: true },
        });
        // C9: keys that canonicalize to ABSENT are dropped rather than stored
        // under a sentinel key. Before C9 a non-NUS row entered this map at key
        // "" — and `byCanonical.get(r.userID)` below would then MATCH it for a
        // ""-keyed UserRole row (the I-8d red line), attributing a stranger's
        // email and displayName to that grant on the admin surface. That is
        // 09's S5 exactly, and it is a lookup indistinguishable from success.
        // Unreachable while no ""-keyed row exists; the compiler found it anyway.
        const byCanonical = new Map<string, (typeof users)[number]>(
          users.flatMap((u) => {
            const cid = canonicalUserID(u.email);
            return cid === null ? [] : [[cid, u] as const];
          }),
        );

        return {
          items: page.map((r) => {
            const u = byCanonical.get(r.userID);
            return {
              id: u?.id ?? r.id,
              // C9: `UserRole.userID` IS the canonical role key by I-8d, but
              // Prisma types it `string` and a ""-keyed row is exactly the red
              // line I-8d names. Mint it through the checked entry point, so
              // such a row arrives at the client as ABSENT — rendered as "—"
              // with Manage disabled, identical to how the listUsers arm has
              // always rendered a non-NUS account — instead of as a usable
              // grant target. Not reachable today; no ""-keyed row exists.
              canonicalUserID: asStoredCanonicalUserID(r.userID),
              legacyUserID: u?.userID ?? null,
              email: u?.email ?? null,
              displayName: u?.displayName ?? null,
              block: null as string | null,
              hasAccount: Boolean(u),
              // Same field on both branches of this procedure, deliberately: a
              // field present on one arm only turns the return type into a
              // union and every client reader into a narrowing exercise. Here
              // the key is read straight out of UserRole, so the namespace test
              // is all that is needed.
              pinned: isExtUserID(r.userID),
              eligible: true,
              keyMismatch: false,
              roles: redact(r.roles?.length ? r.roles : r.role ? [r.role] : []),
            };
          }),
          nextCursor,
        };
      }

      // ---- default branch: page User, batch the role lookup ---------------
      const esc = search ? escapeRegex(search) : undefined;
      const users = await ctx.db.user.findMany({
        where: esc
          ? {
              OR: [
                { email: { contains: esc, mode: "insensitive" } },
                { displayName: { contains: esc, mode: "insensitive" } },
              ],
            }
          : {},
        select: {
          id: true,
          email: true,
          displayName: true,
          userID: true,
          block: true,
        },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
      });

      const page = users.slice(0, limit);
      const nextCursor =
        users.length > limit ? (page[page.length - 1]?.id ?? null) : null;

      /* ---- ALLOWLIST-PINNED ROWS ------------------------------------------
       * WITHOUT THIS BLOCK AN ADMIN CANNOT GRANT `scrc` AT ALL, and the cause
       * looks like a permissions bug rather than a missing lookup.
       *
       * `canonicalUserID(u.email)` is null for an @nus.edu.sg staff address, so
       * the row below would render `canonicalUserID: null` -> UserRoleTable
       * prints "—" and DISABLES its Manage-roles button (`disabled={!u.
       * canonicalUserID}`), which is the only path to setUserRoles in the UI.
       *
       * Resolved as a BATCH, and only for the rows that actually failed to
       * canonicalize — usually zero, occasionally a handful of legacy Google
       * rows. One extra indexed `in` query per page, on a <=100-row admin-only
       * page, skipped entirely when there is nothing to resolve. `cidOf` below
       * is the single derivation both call sites use, so the row's
       * `canonicalUserID`, `eligible` and `roles` cannot disagree about which
       * key this account has.
       *
       * NOTE the pins go through pinnedUserIDsFor, which applies the SAME
       * asExtUserID namespace filter per row (M2) that the session path does —
       * so a poisoned row renders here exactly as it authorizes: as nothing.
       */
      const unresolved = page
        .filter((u) => canonicalUserID(u.email) === null)
        .map((u) => u.email);
      const pins = unresolved.length
        ? await pinnedUserIDsFor(ctx.db, unresolved)
        : new Map<string, CanonicalUserID>();
      const cidOf = (email: string): CanonicalUserID | null =>
        canonicalUserID(email) ?? pins.get(normalizeEmail(email)) ?? null;

      // C9: `.filter(Boolean)` removed the absent ids at RUNTIME but not in the
      // type, so the `in:` filter below was typed as if it could carry one. A
      // type predicate makes the existing runtime behaviour checkable. No
      // runtime change: null was already dropped, exactly as "" was.
      const canonicalIDs = page
        .map((u) => cidOf(u.email))
        .filter((id): id is CanonicalUserID => id !== null);
      const roleRows = await ctx.db.userRole.findMany({
        where: { userID: { in: canonicalIDs } },
      });
      const byID = new Map(
        roleRows.map((r) => [
          r.userID,
          r.roles?.length ? r.roles : r.role ? [r.role] : [],
        ]),
      );

      return {
        items: page.map((u) => {
          const cid = cidOf(u.email);
          return {
            id: u.id,
            canonicalUserID: cid, // the key ALL mutations must submit; null => none
            legacyUserID: u.userID, // DISPLAY ONLY — may be an A-format matric
            email: u.email,
            displayName: u.displayName,
            block: u.block,
            hasAccount: true,
            /**
             * TRUE for an allowlist-pinned staff address, and that is now the
             * CORRECT answer rather than a widening: such an account CAN sign
             * in (maySignIn consults the same collection) and DOES hold a
             * principal key. `keyMismatch` below stays false for them because
             * provisioning writes `User.userID` = the pin.
             */
            pinned: cid !== null && isExtUserID(cid),
            eligible: cid !== null, // false => cannot sign in under D-7
            keyMismatch: Boolean(u.userID && u.userID !== cid),
            // C9: `byID.get(cid)` with an absent cid was the same S5 lookup as
            // the pending-grants map above — `byID.get("")` would have rendered
            // a ""-keyed UserRole row's roles (potentially `admin`) as THIS
            // non-NUS user's roles in the admin table. An account with no
            // canonical id holds no stored roles, by construction, so [] is
            // both the safe answer and the true one.
            roles: redact(cid === null ? [] : (byID.get(cid) ?? [])),
          };
        }),
        nextCursor,
      };
    }),

  getStats: roleManagerProcedure.query(async ({ ctx }) => {
    const c = caps(ctx.session.user.roles);
    const [totalUsers, jcrc, ccaHead, scrc, admins] = await Promise.all([
      ctx.db.user.count(),
      ctx.db.userRole.count({
        where: { OR: [{ roles: { has: JCRC_ROLE } }, { role: JCRC_ROLE }] },
      }),
      ctx.db.userRole.count({
        where: {
          OR: [{ roles: { has: CCA_HEAD_ROLE } }, { role: CCA_HEAD_ROLE }],
        },
      }),
      // Hall office. A COUNT, visible to every manager, deliberately unlike
      // `admins` below — the hall office is an appointed body whose size is
      // ordinary operational information, not the `seeAdminIdentities` line.
      // Counting it here is also the cheapest standing answer to "how many
      // accounts can appoint the JCRC", which is the number worth watching.
      // The legacy `role` scalar is included for symmetry only: `scrc` is
      // absent from PRECEDENCE and so is never mirrored into it.
      ctx.db.userRole.count({
        where: { OR: [{ roles: { has: SCRC_ROLE } }, { role: SCRC_ROLE }] },
      }),
      ctx.db.userRole.count({
        where: { OR: [{ roles: { has: ADMIN_ROLE } }, { role: ADMIN_ROLE }] },
      }),
    ]);
    return {
      totalUsers,
      jcrc,
      ccaHead,
      scrc,
      admins: c.seeAdminIdentities ? admins : null,
    };
  }),

  /* ---------------------------------------------------------------------- */
  /* HALL OFFICE (scrc) — the /scrc surface                                  */
  /*                                                                         */
  /* Three procedures, all on scrcProcedure (admin | scrc), all asserting    */
  /* `manageJcrcRoster` AND the `scrc.enabled` kill switch. They exist as a  */
  /* deliberately NARROW alternative to listUsers + setUserRoles, which the  */
  /* hall office must not reach:                                            */
  /*                                                                         */
  /*   - listUsers pages the WHOLE HALL and returns email, displayName and   */
  /*     block for every account. listJcrcRoster pages the small UserRole    */
  /*     collection filtered to jcrc — a roster the hall office itself       */
  /*     appoints — and DROPS admin-holding rows entirely.                   */
  /*   - setUserRoles takes a client-supplied FINAL role set. setJcrcRole    */
  /*     takes a boolean and constructs the set server-side from the         */
  /*     target's current roles ± jcrc, so an scrc payload is INCAPABLE OF   */
  /*     EXPRESSING the removal of any other role. G4 would catch that       */
  /*     anyway; not being able to say it is stronger than being refused.    */
  /*                                                                         */
  /* setUserRoles, listUsers and roleManagerProcedure are all UNCHANGED —    */
  /* zero regression risk for admin and jcrc is the whole point of adding    */
  /* three procedures instead of widening two.                              */
  /* ---------------------------------------------------------------------- */

  /**
   * The current JCRC, for the hall office's revoke list.
   *
   * Pages `UserRole` (small) rather than `User` (the whole hall), legacy-tolerant
   * on the singular `role` scalar exactly as listUsers' role-filtered branch is.
   *
   * ADMIN ROWS ARE DROPPED, NOT REDACTED (R14). An admin who also holds jcrc
   * matches the filter, and returning them — even with the roles array stripped —
   * would tell the hall office that someone is unusually privileged, which is the
   * `seeAdminIdentities` line. Dropping them also means `scrc` is never shown a
   * target that G3 (CANNOT_MODIFY_AN_ADMIN) would refuse.
   *
   * `roles` is NOT in the projection at all. There is nothing to redact if it
   * never leaves.
   *
   * THIS IS THE ONE PLACE THE HALL OFFICE IS GIVEN CANONICAL IDS AND EMAILS ON
   * PURPOSE, and it is worth being explicit since every other read-only surface
   * strips them (cca.getRoster, cca.listHeads, event.getForOversight all redact
   * identity for this tier). The exception is justified, not an oversight:
   *   - the JCRC is an appointed body this role EXISTS to administer, and its
   *     membership is effectively public in the hall;
   *   - `canonicalUserID` is not decoration, it is the argument setJcrcRole
   *     needs in order to revoke — without it the revoke button cannot work;
   *   - it is bounded by construction. This lists holders of ONE role, admins
   *     excluded, not the hall.
   * Nothing here generalises to the other surfaces. Do not cite it as precedent
   * for returning an id anywhere else on this tier.
   */
  listJcrcRoster: scrcProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      requireCapability(caps(ctx.session.user.roles), "manageJcrcRoster");
      await assertScrcEnabled(ctx.db);

      const { limit, cursor } = input;
      const roleRows = await ctx.db.userRole.findMany({
        where: { OR: [{ roles: { has: JCRC_ROLE } }, { role: JCRC_ROLE }] },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
      });
      const page = roleRows.slice(0, limit);
      // Computed from the RAW page, before the admin filter below. If it were
      // computed from the filtered list, a page consisting entirely of admins
      // would return no cursor and the client would stop paging mid-roster.
      const nextCursor =
        roleRows.length > limit ? (page[page.length - 1]?.id ?? null) : null;

      const visible = page.filter((r) => {
        const stored = r.roles?.length ? r.roles : r.role ? [r.role] : [];
        return !stored.includes(ADMIN_ROLE);
      });

      // Hydrate. There is no reverse E-format -> email Mongo query, so probe the
      // conventional address and left-join in memory, exactly as listUsers does.
      // A jcrc row with no User row (a claimed pending grant, a hand-seeded
      // account) renders as a bare id — never as an omission, which would hide a
      // live grant from the person whose job is to manage it.
      const emails = visible.map((r) => `${r.userID.toLowerCase()}@u.nus.edu`);
      const users = await ctx.db.user.findMany({
        where: { email: { in: emails, mode: "insensitive" } },
        // NEVER a bare findMany: passwordHash must not reach the client, and
        // passwordHash-less Google-adapter rows throw on a full read (I-2).
        select: { email: true, displayName: true },
      });
      // C9, copied verbatim from listUsers and load-bearing for the same reason:
      // a key that canonicalizes to ABSENT is DROPPED rather than stored under
      // "". Without this, `byCanonical.get("")` would match a ""-keyed UserRole
      // row and attribute a stranger's email and displayName to that grant.
      // Unreachable while no ""-keyed row exists; do not "simplify" it away.
      const byCanonical = new Map<string, (typeof users)[number]>(
        users.flatMap((u) => {
          const cid = canonicalUserID(u.email);
          return cid === null ? [] : [[cid, u] as const];
        }),
      );

      return {
        items: visible.map((r) => {
          const u = byCanonical.get(r.userID);
          return {
            // Minted through the checked entry point so a ""-keyed row arrives
            // at the client as ABSENT rather than as a usable grant target.
            canonicalUserID: asStoredCanonicalUserID(r.userID),
            email: u?.email ?? null,
            displayName: u?.displayName ?? null,
            hasAccount: Boolean(u),
          };
        }),
        nextCursor,
      };
    }),

  /**
   * One identifier in, one person out — the hall office's GRANT target picker.
   * It exists so that `scrc` never needs listUsers.
   *
   * TWO PROPERTIES, both of which this procedure got WRONG in its first form and
   * both of which are the reason it is written the way it is now.
   *
   * 1. THE NEGATIVE ANSWER IS SINGLE-VALUED. It originally returned NOT_FOUND
   *    for an unresolvable identifier, NOT_SIGNED_IN for a resolvable one with
   *    no UserRole row, FOUND for an ordinary account, and NOT_FOUND again for a
   *    target holding `admin`. Those four collapse to a three-way partition in
   *    which "resolves, but answers NOT_FOUND" is TRUE EXACTLY WHEN THE TARGET
   *    IS AN ADMIN. The clause written to conceal admins was the one that
   *    identified them, and a loop over @u.nus.edu addresses enumerated the
   *    admin roster precisely — the `seeAdminIdentities` line, crossed by the
   *    role that has the least business crossing it.
   *    So every negative now returns the SAME `{ status: "NOT_AVAILABLE" }`,
   *    with no userID, no reason code and no shape difference. Read
   *    JcrcCandidateResult's comment before adding anything to that branch.
   *    KNOWN RESIDUAL, accepted: the three negatives still differ in how many
   *    queries they run (0, 1 and 2), so they differ in latency. That is a
   *    timing side channel over network jitter on a per-request audited surface,
   *    not a status code; padding it would cost a fake query on every miss and
   *    still not equalise it. Not worth it. Do not "fix" it by re-splitting the
   *    status.
   *
   * 2. EVERY CALL IS AUDITED, INCLUDING THE MISSES. The audit write originally
   *    sat below the early returns, so precisely the calls worth investigating —
   *    the misses and the admin hits, i.e. an enumeration sweep — wrote NOTHING,
   *    while the comment claimed otherwise. `record()` is now called on every
   *    exit path, and it carries the probed identifier and the outcome CLASS
   *    (which is recorded server-side and never returned; that asymmetry is the
   *    entire design). Volume of `scrc.candidate.read` rows for one actor is the
   *    detection signal, and it only exists if the misses are in there.
   *
   * The audit rows are written with `ok: true` even for a miss: `ok: false` is
   * how the guards mark an AUTHORIZATION denial, and a lookup that found nobody
   * is not one. Keeping them in one class is what makes "count this actor's
   * probes" a single query.
   *
   * On the FOUND branch it returns displayName and email ONLY — never matric,
   * telegramHandle or bio. Those live behind userAdmin.get, which is
   * manager-level and separately guarded. The email is returned deliberately:
   * the operator is about to hand someone JCRC access and has to eyeball WHO,
   * this is one target at a time rather than an enumeration, and the audit row
   * names exactly which target was disclosed.
   */
  resolveJcrcCandidate: scrcProcedure
    .input(z.object({ identifier: z.string().trim().min(1).max(120) }))
    .query(async ({ ctx, input }): Promise<JcrcCandidateResult> => {
      requireCapability(caps(ctx.session.user.roles), "manageJcrcRoster");
      await assertScrcEnabled(ctx.db);

      const raw = input.identifier.trim();

      /**
       * The audit row, on EVERY exit path. `outcome` is the server-side truth
       * the caller is NOT told: UNRESOLVED / AMBIGUOUS / NEVER_SIGNED_IN /
       * TARGET_IS_ADMIN / TARGET_HOLDS_SCRC / FOUND. FOUR of those six are
       * returned to the client as the same opaque NOT_AVAILABLE — the record is
       * where the difference is allowed to exist, because only an admin can read
       * it (`readAuditLog`).
       *
       * The probed string is recorded, truncated. It is the only way an admin
       * investigating a sweep can see WHAT was swept; a row saying merely "a
       * lookup happened" would not distinguish one operator doing their job
       * from a dictionary attack. It is bounded at 120 chars by the input schema
       * and sliced again here so a future schema change cannot grow the field.
       */
      const record = async (outcome: string, targetUserID?: string) =>
        writeAudit(ctx.db, {
          actorUserID: ctx.session.user.userID,
          actorRoles: [...(ctx.session.user.roles ?? [])],
          targetUserID,
          action: "scrc.candidate.read",
          reason: `probe=${raw.slice(0, 120)} outcome=${outcome}`,
          ok: true,
        });

      // Resolve to a canonical userID by tier. Matric is the only tier that can
      // be AMBIGUOUS, because it is looked up in a non-unique collection — and
      // it is decided HERE, before any role or account read, which is what makes
      // it safe to keep as a distinct status (see JcrcCandidateResult).
      //
      // MATRIC BEFORE THE BARE-ID TIER, and the order is load-bearing for the
      // same reason it is in cca.resolveHeadCandidate: `A0345036J` is a
      // well-formed localpart, so the tier below would convert it into a key no
      // session produces. The matric tier translates it to the holder's real
      // key first.
      let candidateID: string | null = null;
      if (raw.includes("@")) {
        candidateID = canonicalUserID(raw); // email → canonical, or null
      } else if (MATRIC_RE.test(raw.toUpperCase())) {
        const rows = await ctx.db.userMatric.findMany({
          where: { matric: raw.toUpperCase() },
          select: { userID: true },
        });
        if (rows.length > 1) {
          await record("AMBIGUOUS");
          return { status: "AMBIGUOUS" };
        }
        candidateID = rows[0]?.userID ?? null;
      } else {
        // A BARE NUSNET ID, E-FORMAT OR NOT — the same L-27 lockout that this
        // box's CCA-head twin carried: 420 of 1624 accounts (25.9%, measured
        // 2026-08-28) have a non-E localpart and could not be looked up at all,
        // so no jcrc could be granted to a quarter of the hall.
        //
        // NO NEW ORACLE. Every negative outcome on this procedure still returns
        // the same opaque NOT_AVAILABLE, byte for byte (see JcrcCandidateResult)
        // — what changes is only WHICH negative the audit records: an
        // unrecognised string used to stop at UNRESOLVED and now reaches
        // NEVER_SIGNED_IN. Both are admin-only, and the caller cannot tell them
        // apart either way.
        //
        // G7 is intact for the same structural reason as everywhere else:
        // canonicalFromNusnetID cannot emit a ':' , so an `EXT:` pin typed here
        // resolves to nothing.
        candidateID = canonicalFromNusnetID(raw);
      }

      if (candidateID === null) {
        await record("UNRESOLVED");
        return { status: "NOT_AVAILABLE" };
      }

      // Must have signed in: a UserRole row is written at account creation and
      // topped up every session, so "has a row" is a reliable proxy for "has
      // logged in at least once". A grant to someone with no row would be keyed
      // on an id no session ever matches — it would appear to succeed and do
      // nothing (I-1).
      const roleRow = await ctx.db.userRole.findUnique({
        where: { userID: candidateID },
        select: { roles: true, role: true },
      });
      if (!roleRow) {
        // targetUserID IS recorded here even though the caller is told nothing:
        // the id resolved, so the audit trail can say which one was probed.
        await record("NEVER_SIGNED_IN", candidateID);
        return { status: "NOT_AVAILABLE" };
      }

      const stored = roleRow.roles?.length
        ? roleRow.roles
        : roleRow.role
          ? [roleRow.role]
          : [];
      if (stored.includes(ADMIN_ROLE)) {
        await record("TARGET_IS_ADMIN", candidateID);
        return { status: "NOT_AVAILABLE" };
      }
      // SCREENED FOR THE SAME REASON AS ADMIN, AND THE OMISSION WAS A HOLE THAT
      // ONLY OPENED WHEN THE TWO PROCEDURES WERE COMPOSED. Each was safe alone:
      // this one screened admins, and setJcrcRole collapsed five causes into one
      // opaque SCRC_TARGET_UNAVAILABLE. But a caller could run both —
      //
      //   1. resolve(x) -> FOUND, holdsJcrc:false   rules out never-signed-in
      //                                             (a row exists), admin
      //                                             (screened) and already-jcrc
      //   2. setJcrcRole(x, grant:true) -> UNAVAILABLE
      //
      // — and step 2 could then only mean TARGET_HOLDS_SCRC. The pair uniquely
      // identified hall-office accounts, which PART 6 open question 3 decided
      // this role must not be able to enumerate. Screening `scrc` here removes
      // step 1's ability to rule the other causes out, so the two answers stop
      // composing into a third.
      //
      // The lesson, worth more than the fix: an opaque failure is only opaque
      // relative to what ELSE the caller can ask. Any new read added to this
      // surface must be checked against setJcrcRole's cause set, not just on its
      // own.
      if (stored.includes(SCRC_ROLE)) {
        await record("TARGET_HOLDS_SCRC", candidateID);
        return { status: "NOT_AVAILABLE" };
      }

      // Best-effort display. There is no reverse canonical→User query, so guess
      // the email like listUsers does, and fall back to the stored key.
      const user = await ctx.db.user.findFirst({
        where: {
          OR: [
            {
              email: {
                equals: `${candidateID.toLowerCase()}@u.nus.edu`,
                mode: "insensitive",
              },
            },
            { userID: candidateID },
          ],
        },
        // Never a bare read: passwordHash must not leave the server, and a
        // Google-adapter row lacking it throws on deserialization (I-2).
        select: { displayName: true, email: true },
      });

      await record("FOUND", candidateID);

      return {
        status: "FOUND",
        userID: candidateID,
        displayName: user?.displayName ?? null,
        email: user?.email ?? null,
        holdsJcrc: stored.includes(JCRC_ROLE),
      };
    }),

  /**
   * THE hall-office write: add or remove `jcrc` on one account. Nothing else.
   *
   * It is a dedicated mutation rather than a widening of setUserRoles because
   * the FINAL SET IS CONSTRUCTED SERVER-SIDE from the target's current roles ±
   * jcrc. An scrc caller therefore cannot express the removal of another user's
   * `cca_head`, `scrc` or `admin` — not "is refused when they try", but has no
   * way to say it. setUserRoles' payload could say all of that and would then
   * depend entirely on G4 to catch it, on a surface G4 has never had to defend.
   *
   * SELF-TARGETING IS REFUSED OUTRIGHT, before the guards. G6 already denies a
   * non-admin self-granting a role they lack, so this is the second of two
   * independent guards — but G6's condition is `!actorRoles.includes(r)`, so if
   * a hall-office member is ever ALSO granted `jcrc` by an admin, G6 stops
   * firing and self-targeting becomes reachable through exactly this surface.
   * Belt and braces at the surface that created the risk. The denial is audited
   * with its own denyReason so it is greppable independently of G6's.
   *
   * The `before` read below is DELIBERATELY ADVISORY. applyRoleChange's
   * in-transaction compare-and-set (CONFLICT_ROLES_CHANGED) is the real
   * protection against the TOCTOU between this read and the write; do not
   * "optimise" the read away or reason as though it were authoritative.
   *
   * ------------------------------------------------------------------------
   * THE OPAQUE-FAILURE RULE, and why this mutation is not just a write.
   * ------------------------------------------------------------------------
   * `sanitizeErrors` (trpc.ts) rewrites INTERNAL_SERVER_ERROR only — every
   * FORBIDDEN message reaches the client verbatim, and its own comment says so.
   * So a mutation that answers "why not" is an ORACLE, and this one sat next to
   * resolveJcrcCandidate answering the same question the resolver had just been
   * rewritten to stop answering:
   *
   *     setJcrcRole({ userID: "E1234567", grant: false })
   *
   * Revoking `jcrc` from somebody who does not hold it used to be a harmless
   * SUCCESSFUL no-op, so the probe was non-destructive, repeatable and silent —
   * and G3 answered `CANNOT_MODIFY_AN_ADMIN` for an admin. One call per target,
   * perfectly reliable, and the admin roster falls out.
   *
   * TWO CHANGES CLOSE IT:
   *
   *  1. EVERY TARGET-DEPENDENT REFUSAL RETURNS ONE OPAQUE MESSAGE,
   *     `SCRC_TARGET_UNAVAILABLE` — the same one for "no account", "never signed
   *     in", "holds admin", "holds scrc" and "the change would be a no-op". The
   *     REAL reason is written to the audit row every time, where only an admin
   *     (`readAuditLog`) can read it. Client sees one bit; the record keeps five.
   *  2. THE NO-OPS ARE FAILURES, NOT SUCCESSES. Success itself is a signal, so
   *     granting `jcrc` to somebody who already holds it, and revoking it from
   *     somebody who does not, both refuse. The ONLY distinguishable success is
   *     therefore a genuine state change — which is loud, audited, reversible,
   *     and visible in the roster the actor is already allowed to read.
   *
   * G3 IS NOT WEAKENED. It still fires, still audits, still refuses; this
   * mutation simply pre-empts it with its own check and, as a backstop for the
   * narrow race where a target gains `admin` mid-request, RE-MAPS the
   * target-discriminating messages on the way out (TARGET_DISCRIMINATING below).
   * Other callers of assertCanMutateRoles are untouched and still get the
   * specific reason.
   *
   * HONEST RESIDUAL — what an `scrc` caller can STILL infer:
   *
   *  - Whether a target currently holds `jcrc`, to a certainty, in ONE call:
   *    `grant: false` succeeding means they held it. That is not a leak — the
   *    JCRC roster is exactly what listJcrcRoster hands this caller by design,
   *    and it is the roster they are employed to manage.
   *  - That a target is "unavailable" — i.e. SOME ONE of {no account, never
   *    signed in, holds admin, holds scrc}. The partition is not resolvable
   *    from the response: all four are one message, and all four are also what
   *    resolveJcrcCandidate reports as NOT_AVAILABLE, so the two surfaces agree
   *    and neither can be used to split the other's answer.
   *
   *    THAT AGREEMENT IS LOAD-BEARING AND WAS ONCE FALSE. While the resolver
   *    still reported a hall-office account as FOUND, the PAIR of calls was a
   *    sharper instrument than either one: a FOUND with holdsJcrc:false ruled
   *    out never-signed-in, admin and already-jcrc, so a subsequent UNAVAILABLE
   *    could only mean "holds scrc". Both surfaces must therefore screen the
   *    SAME set. Before adding a read to this surface, check it against this
   *    cause list — an opaque failure is only opaque relative to what else the
   *    caller can ask.
   *  - COST OF PROBING: unlike the resolver, every attempt here is a MUTATION
   *    that writes a `denied` audit row naming the actor and the target. A sweep
   *    of the hall is ~1200 rows under one actorUserID — the loudest thing this
   *    role can do. That is the intended trade: the oracle is closed, and the
   *    residual inference is expensive and self-reporting.
   *  - NOT closed, and not closeable here: an actor who holds BOTH the hall
   *    office and some other privilege could correlate. EXCLUSIVE_ROLE_PAIRS
   *    already forbids the jcrc+scrc case, which is the one that mattered.
   */
  setJcrcRole: scrcProcedure
    .input(
      z.object({
        userID: userIDSchema,
        grant: z.boolean(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireCapability(caps(ctx.session.user.roles), "manageJcrcRoster");
      await assertScrcEnabled(ctx.db);

      const actorUserID = ctx.session.user.userID;
      const actorSessionRoles = [...(ctx.session.user.roles ?? [])];

      if (input.userID === actorUserID) {
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles: actorSessionRoles,
          targetUserID: input.userID,
          action: "denied",
          ok: false,
          denyReason: "SCRC_CANNOT_SELF_TARGET",
        });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "SCRC_CANNOT_SELF_TARGET",
        });
      }

      /**
       * Refuse opaquely, recording the REAL reason. `denyReason` is the
       * server-side truth; the thrown message is the single bit the client gets.
       * Deliberately mirrors resolveJcrcCandidate's record()/NOT_AVAILABLE
       * split, so the two surfaces cannot be played against each other.
       *
       * RETURNS the error for the caller to `throw` rather than throwing
       * itself: an `await`ed call typed `Promise<never>` does NOT narrow control
       * flow in TypeScript, so `if (!row) await unavailable(...)` would leave
       * `row` still nullable below and invite a `!` on exactly the lines that
       * decide what this mutation does. `throw await unavailable(...)` narrows
       * properly and keeps the audit write on the same statement.
       */
      const unavailable = async (denyReason: string): Promise<TRPCError> => {
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles: actorSessionRoles,
          targetUserID: input.userID,
          action: "denied",
          ok: false,
          denyReason,
          reason: input.reason,
        });
        return new TRPCError({
          code: "FORBIDDEN",
          message: "SCRC_TARGET_UNAVAILABLE",
        });
      };

      // N2: THE EXISTENCE GATE, which resolveJcrcCandidate enforces and this
      // mutation did not. applyRoleChange ends in an `upsert`, so without this
      // `setJcrcRole({ userID: "E9999999", grant: true })` MINTS a UserRole row
      // holding `jcrc` for an id no session will ever match — a phantom grant
      // that reports success, does nothing forever, and shows up in the roster
      // and in every jcrc count as if it were a person (I-1). A UserRole row is
      // written at account creation and topped up every session, so "has a row"
      // is the same has-signed-in proxy the resolver uses.
      const targetRow = await ctx.db.userRole.findUnique({
        where: { userID: input.userID },
        select: { roles: true, role: true },
      });
      if (!targetRow) throw await unavailable("TARGET_NEVER_SIGNED_IN");

      const storedAll = targetRow.roles?.length
        ? targetRow.roles
        : targetRow.role
          ? [targetRow.role]
          : [];

      // G3's question, asked HERE so G3's ANSWER never reaches this client.
      if (storedAll.includes(ADMIN_ROLE)) {
        throw await unavailable("TARGET_IS_ADMIN");
      }
      // G8's question, likewise. Without this the exclusion invariant would
      // itself become an oracle for "who holds scrc" — which open question 3
      // decided this role must NOT be able to enumerate.
      if (storedAll.includes(SCRC_ROLE)) {
        throw await unavailable("TARGET_HOLDS_SCRC");
      }

      // THE NO-OPS. Both used to succeed, and a success that changes nothing is
      // a free, silent read of the target's state. Refusing turns the only
      // distinguishable success into a real, audited state change.
      const holdsJcrc = storedAll.includes(JCRC_ROLE);
      if (input.grant && holdsJcrc) {
        throw await unavailable("TARGET_ALREADY_JCRC");
      }
      if (!input.grant && !holdsJcrc) {
        throw await unavailable("TARGET_NOT_JCRC");
      }

      const before = (await getUserRoles(ctx.db, input.userID)).filter(
        isGrantableRole,
      );
      const requestedRoles = input.grant
        ? [...new Set<string>([...before, JCRC_ROLE])]
        : before.filter((r) => r !== JCRC_ROLE);

      try {
        const {
          actorRoles,
          before: guardedBefore,
          after,
          added,
          removed,
        } = await assertCanMutateRoles({
          db: ctx.db,
          actorUserID,
          targetUserID: input.userID,
          requestedRoles,
        });

        // Same threading rule as setUserRoles: `added`/`removed` are the
        // AUTHORISED delta and applyRoleChange asserts on `removed` (I-8c), so a
        // caller must not be able to skip that by passing only `after`.
        await applyRoleChange({
          db: ctx.db,
          actorUserID,
          actorRoles,
          targetUserID: input.userID,
          before: guardedBefore,
          after,
          added,
          removed,
          reason: input.reason,
        });
        // DELIBERATELY NOT applyRoleChange's returned role set, which
        // setUserRoles does return. That set is the target's full grantable
        // roles, so it would disclose `cca_head` — re-linking a person to a CCA
        // headship the read-only tier now has redacted ids for — as a side
        // effect of an unrelated write. `grant` is echoed instead of read back:
        // the mutation succeeded, so the target's jcrc state is exactly what was
        // asked for, and the panel refetches listJcrcRoster anyway.
        return { userID: input.userID, holdsJcrc: input.grant };
      } catch (err) {
        // THE RACE BACKSTOP. The four checks above read the target's roles in an
        // EARLIER statement; if the target gains `admin` or `scrc` between that
        // read and the guards, G3 or G8 fires and its specific message would
        // escape to the client — restoring the oracle through a window the
        // attacker cannot steer but does not need to. So any TARGET-DEPENDENT
        // message is flattened on the way out.
        //
        // ALLOWLIST, not a blanket catch: the actor-dependent refusals
        // (CANNOT_GRANT_JCRC, NOT_A_ROLE_MANAGER, CAPABILITY_REQUIRED:*) are
        // identical for EVERY target, so they disclose nothing about anyone and
        // are far more useful to the operator left intact. CONFLICT_ROLES_CHANGED
        // likewise reports a race, not a property of the target.
        //
        // The guards have ALREADY written their own audit row before throwing
        // (assertCanMutateRoles' deny() is audited outside any transaction,
        // I-15), so the real reason is on the record without writing a second.
        if (err instanceof TRPCError && TARGET_DISCRIMINATING.has(err.message)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "SCRC_TARGET_UNAVAILABLE",
          });
        }
        throw err;
      }
    }),

  /** The one single-user role mutation. Takes the DESIRED FINAL grantable set. */
  setUserRoles: roleManagerProcedure
    .input(
      z.object({
        // roleTargetUserIDSchema, NOT userIDSchema: this is the ONE mutation
        // through which the EXT namespace can receive a role, and it is the
        // only way to grant `scrc` to an allowlist-pinned hall-office account.
        // Everything downstream is unchanged — G1..G8 still run, G7 now demands
        // a LIVE AuthAllowlist row for an EXT target (a proof, not a shape),
        // and the write still goes through applyRoleChange's transaction.
        userID: roleTargetUserIDSchema,
        roles: roleSchema.array().max(8),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const { actorRoles, before, after, added, removed } =
        await assertCanMutateRoles({
          db: ctx.db,
          actorUserID,
          targetUserID: input.userID,
          requestedRoles: input.roles,
        });
      // `added`/`removed` are the authorised DELTA and must be threaded
      // through: applyRoleChange asserts on `removed` (I-8c) and a caller must
      // not be able to skip that by passing only `after`.
      const result = await applyRoleChange({
        db: ctx.db,
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        before,
        after,
        added,
        removed,
        reason: input.reason,
      });
      return { userID: input.userID, roles: result };
    }),

  /* ---- CCA head endpoints (I-14) ------------------------------------- */

  /**
   * The ONLY writer of the `cca_head` string. Writes the UserRole string and
   * the scoped CcaHead row in ONE transaction, so CH-1 cannot drift. Available
   * to admin AND jcrc via the `manageCcaHeads` capability — note that jcrc's
   * assignableRoles is [] under D-3, so this power is deliberately NOT readable
   * off the assignable set.
   */
  grantCcaHead: roleManagerProcedure
    .input(
      z.object({
        // ccaHeadTargetSchema, NOT userIDSchema: the latter is /^E\d{7}$/ and
        // locked out 420 of 1624 real accounts (L-27). The shape is looser here
        // and the PIPELINE is stricter — resolveCcaHeadTarget below proves the
        // account exists and returns the key a session actually produces.
        userID: ccaHeadTargetSchema,
        ccaID: z.number().int(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID); // I-5 re-read

      // RESOLVE FIRST, then use the resolved key for EVERYTHING below — the
      // guard, the roles read, the CcaHead row, the audit and the return. A
      // headship keyed on anything else is a headship the app cannot see.
      const targetUserID = await resolveCcaHeadTarget(ctx.db, input.userID);

      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        targetUserID,
      );

      const before = await getUserRoles(ctx.db, targetUserID);
      const after = await ctx.db.$transaction(async (tx) => {
        await tx.ccaHead.upsert({
          where: {
            userID_ccaID: { userID: targetUserID, ccaID: input.ccaID },
          },
          create: {
            userID: targetUserID,
            ccaID: input.ccaID,
            grantedBy: actorUserID,
          },
          update: { grantedBy: actorUserID },
        });
        return writeCcaHeadString(tx, targetUserID, true, actorUserID);
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: targetUserID,
        targetCcaID: input.ccaID,
        action: "ccaHead.grant",
        rolesBefore: before,
        rolesAfter: after,
        reason: input.reason,
      });
      return { userID: targetUserID, ccaID: input.ccaID, roles: after };
    }),

  revokeCcaHead: roleManagerProcedure
    .input(
      z.object({
        // DELIBERATELY THE RAW STORED KEY, NOT A RESOLVED ONE. Removing a
        // headship must always work, including one written under an odd key by
        // an older script — `CcaHead` already contains `CHUAMINGYUAN`. Resolving
        // here would make exactly those rows unremovable through the UI, which
        // is the opposite of what a revoke is for.
        userID: ccaHeadTargetSchema,
        ccaID: z.number().int(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        input.userID,
      );

      const before = await getUserRoles(ctx.db, input.userID);
      const after = await ctx.db.$transaction(async (tx) => {
        await tx.ccaHead.deleteMany({
          where: { userID: input.userID, ccaID: input.ccaID },
        });
        // CH-1: the string goes only when the LAST scope goes. A head of two
        // CCAs who is removed from one keeps the role.
        const remaining = await tx.ccaHead.count({
          where: { userID: input.userID },
        });
        return writeCcaHeadString(tx, input.userID, remaining > 0, actorUserID);
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        targetCcaID: input.ccaID,
        action: "ccaHead.revoke",
        rolesBefore: before,
        rolesAfter: after,
        reason: input.reason,
      });
      return { userID: input.userID, ccaID: input.ccaID, roles: after };
    }),

  /**
   * Succession. Both halves in ONE transaction — a transfer that grants without
   * revoking leaves two heads, and one that revokes without granting leaves a
   * CCA headless. Both audit rows carry the same batchId so the handover reads
   * as one event.
   */
  transferCcaHead: roleManagerProcedure
    .input(
      z.object({
        // FROM is the STORED key (see revokeCcaHead) so any existing head can
        // be transferred away; TO is resolved to a real account below, so the
        // new row is keyed on the value that person's session produces.
        fromUserID: ccaHeadTargetSchema,
        toUserID: ccaHeadTargetSchema,
        ccaID: z.number().int(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      // The SAME_USER check moved BELOW resolution: comparing the raw inputs
      // would miss "E1234567 -> e1234567@u.nus.edu", which are one person
      // spelled two ways, and would let a transfer delete a headship and
      // re-grant it to the same key.
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);

      // THE DESTINATION IS RESOLVED, THE SOURCE IS NOT. `toUserID` becomes a new
      // CcaHead row, so it must be the key that person's session produces —
      // otherwise the transfer hands the headship to a key nobody logs in as.
      // `fromUserID` is only ever used to DELETE, so it stays the raw stored
      // key and a row written under an odd key can still be moved off.
      const toUserID = await resolveCcaHeadTarget(ctx.db, input.toUserID);
      if (input.fromUserID === toUserID) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "SAME_USER" });
      }

      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        input.fromUserID,
      );
      await assertMayManageCcaHeadOf(
        ctx.db,
        actorUserID,
        actorRoles,
        toUserID,
      );

      const [beforeFrom, beforeTo] = await Promise.all([
        getUserRoles(ctx.db, input.fromUserID),
        getUserRoles(ctx.db, toUserID),
      ]);
      const batchId = randomUUID();

      const { afterFrom, afterTo } = await ctx.db.$transaction(async (tx) => {
        await tx.ccaHead.deleteMany({
          where: { userID: input.fromUserID, ccaID: input.ccaID },
        });
        await tx.ccaHead.upsert({
          where: {
            userID_ccaID: { userID: toUserID, ccaID: input.ccaID },
          },
          create: {
            userID: toUserID,
            ccaID: input.ccaID,
            grantedBy: actorUserID,
          },
          update: { grantedBy: actorUserID },
        });
        const remainingFrom = await tx.ccaHead.count({
          where: { userID: input.fromUserID },
        });
        return {
          afterFrom: await writeCcaHeadString(
            tx,
            input.fromUserID,
            remainingFrom > 0,
            actorUserID,
          ),
          afterTo: await writeCcaHeadString(
            tx,
            toUserID,
            true,
            actorUserID,
          ),
        };
      });

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.fromUserID,
        targetCcaID: input.ccaID,
        action: "ccaHead.transfer",
        rolesBefore: beforeFrom,
        rolesAfter: afterFrom,
        reason: input.reason,
        batchId,
      });
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: toUserID,
        targetCcaID: input.ccaID,
        action: "ccaHead.transfer",
        rolesBefore: beforeTo,
        rolesAfter: afterTo,
        reason: input.reason,
        batchId,
      });
      return { ccaID: input.ccaID, batchId };
    }),

  listCcaHeads: roleManagerProcedure
    .input(z.object({ ccaID: z.number().int().optional() }).default({}))
    .query(async ({ ctx, input }) => {
      return ctx.db.ccaHead.findMany({
        where: input.ccaID === undefined ? {} : { ccaID: input.ccaID },
        orderBy: [{ ccaID: "asc" }, { userID: "asc" }],
      });
    }),

  /* ---- bulk CCA-head onboarding (I-14, CH-1) -------------------------- */

  /**
   * The 89 CCAs, for the picker on the bulk CCA-head surface. A query (not a
   * mutation) because it is a small, static, read-only list — nothing here is
   * per-user and nothing is disclosive: a CCA's name and id are public in the
   * booking UI already.
   */
  listCcas: roleManagerProcedure.query(async ({ ctx }) => {
    const c = caps(ctx.session.user.roles);
    requireCapability(c, "manageCcaHeads");
    return ctx.db.cCA.findMany({
      select: { ccaID: true, ccaName: true, category: true },
      orderBy: { ccaName: "asc" },
    });
  }),

  /**
   * WHY THIS EXISTS SEPARATELY FROM previewBulkImport / commitBulkChunk.
   *
   * I-14: `cca_head` travels no generic path. It is absent from every
   * ASSIGNABLE_BY entry, so routing it through commitBulkChunk would not merely
   * be inelegant — every row would be DENIED by guard G4 with
   * USE_CCA_HEAD_ENDPOINT. The reason that guard exists is CH-1: a user holds
   * the `cca_head` string if and only if they have at least one CcaHead row,
   * and only a writer that maintains BOTH in one transaction can preserve that.
   * So this pair is built on `grantCcaHead`'s exact semantics — same capability
   * gate, same per-target guard, same I-5 re-read, same one transaction, same
   * `ccaHead.grant` audit action — with the preview/token/chunk machinery from
   * the generic bulk path layered on top. It adds NO new writer of either
   * `UserRole.roles` or `CcaHead`.
   *
   * NO BulkRoleImport HEADER IS CREATED for these batches, deliberately.
   * `undoBulkImport` reverses a batch by replaying its audit rows through
   * `assertCanMutateRoles` — the generic path — which cannot express `cca_head`
   * and would leave CcaHead rows orphaned from the role string if it ever
   * could. Not writing a header makes the CCA batch UNREACHABLE from undo
   * rather than merely un-clicked. Batch ownership is not lost by this: the
   * actor is inside every rowToken's HMAC, so one manager cannot drive
   * another's plan. The batchId is still stamped on every audit row, so
   * /admin/audit?batchId=… shows the whole run.
   *
   * Dry run in the strict sense: no transaction is opened and every guard call
   * passes dryRun, so a 200-row preview writes zero audit rows.
   */
  previewBulkCcaHeads: roleManagerProcedure
    .input(
      z.object({
        ccaID: z.number().int(),
        rows: z
          .array(
            z.object({
              lineNo: z.number().int().min(0),
              // A bounded plain string, not userIDSchema, for the same reason
              // previewBulkImport uses one: zod validates the whole object, so
              // a single typo'd identifier must not 400 the entire preview.
              identifier: z.string().trim().min(1).max(120),
            }),
          )
          .min(1)
          .max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      const actorUserID = ctx.session.user.userID;

      // Same directory-disclosure reasoning as previewBulkImport: this accepts
      // up to 1000 operator-supplied identifiers and returns each match's
      // identity. Its own limiter key, so onboarding CCA heads does not consume
      // the role-import preview budget or vice versa.
      const { rateLimit } = await import("~/lib/rateLimit");
      const rl = await rateLimit(`bulkccahead:${actorUserID}`, 20, 3600_000);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `RATE_LIMITED:${rl.retryAfter}`,
        });
      }

      // The ccaID must name a CCA THAT EXISTS. `CcaHead.ccaID` is a bare Int
      // with no referential integrity behind it, so a typo'd id would otherwise
      // write 30 scoped rows against a CCA that is not there — they would grant
      // the `cca_head` string, satisfy CH-1, and scope to nothing.
      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true, ccaName: true },
      });
      if (!cca) {
        throw new TRPCError({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
      }

      const batchId = randomUUID();
      const expiresAt = Date.now() + PLAN_TTL_MS;

      // bulkResolver, not resolveIdentifier: the bare shape test refused every
      // NUSNET id that is not E-format, i.e. a quarter of the hall. See its
      // comment for why the widened tier costs one query and why it is stricter
      // than the tier beside it rather than looser.
      const resolveRow = await bulkResolver(ctx.db, input.rows);
      const resolved = input.rows.map((r) => ({
        row: r,
        hit: resolveRow(r.identifier),
      }));
      const ids = [
        ...new Set(resolved.map((r) => r.hit?.userID).filter(Boolean)),
      ] as string[];

      const [roleRows, users, existingHeads] = await Promise.all([
        ctx.db.userRole.findMany({ where: { userID: { in: ids } } }),
        ctx.db.user.findMany({
          where: {
            email: {
              in: ids.map((i) => `${i.toLowerCase()}@u.nus.edu`),
              mode: "insensitive",
            },
          },
          select: { id: true, email: true, displayName: true, block: true },
        }),
        ctx.db.ccaHead.findMany({
          where: { ccaID: input.ccaID, userID: { in: ids } },
          select: { userID: true },
        }),
      ]);
      const rolesByID = new Map(
        roleRows.map((r) => [
          r.userID,
          (r.roles?.length ? r.roles : r.role ? [r.role] : []).filter(
            isGrantableRole,
          ),
        ]),
      );
      // C9: absent keys dropped rather than stored under a sentinel — the same
      // S5 lookup hazard the other preview maps document.
      const userByID = new Map<string, (typeof users)[number]>(
        users.flatMap((u) => {
          const cid = canonicalUserID(u.email);
          return cid === null ? [] : [[cid, u] as const];
        }),
      );
      const alreadyHead = new Set(existingHeads.map((h) => h.userID));

      const items = await Promise.all(
        resolved.map(async ({ row, hit }) => {
          const base = { lineNo: row.lineNo, identifier: row.identifier };
          if (!hit) {
            return {
              ...base,
              status: "denied" as const,
              denyReason: "UNRESOLVED_IDENTIFIER",
            };
          }

          try {
            await assertMayManageCcaHeadOf(
              ctx.db,
              actorUserID,
              // The SESSION roles are fine for the dry run: this call decides
              // nothing and writes nothing. The commit re-reads from the DB
              // (I-5) and is the only place the answer is acted on.
              ctx.session.user.roles ?? [],
              hit.userID,
              { dryRun: true },
            );
          } catch (err) {
            if (err instanceof DryRunDenied) {
              return {
                ...base,
                status: "denied" as const,
                denyReason: err.denyReason,
                userID: hit.userID,
              };
            }
            throw err;
          }

          const before = rolesByID.get(hit.userID) ?? [];
          const u = userByID.get(hit.userID);
          const redact = (rs: string[]) =>
            c.seeAdminIdentities ? rs : rs.filter((r) => r !== ADMIN_ROLE);
          return {
            ...base,
            status: "ok" as const,
            userID: hit.userID,
            via: hit.via,
            confidence: "high" as const,
            /** True => committing this row is a no-op, not a new headship. */
            alreadyHead: alreadyHead.has(hit.userID),
            // Masked on rows where the operator did not themselves supply the
            // address, exactly as previewBulkImport does.
            email: hit.via === "email" ? (u?.email ?? null) : null,
            displayName: u?.displayName ?? null,
            block: u?.block ?? null,
            hasAccount: Boolean(u),
            rolesBefore: redact(before),
            rolesAfter: redact([...new Set([...before, CCA_HEAD_ROLE])]),
            expectedBefore: before,
            rowToken: signRow({
              batchId,
              actorUserID,
              expiresAt,
              // THE CCA IS INSIDE THE SIGNATURE. `mode` is the field
              // commitBulkChunk re-derives from its own header precisely so a
              // plan cannot be committed under semantics nobody reviewed; here
              // the semantics include WHICH CCA. A plan previewed against
              // "Basketball" therefore cannot be replayed against "Welfare" —
              // every rowToken would fail. It also domain-separates these
              // tokens from generic-path ones, whose mode is only "add"/"set",
              // so neither surface can ever consume the other's plan.
              mode: `ccaHead:${input.ccaID}`,
              userID: hit.userID,
              roles: [CCA_HEAD_ROLE],
              expectedBefore: before,
              via: hit.via,
              confidence: "high",
            }),
          };
        }),
      );

      return {
        batchId,
        ccaID: cca.ccaID,
        ccaName: cca.ccaName,
        expiresAt,
        items,
      };
    }),

  /**
   * Capped at 10 rows, sized against the SAME MEASURED cost as
   * `_lib/planClient.ts`'s CHUNK: audit timestamps from a real import put a row
   * at roughly 2s, not the 300ms that was once estimated and that killed an
   * 11-row import at row 7. A CCA-head row is the same shape of work — a guard
   * read, a before read, one transaction, one audit write — so it is budgeted
   * identically: 10 x ~2s ~= 20s, inside the `maxDuration = 60` the tRPC route
   * now exports. Re-measure from audit timestamps, never from a per-query
   * estimate, before raising it.
   *
   * GUARDS APPLY PER ROW, NEVER PER BATCH, and partial success is the expected
   * outcome — a list containing one admin returns CANNOT_MODIFY_AN_ADMIN for
   * that row and grants the rest.
   */
  commitBulkCcaHeadChunk: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        ccaID: z.number().int(),
        expiresAt: z.number().int(),
        rows: z
          .array(
            z.object({
              lineNo: z.number().int().min(0),
              userID: z.string().trim().max(120),
              expectedBefore: roleSchema.array().max(8),
              via: z.string().max(16),
              confidence: z.string().max(16),
              rowToken: z.string().max(128),
            }),
          )
          .min(1)
          .max(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "manageCcaHeads");
      const actorUserID = ctx.session.user.userID;
      // I-5: the ACTOR's roles come from the database, not the session, so a
      // manager demoted mid-import stops being one immediately.
      const actorRoles = await getUserRoles(ctx.db, actorUserID);

      if (input.expiresAt < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "PLAN_EXPIRED" });
      }
      // Re-validated at commit, not only at preview: the ccaID is a client
      // input on this call too, and a CCA can be deleted between the two.
      const cca = await ctx.db.cCA.findUnique({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca) {
        throw new TRPCError({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
      }

      const results: {
        lineNo: number;
        userID: string;
        status: "ok" | "noop" | "denied";
        denyReason?: string;
      }[] = [];
      let lastLineNo = -1;

      for (const row of input.rows) {
        // Re-verified against the signature the server itself produced. The
        // ccaID is re-derived from THIS request's input, so a plan previewed
        // for another CCA fails here rather than being applied to a CCA nobody
        // reviewed. There is no client-supplied `mode` to trust.
        const expectedToken = signRow({
          batchId: input.batchId,
          actorUserID,
          expiresAt: input.expiresAt,
          mode: `ccaHead:${input.ccaID}`,
          userID: row.userID,
          roles: [CCA_HEAD_ROLE],
          expectedBefore: row.expectedBefore,
          via: row.via,
          confidence: row.confidence,
        });
        if (!tokenMatches(expectedToken, row.rowToken)) {
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "denied",
            denyReason: "PLAN_TOKEN_INVALID",
          });
          continue;
        }
        if (row.confidence !== "high") {
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "denied",
            denyReason: "LOW_CONFIDENCE_NOT_CONFIRMED",
          });
          continue;
        }

        try {
          // The same target guard grantCcaHead uses, on the same live actor
          // roles. It audits its own denial (on ctx.db, outside any tx — I-15)
          // and stamps the batch, then throws.
          await assertMayManageCcaHeadOf(
            ctx.db,
            actorUserID,
            actorRoles,
            row.userID,
            { batchId: input.batchId },
          );

          // There is no CONFLICT_ROLES_CHANGED check here and that is
          // deliberate, not an omission. The generic path needs one because its
          // write is a SET: a role gained between preview and commit would be
          // silently removed. This write is purely ADDITIVE and idempotent, so
          // drift cannot cost the target anything. The one drift that IS
          // security-relevant — the target acquiring `admin` — is caught by the
          // guard above, which re-reads the target's roles right now.
          const before = await getUserRoles(ctx.db, row.userID);
          const existing = await ctx.db.ccaHead.findUnique({
            where: {
              userID_ccaID: { userID: row.userID, ccaID: input.ccaID },
            },
            select: { id: true },
          });

          // CH-1, byte for byte the body of grantCcaHead: the scoped CcaHead
          // row and the `cca_head` string are written in ONE transaction, by
          // writeCcaHeadString, which is the only writer of that string. Do not
          // hoist either half out of the transaction.
          const after = await ctx.db.$transaction(async (tx) => {
            await tx.ccaHead.upsert({
              where: {
                userID_ccaID: { userID: row.userID, ccaID: input.ccaID },
              },
              create: {
                userID: row.userID,
                ccaID: input.ccaID,
                grantedBy: actorUserID,
              },
              update: { grantedBy: actorUserID },
            });
            return writeCcaHeadString(tx, row.userID, true, actorUserID);
          });

          await writeAudit(ctx.db, {
            actorUserID,
            actorRoles,
            targetUserID: row.userID,
            targetCcaID: input.ccaID,
            action: "ccaHead.grant",
            rolesBefore: before,
            rolesAfter: after,
            batchId: input.batchId,
          });
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            // Reported honestly: the row was applied either way (the upsert is
            // idempotent), but the operator asked what CHANGED.
            status: existing ? "noop" : "ok",
          });
        } catch (err) {
          // A per-row denial is data, not an exception — one refused row must
          // not abort the other nine. The guard has already written its audit
          // row on ctx.db, so nothing is lost here.
          if (err instanceof TRPCError) {
            results.push({
              lineNo: row.lineNo,
              userID: row.userID,
              status: "denied",
              denyReason: err.message,
            });
          } else {
            throw err;
          }
        }
        lastLineNo = row.lineNo;
      }

      // Returned so a chunk killed by the platform timeout resumes from here
      // rather than being retried blind.
      return { batchId: input.batchId, lastLineNo, results };
    }),

  /* ---- triage, health, flags ----------------------------------------- */

  /**
   * Closes the "admin bypass masks everything" testing hole: canBookWithRoles
   * returns true for admin BEFORE consulting requirements, so the person
   * running the rollout cannot reproduce any resident-side failure from their
   * own session. Audited because it is an enumeration primitive over the whole
   * user base.
   */
  explainAccess: roleManagerProcedure
    // Widened to the EXT namespace: read-only, roleManagerProcedure, and
    // already audited on every call. It is the ONLY tool for triaging "why
    // can't the hall office book room N", so leaving it E-format-only would
    // make the one account this phase exists for the one account nobody can
    // debug.
    .input(
      z.object({ userID: roleTargetUserIDSchema, facilityID: z.number().int() }),
    )
    .query(async ({ ctx, input }) => {
      const [decision, requiredRoles, roles] = await Promise.all([
        // No email argument, deliberately: this evaluates AS the target, and
        // inspecting a user must not mint them a baseline as a side effect of
        // being inspected. It therefore shows the target's REAL stored state,
        // which is exactly what makes it useful for triaging a NOT_RESIDENT
        // report.
        evaluateBooking(ctx.db, input.userID, input.facilityID),
        getFacilityRequiredRoles(ctx.db, input.facilityID),
        getUserRoles(ctx.db, input.userID),
      ]);
      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        targetUserID: input.userID,
        targetFacilityID: input.facilityID,
        action: "explainAccess",
      });
      return { decision, requiredRoles, roles };
    }),

  /**
   * The detection surface. Aggregate counts for managers; per-user identifier
   * lists are account-integrity data and are admin-only.
   */
  systemHealth: roleManagerProcedure.query(async ({ ctx }) => {
    const c = caps(ctx.session.user.roles);
    const [facilities, access, mode, shadow24h, baselineMissing] =
      await Promise.all([
        ctx.db.facilities.findMany({
          select: { facilityID: true, facilityName: true },
        }),
        ctx.db.facilityAccess.findMany({
          select: { facilityID: true, requiredRoles: true },
        }),
        getEnforcementMode(ctx.db),
        ctx.db.roleAuditLog.count({
          where: {
            action: "booking.denied.shadow",
            at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
          },
        }),
        // RED LINE, not a materialization gap. Scoped to NUS-emailed User rows
        // ONLY: counting ineligible accounts (test@, aaaaaa@) makes a number
        // that can never reach zero, and per I-16's corollary a gate that
        // cannot reach zero gets muted — which deletes the detector.
        //
        // A TRUE SET DIFFERENCE OVER THE CANONICAL KEY, never a subtraction of
        // two counts. `eligible - held` was wrong twice over and the two errors
        // CANCEL, which is the dangerous part:
        //   - `held` counted every UserRole row bearing `resident`, INCLUDING
        //     rows orphaned by merge-accounts.mjs (the losing User row is
        //     deleted, its UserRole row survives). Each orphan hides one real
        //     victim.
        //   - `contains: "@u.nus.edu"` is unanchored, so it also matches
        //     bob@u.nus.edu.evil.com — disagreeing with the anchored predicate
        //     that actually decides who receives a baseline.
        // Two disjoint populations of equal size read as 0, the operator sees a
        // green red-line, flips to `enforce`, and a genuinely eligible user
        // whose baseline write failed (L-6) is denied on every normal room with
        // no signal naming them. I-16: every gate NAMES the offenders, so this
        // returns the ids too, not just a count.
        (async () => {
          const [users, roleRows] = await Promise.all([
            ctx.db.user.findMany({ select: { email: true } }),
            ctx.db.userRole.findMany({
              // Legacy-tolerant, matching getUserRoles: a row still carrying
              // only the singular `role` holds the baseline just as truly.
              where: {
                OR: [
                  { roles: { has: BASELINE_ROLE } },
                  { role: BASELINE_ROLE },
                ],
              },
              select: { userID: true },
            }),
          ]);
          // Same predicate + same canonicalisation the grant path uses, so the
          // two sides are scoped to one population and the gate can reach zero.
          const eligible = new Set(
            users
              .filter((u) => isNusStudentEmail(u.email))
              .map((u) => canonicalUserID(u.email))
              // C9: type-only. `.filter(Boolean)` already dropped absent ids at
              // runtime; the predicate lets the compiler see it. Note the
              // `isNusStudentEmail` filter above already makes this total.
              .filter((id): id is CanonicalUserID => id !== null),
          );
          const held = new Set(roleRows.map((r) => r.userID));
          const missing = [...eligible].filter((id) => !held.has(id)).sort();
          return missing;
        })(),
      ]);
    const configured = new Set(access.map((a) => a.facilityID));
    const unconfigured = facilities.filter(
      (f) => f.facilityID !== -1 && !configured.has(f.facilityID),
    );
    return {
      enforcementMode: mode,
      shadowDenials24h: shadow24h,
      facilities: facilities.length,
      unconfiguredFacilities: unconfigured.length,
      /**
       * RED LINE. Under the stored baseline a non-zero value is a LIVE LOCKOUT
       * of that many eligible users, not an advisory materialization gap. Do
       * not flip enforcement to `enforce` while it is non-zero.
       */
      residentBaselineMissing: baselineMissing.length,
      /**
       * L-6's only detector. `baseline_repair_failed` is a structured console
       * log today, so this stays null until those logs are shipped to a
       * queryable sink; until then, grep the platform logs for that `evt`.
       * Kept in the payload rather than omitted so the panel has a slot for it
       * and it cannot be quietly forgotten.
       */
      baselineRepairFailures24h: null as number | null,
      adminRolesStoredOnFacilities: access.filter((a) =>
        a.requiredRoles?.includes(ADMIN_ROLE),
      ).length,
      /**
       * I-16 — the gate NAMES the offenders. A bare count tells the operator
       * something is wrong but not who, so the only available response is to
       * wait and re-check. Admin-only, like `unconfigured`: this is a list of
       * per-user identifiers, i.e. account-integrity data.
       */
      detail: c.viewSystemHealthDetail
        ? { unconfigured, residentBaselineMissingIDs: baselineMissing }
        : null,
    };
  }),

  setEnforcementMode: adminProcedure
    .input(
      z.object({
        mode: z.enum(["off", "permissive", "enforce"]),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.systemFlag.upsert({
        where: { key: "rbac.booking.enforcement" },
        create: {
          key: "rbac.booking.enforcement",
          value: input.mode,
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
        update: {
          value: input.mode,
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
      });
      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        action: "enforcement.set",
        reason: input.reason,
        rolesAfter: [input.mode],
      });
      // Takes effect within the 15s per-lambda cache TTL. No redeploy.
      return { mode: input.mode };
    }),

  /* ---------------------------------------------------------------------- */
  /* THE D-7 BREAK-GLASS ALLOWLIST (AuthAllowlist)                           */
  /*                                                                         */
  /* THE MOST DANGEROUS SURFACE IN THIS FILE, and the only one that creates  */
  /* an IDENTITY rather than moving a privilege around on top of one. A row  */
  /* here is what lets a non-@u.nus.edu address hold a session key at all.   */
  /*                                                                         */
  /* Read services/authAllowlist.ts before changing anything below — it      */
  /* states the attack (05-verification.md:164) and the four mechanisms.     */
  /* These procedures are M4, the LAST of the four, and the weakest: they    */
  /* only govern the writes they can see. M1 (the ':' making the namespaces  */
  /* provably disjoint) and M2 (re-validation at every READ) are what make a */
  /* row hand-typed into Atlas mint nothing. Do not weaken these on the      */
  /* grounds that M2 exists, and do not weaken M2 on the grounds that these  */
  /* exist.                                                                  */
  /*                                                                         */
  /* adminProcedure throughout — NOT roleManagerProcedure and NOT            */
  /* scrcProcedure. An scrc holder must not see or edit the collection that  */
  /* issued its own identity.                                                */
  /*                                                                         */
  /* THERE IS DELIBERATELY NO UPDATE MUTATION. A pin is immutable; changing  */
  /* which address owns a key is remove-then-add, i.e. two audit rows and    */
  /* two deliberate acts.                                                    */
  /* ---------------------------------------------------------------------- */

  listAuthAllowlist: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.authAllowlist.findMany({
      orderBy: { addedAt: "desc" },
      // No cursor. This collection is meant to hold single digits; if it ever
      // needs paging, that fact is itself the alert. The cap is a bound, not a
      // page size.
      take: 100,
    });

    // Hydrate what the operator actually needs to answer "is this pin doing
    // anything, and to whom" — WITHOUT which the panel is a list of opaque
    // strings and the natural next step is to go poke at Mongo by hand.
    const emails = rows.map((r) => r.email);
    const [users, roleRows] = await Promise.all([
      ctx.db.user.findMany({
        where: { email: { in: emails, mode: "insensitive" } },
        // NEVER a bare findMany — passwordHash must not reach the client, and a
        // passwordHash-less row throws on a full read (I-2). Same rule as
        // listUsers.
        select: { email: true, displayName: true, userID: true },
      }),
      ctx.db.userRole.findMany({
        where: { userID: { in: rows.map((r) => r.pinnedUserID) } },
        select: { userID: true, roles: true, role: true },
      }),
    ]);
    const byEmail = new Map(
      users.map((u) => [normalizeEmail(u.email), u] as const),
    );
    const byPin = new Map(roleRows.map((r) => [r.userID, r] as const));

    return {
      items: rows.map((r) => {
        const u = byEmail.get(normalizeEmail(r.email));
        const rr = byPin.get(r.pinnedUserID);
        return {
          email: r.email,
          pinnedUserID: r.pinnedUserID,
          /**
           * M2 SURFACED TO THE OPERATOR. A stored pin outside the namespace
           * mints no identity — the session path drops it silently — so
           * without this flag the panel would show a row that looks live and
           * is not, and the only symptom would be a user who cannot log in.
           * It can only arise from a hand edit in Atlas or a code path that
           * bypassed the zod schema; either way the operator should see it.
           */
          namespaceViolation: !isExtUserID(r.pinnedUserID),
          note: r.note,
          addedBy: r.addedBy,
          addedAt: r.addedAt,
          hasUser: Boolean(u),
          displayName: u?.displayName ?? null,
          /**
           * True when the provisioned `User.userID` does NOT hold the pin.
           * Cosmetic-looking, load-bearing: facilitiesBooking joins
           * booking -> owner on `User.userID`, so a mismatch renders every
           * hall-office booking with a blank owner name.
           */
          keyMismatch: Boolean(u && u.userID !== r.pinnedUserID),
          roles: rr?.roles?.length ? rr.roles : rr?.role ? [rr.role] : [],
        };
      }),
    };
  }),

  addAuthAllowlistEntry: adminProcedure
    .input(
      z.object({
        email: z
          .string()
          .trim()
          .email()
          .max(254)
          // I-12: THE shared normalizer, applied at the boundary so the stored
          // value matches `User.email` byte for byte. `email_unique_ci` folds
          // CASE but not WHITESPACE, so a stray space here is a row that can
          // never be joined to its account.
          .transform(normalizeEmail),
        pinnedUserID: extUserIDSchema,
        note: z.string().trim().max(200).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const actorRoles = ctx.session.user.roles ?? [];

      const refuse = async (reason: string, code: TRPCError["code"]) => {
        // Audited BEFORE throwing, on the same argument writeAudit's other
        // callers make (I-15): there is no state change to lose, and a probing
        // attempt at the IDENTITY-ISSUING surface is exactly what must leave a
        // trail.
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: input.pinnedUserID,
          action: "denied",
          reason: input.email,
          ok: false,
          denyReason: reason,
        });
        throw new TRPCError({ code, message: reason });
      };

      /* REFUSAL 1 — EMAIL_IS_CANONICAL.
       * The address already HAS an identity: canonicalUserID derives one from
       * it, and every UserRole/Booking/UserMatric row this human owns is filed
       * under that. Pinning it to an EXT key would give ONE HUMAN TWO
       * IDENTITIES, which is the duplicate-account failure the whole
       * merge-by-canonical toolchain exists to clean up — except this time
       * issued deliberately, by an admin, in one click.
       *
       * `isNusStudentEmail` rather than `canonicalUserID(...) !== null` because
       * the two are exactly equivalent (asserted per fixture by the parity
       * gate) and this reads as the question being asked. */
      if (isNusStudentEmail(input.email)) {
        await refuse("EMAIL_IS_CANONICAL", "BAD_REQUEST");
      }

      /* REFUSAL 2 — PIN_ALREADY_HAS_ROLES.
       * DEFENCE IN DEPTH BEHIND M3. If a UserRole row already exists under
       * this key, then either it is a live privileged identity (in which case
       * this call is an attempt to re-aim it at a new address — THE attack,
       * one namespace over) or it is residue from a removed pin (in which case
       * the roles must be revoked through the audited role path first, so the
       * new holder does not inherit them silently).
       *
       * The unique index (M3) already stops a SECOND row for the same pin.
       * This refusal is what covers the case where the first row was deleted
       * and its roles were not — the exact 07-cca-future.md §5 hazard that
       * userAdmin's PINNED_ALLOWLIST_ACCOUNT refusal guards from the other
       * direction. Two locks, opposite doors. */
      if ((await getUserRoles(ctx.db, input.pinnedUserID)).length > 0) {
        await refuse("PIN_ALREADY_HAS_ROLES", "CONFLICT");
      }

      /* REFUSAL 3 — the unique indexes, i.e. M3 SURFACING.
       * Deliberately NOT a pre-read: a findFirst-then-create is a TOCTOU, and
       * the index is the thing that actually decides. Catch P2002 and
       * translate, so the operator gets a sentence instead of a Prisma dump —
       * and so a MISSING index (create-auth-allowlist.mjs never run) shows up
       * as "the second insert succeeded", which rbac-doctor's uniqueness check
       * then reports from the data. */
      try {
        await ctx.db.authAllowlist.create({
          data: {
            email: input.email,
            pinnedUserID: input.pinnedUserID,
            note: input.note ?? null,
            addedBy: actorUserID,
          },
        });
      } catch (err) {
        if ((err as { code?: string } | null)?.code !== "P2002") throw err;
        // WHICH index rejected it is determined FROM THE DATA, not from
        // `err.meta.target`. On the Mongo connector that field is unreliable —
        // it can be the index name, the field list, or absent — and getting it
        // wrong here means telling the operator to fix the wrong half of the
        // row. Two indexed reads, on a path that has already failed and is
        // about to throw, buys a message that is actually true.
        const [emailTaken, pinTaken] = await Promise.all([
          ctx.db.authAllowlist.findUnique({
            where: { email: input.email },
            select: { id: true },
          }),
          ctx.db.authAllowlist.findUnique({
            where: { pinnedUserID: input.pinnedUserID },
            select: { id: true },
          }),
        ]);
        // If NEITHER probe finds a row, the conflicting document was removed
        // between the failed insert and these reads. Refuse anyway — the write
        // did not happen, and "retry" is the honest instruction.
        await refuse(
          emailTaken
            ? "EMAIL_ALREADY_PINNED"
            : pinTaken
              ? "PIN_ALREADY_USED"
              : "ALLOWLIST_CONFLICT",
          "CONFLICT",
        );
      }

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.pinnedUserID,
        action: "authAllowlist.add",
        // The pinned ADDRESS goes in `reason`: RoleAuditLog has no email
        // column, and "which address was handed this key" is the one fact this
        // row exists to preserve.
        reason: input.email,
      });

      // WITHOUT THIS the new pin is invisible for up to 15 seconds — including
      // to the very next page the operator loads — and the natural response is
      // to click Add again.
      resetAuthAllowlistCache();
      return { email: input.email, pinnedUserID: input.pinnedUserID };
    }),

  removeAuthAllowlistEntry: adminProcedure
    .input(
      z.object({
        pinnedUserID: extUserIDSchema,
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const actorRoles = ctx.session.user.roles ?? [];

      const refuse = async (reason: string, code: TRPCError["code"]) => {
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: input.pinnedUserID,
          action: "denied",
          ok: false,
          denyReason: reason,
        });
        throw new TRPCError({ code, message: reason });
      };

      const row = await ctx.db.authAllowlist.findUnique({
        where: { pinnedUserID: input.pinnedUserID },
      });
      if (!row) await refuse("NO_SUCH_PIN", "NOT_FOUND");

      /* PIN_STILL_HOLDS_ROLES.
       * Removing the pin revokes the IDENTITY but leaves the UserRole document
       * standing under that key. Re-issuing the same pin to a different address
       * later — or re-creating a User row on the old one — would then hand the
       * new holder the old holder's roles with no grant path and therefore no
       * escalation guard firing. That is 07-cca-future.md §5's hazard, and it
       * is the same shape as the attack this whole collection is designed
       * against.
       *
       * The remedy is two ordered, separately audited acts: revoke the roles
       * through admin.setUserRoles, THEN remove the pin. Refusing here is what
       * forces that order. */
      if ((await getUserRoles(ctx.db, input.pinnedUserID)).length > 0) {
        await refuse("PIN_STILL_HOLDS_ROLES", "CONFLICT");
      }

      await ctx.db.authAllowlist.delete({
        where: { pinnedUserID: input.pinnedUserID },
      });
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.pinnedUserID,
        action: "authAllowlist.remove",
        reason: input.reason ?? row?.email,
      });
      // Revocation must be LIVE. Without this the removed identity keeps
      // resolving for up to 15 seconds after the operator was told it was gone.
      resetAuthAllowlistCache();
      return { pinnedUserID: input.pinnedUserID };
    }),

  listAuditLog: adminProcedure
    .input(
      z.object({
        // Widened to the EXT namespace. Read-only, adminProcedure. Without it
        // the audit trail FOR the hall office cannot be filtered — on the one
        // surface whose entire purpose is oversight of this role, and for the
        // one principal whose identity was issued by hand.
        targetUserID: roleTargetUserIDSchema.optional(),
        actorUserID: roleTargetUserIDSchema.optional(),
        action: z.string().max(32).optional(),
        batchId: z.string().max(64).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.roleAuditLog.findMany({
        where: {
          ...(input.targetUserID ? { targetUserID: input.targetUserID } : {}),
          ...(input.actorUserID ? { actorUserID: input.actorUserID } : {}),
          ...(input.action ? { action: input.action } : {}),
          ...(input.batchId ? { batchId: input.batchId } : {}),
        },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        orderBy: { at: "desc" },
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page,
        nextCursor:
          rows.length > input.limit
            ? (page[page.length - 1]?.id ?? null)
            : null,
      };
    }),

  /* ---- facility access (admin only) ---------------------------------- */

  listFacilityAccess: adminProcedure.query(async ({ ctx }) => {
    const [facilities, access] = await Promise.all([
      ctx.db.facilities.findMany({ orderBy: { facilityID: "asc" } }),
      ctx.db.facilityAccess.findMany(),
    ]);
    const byID = new Map(access.map((a) => [a.facilityID, a]));
    return facilities.map((f) => {
      const a = byID.get(f.facilityID);
      const stored = a?.requiredRoles?.length
        ? a.requiredRoles
        : a?.requiredRole
          ? [a.requiredRole]
          : [];
      return {
        facilityID: f.facilityID,
        facilityName: f.facilityName,
        requiredRoles: stored.length ? stored : [BASELINE_ROLE],
        /**
         * True = never configured. Under D-1 it defaults to resident, so this
         * is a config gap to surface, not a lockout.
         */
        unconfigured: !a,
      };
    });
  }),

  /**
   * adminProcedure, NOT roleManagerProcedure: a jcrc must not be able to gate
   * every room behind `jcrc`, nor to open SCRC to everyone.
   */
  setFacilityAccess: adminProcedure
    .input(
      z.object({
        facilityID: z.number().int(),
        requiredRoles: facilityRoleSchema.array().min(1).max(8),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const facility = await ctx.db.facilities.findUnique({
        where: { facilityID: input.facilityID },
      });
      if (!facility) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Facility not found",
        });
      }

      const existing = await ctx.db.facilityAccess.findUnique({
        where: { facilityID: input.facilityID },
      });
      const before = existing?.requiredRoles?.length
        ? existing.requiredRoles
        : existing?.requiredRole
          ? [existing.requiredRole]
          : [];
      const roles = [...new Set(input.requiredRoles)];

      await ctx.db.facilityAccess.upsert({
        where: { facilityID: input.facilityID },
        // The legacy mirror is set to "" on INSERT and left UNTOUCHED on
        // UPDATE. Rationale: a newly created row must read as falsy to the
        // still-deployed pre-v2 access.ts (preserving today's open-by-default),
        // while an existing gated row (SCRC) keeps its real legacy value so a
        // revert does not silently un-gate it. The sentinel is "" and not null
        // because the old deployed client throws on absence and on null (I-9).
        create: {
          facilityID: input.facilityID,
          requiredRoles: roles,
          requiredRole: "",
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
        update: {
          requiredRoles: roles,
          updatedAt: new Date(),
          updatedBy: ctx.session.user.userID,
        },
      });

      await writeAudit(ctx.db, {
        actorUserID: ctx.session.user.userID,
        actorRoles: ctx.session.user.roles ?? [],
        targetFacilityID: input.facilityID,
        action: "facilityAccess.set",
        rolesBefore: before,
        rolesAfter: roles,
      });
      return { facilityID: input.facilityID, requiredRoles: roles };
    }),

  /* ---- bulk operations (D-8) ----------------------------------------- */

  /**
   * A `.mutation()`, NOT a `.query()`, and this is not a style choice:
   * `src/trpc/react.tsx` uses unstable_httpBatchStreamLink with no
   * methodOverride, so queries are GET with the input serialized into the
   * querystring — 1000 CSV rows is ~1 MB of URL and 414s long before that. The
   * no-write property is preserved STRUCTURALLY instead: this body opens no
   * transaction and passes dryRun: true to every guard call, so not one audit
   * row is written for a 500-row preview containing 40 denials (I-15's inverse
   * case).
   */
  previewBulkImport: roleManagerProcedure
    .input(
      z.object({
        mode: z.enum(["add", "set"]),
        rows: z
          .array(
            z.object({
              lineNo: z.number().int().min(0),
              /**
               * A plain bounded string, NOT userIDSchema: zod validates the
               * whole input object, so one malformed identifier in a regex
               * field would 400 the entire 1000-row preview. Unresolvable rows
               * are reported per row instead.
               */
              identifier: z.string().trim().min(1).max(120),
              roles: roleSchema.array().max(8),
            }),
          )
          .min(1)
          .max(1000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      const actorUserID = ctx.session.user.userID;

      // Preview is a DIRECTORY-DISCLOSURE surface: it accepts up to 1000
      // operator-supplied identifiers and returns each match's email, name and
      // role set. Rate-limited per actor per hour on the existing DB-backed
      // limiter.
      const { rateLimit } = await import("~/lib/rateLimit");
      const rl = await rateLimit(`bulkpreview:${actorUserID}`, 20, 3600_000);
      if (!rl.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `RATE_LIMITED:${rl.retryAfter}`,
        });
      }

      const batchId = randomUUID();
      const expiresAt = Date.now() + PLAN_TTL_MS;

      // bulkResolver, not resolveIdentifier: the bare shape test refused every
      // NUSNET id that is not E-format, i.e. a quarter of the hall. See its
      // comment for why the widened tier costs one query and why it is stricter
      // than the tier beside it rather than looser.
      const resolveRow = await bulkResolver(ctx.db, input.rows);
      const resolved = input.rows.map((r) => ({
        row: r,
        hit: resolveRow(r.identifier),
      }));
      const ids = [
        ...new Set(resolved.map((r) => r.hit?.userID).filter(Boolean)),
      ] as string[];

      const [roleRows, users] = await Promise.all([
        ctx.db.userRole.findMany({ where: { userID: { in: ids } } }),
        ctx.db.user.findMany({
          where: {
            email: {
              in: ids.map((i) => `${i.toLowerCase()}@u.nus.edu`),
              mode: "insensitive",
            },
          },
          select: { id: true, email: true, displayName: true, block: true },
        }),
      ]);
      const rolesByID = new Map(
        roleRows.map((r) => [
          r.userID,
          (r.roles?.length ? r.roles : r.role ? [r.role] : []).filter(
            isGrantableRole,
          ),
        ]),
      );
      // C9: same S5 hazard as listPendingGrants' map — drop absent keys instead
      // of storing one under a sentinel. `hit.userID` (from resolveIdentifier)
      // is a real E-format id or a canonicalized one, never absent, so this
      // changes no reachable lookup today.
      const userByID = new Map<string, (typeof users)[number]>(
        users.flatMap((u) => {
          const cid = canonicalUserID(u.email);
          return cid === null ? [] : [[cid, u] as const];
        }),
      );

      const items = await Promise.all(
        resolved.map(async ({ row, hit }) => {
          const base = { lineNo: row.lineNo, identifier: row.identifier };
          if (!hit) {
            return {
              ...base,
              status: "denied" as const,
              denyReason: "UNRESOLVED_IDENTIFIER",
            };
          }
          const before = rolesByID.get(hit.userID) ?? [];
          const after =
            input.mode === "add"
              ? [...new Set([...before, ...row.roles])]
              : [...new Set(row.roles)];

          try {
            await assertCanMutateRoles({
              db: ctx.db,
              actorUserID,
              targetUserID: hit.userID,
              requestedRoles: after,
              dryRun: true, // <- the whole no-audit property
            });
          } catch (err) {
            if (err instanceof DryRunDenied) {
              return {
                ...base,
                status: "denied" as const,
                denyReason: err.denyReason,
                userID: hit.userID,
              };
            }
            throw err;
          }

          const u = userByID.get(hit.userID);
          const redact = (rs: string[]) =>
            c.seeAdminIdentities ? rs : rs.filter((r) => r !== ADMIN_ROLE);
          return {
            ...base,
            status: "ok" as const,
            userID: hit.userID,
            via: hit.via,
            confidence: "high" as const,
            // Mask the address on rows where the operator did not themselves
            // supply it — resolving an E-id must not become an email harvest.
            email: hit.via === "email" ? (u?.email ?? null) : null,
            displayName: u?.displayName ?? null,
            block: u?.block ?? null,
            hasAccount: Boolean(u),
            rolesBefore: redact(before),
            rolesAfter: redact(after),
            expectedBefore: before,
            rowToken: signRow({
              batchId,
              actorUserID,
              expiresAt,
              mode: input.mode,
              userID: hit.userID,
              roles: row.roles,
              expectedBefore: before,
              via: hit.via,
              confidence: "high",
            }),
          };
        }),
      );

      return { batchId, mode: input.mode, expiresAt, items };
    }),

  beginBulkImport: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        mode: z.enum(["add", "set"]),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      await ctx.db.bulkRoleImport.create({
        data: {
          batchId: input.batchId,
          actorUserID: ctx.session.user.userID,
          actorRoles: ctx.session.user.roles ?? [],
          mode: input.mode,
          note: input.note ?? null,
        },
      });
      return { batchId: input.batchId };
    }),

  /**
   * Capped at 25 rows: at ~5 Atlas round-trips per row (role reads, guard
   * reads, the transaction, the audit) at ~60ms, 25 rows is ~7.5s against a
   * Vercel ceiling of 10-15s. The client loops chunks under one batchId.
   *
   * GUARDS APPLY PER ROW, NEVER PER BATCH. A jcrc's import containing one admin
   * target returns CANNOT_MODIFY_AN_ADMIN for that row and succeeds on the
   * other 24 — partial failure is the expected outcome, not an error condition.
   * This is also what makes bulk sticky (I-8c): there is no second write path,
   * so replace-mode's safety comes from the chokepoint, not from any
   * client-side "compute the after set" helper.
   */
  commitBulkChunk: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        expiresAt: z.number().int(),
        rows: z
          .array(
            z.object({
              lineNo: z.number().int().min(0),
              userID: z.string().trim().max(120),
              roles: roleSchema.array().max(8),
              expectedBefore: roleSchema.array().max(8),
              via: z.string().max(16),
              confidence: z.string().max(16),
              rowToken: z.string().max(128),
            }),
          )
          .min(1)
          .max(25),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      const actorUserID = ctx.session.user.userID;

      // The batch must belong to THIS actor: a signed plan is a bearer
      // credential, and one manager must not be able to drive another's import.
      const header = await ctx.db.bulkRoleImport.findUnique({
        where: { batchId: input.batchId },
      });
      if (!header || header.actorUserID !== actorUserID) {
        throw new TRPCError({ code: "FORBIDDEN", message: "NOT_YOUR_BATCH" });
      }
      if (input.expiresAt < Date.now()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "PLAN_EXPIRED" });
      }

      const results: {
        lineNo: number;
        userID: string;
        status: "ok" | "denied";
        roles?: string[];
        denyReason?: string;
      }[] = [];
      let lastLineNo = -1;

      for (const row of input.rows) {
        // Every row is re-verified against the signature the server itself
        // produced. `confirmed: true` from a client is not evidence, and
        // expectedBefore is not a secret — without this a caller posts straight
        // here and skips the preview's resolution rules entirely.
        const expectedToken = signRow({
          batchId: input.batchId,
          actorUserID,
          expiresAt: input.expiresAt,
          // The mode we are ABOUT TO APPLY, taken from the header — not from
          // the client and not from the row. If it differs from the mode the
          // plan was previewed under, the HMAC will not match and the row is
          // refused rather than applied under semantics nobody reviewed.
          mode: header.mode,
          userID: row.userID,
          roles: row.roles,
          expectedBefore: row.expectedBefore,
          via: row.via,
          confidence: row.confidence,
        });
        if (!tokenMatches(expectedToken, row.rowToken)) {
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "denied",
            denyReason: "PLAN_TOKEN_INVALID",
          });
          continue;
        }
        // Low-confidence resolutions (name matches) may only commit if the
        // confirmation was inside the SIGNED payload. The current resolver
        // never emits them; the check stands so adding the tier later cannot
        // silently open this door.
        if (row.confidence !== "high") {
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "denied",
            denyReason: "LOW_CONFIDENCE_NOT_CONFIRMED",
          });
          continue;
        }

        const requested =
          header.mode === "add"
            ? [...new Set([...row.expectedBefore, ...row.roles])]
            : [...new Set(row.roles)];

        try {
          const { actorRoles, before, after, added, removed } =
            await assertCanMutateRoles({
              db: ctx.db,
              actorUserID,
              targetUserID: row.userID,
              requestedRoles: requested,
            });

          // Optimistic concurrency against the PREVIEW, one layer above
          // applyRoleChange's own pre-image check: a row whose target changed
          // between preview and commit must not be silently skipped, or it
          // becomes indistinguishable from one that was never submitted.
          const drifted =
            before.length !== row.expectedBefore.length ||
            before.some((r) => !row.expectedBefore.includes(r));
          if (drifted) {
            await writeAudit(ctx.db, {
              actorUserID,
              actorRoles,
              targetUserID: row.userID,
              action: "denied",
              rolesBefore: before,
              rolesAfter: requested,
              ok: false,
              denyReason: "CONFLICT_ROLES_CHANGED",
              batchId: input.batchId,
            });
            results.push({
              lineNo: row.lineNo,
              userID: row.userID,
              status: "denied",
              denyReason: "CONFLICT_ROLES_CHANGED",
            });
            lastLineNo = row.lineNo;
            continue;
          }

          const roles = await applyRoleChange({
            db: ctx.db,
            actorUserID,
            actorRoles,
            targetUserID: row.userID,
            before,
            after,
            added,
            removed,
            batchId: input.batchId,
          });
          results.push({
            lineNo: row.lineNo,
            userID: row.userID,
            status: "ok",
            roles,
          });
        } catch (err) {
          // A per-row denial is data, not an exception: one bad row must not
          // abort the other 24. assertCanMutateRoles has ALREADY written the
          // audit row on ctx.db (I-15), so nothing is lost here.
          if (err instanceof TRPCError) {
            results.push({
              lineNo: row.lineNo,
              userID: row.userID,
              status: "denied",
              denyReason: err.message,
            });
          } else {
            throw err;
          }
        }
        lastLineNo = row.lineNo;
      }

      // Returned so a chunk killed by the platform timeout resumes from here
      // rather than retrying blind and double-applying.
      return { batchId: input.batchId, lastLineNo, results };
    }),

  /** Tallies are computed SERVER-side from the audit log, never accepted from the client. */
  finishBulkImport: roleManagerProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const header = await ctx.db.bulkRoleImport.findUnique({
        where: { batchId: input.batchId },
      });
      if (!header || header.actorUserID !== ctx.session.user.userID) {
        throw new TRPCError({ code: "FORBIDDEN", message: "NOT_YOUR_BATCH" });
      }
      const [applied, denied] = await Promise.all([
        ctx.db.roleAuditLog.count({
          where: { batchId: input.batchId, ok: true, action: "set" },
        }),
        ctx.db.roleAuditLog.count({
          where: { batchId: input.batchId, ok: false },
        }),
      ]);
      await ctx.db.bulkRoleImport.update({
        where: { batchId: input.batchId },
        data: { finishedAt: new Date() },
      });
      return { batchId: input.batchId, applied, denied };
    }),

  listBulkImports: roleManagerProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(100).default(25) })
        .default({ limit: 25 }),
    )
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      return ctx.db.bulkRoleImport.findMany({
        take: input.limit,
        orderBy: { startedAt: "desc" },
      });
    }),

  getBulkImport: roleManagerProcedure
    .input(z.object({ batchId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "bulkAssign");
      const [header, rows] = await Promise.all([
        ctx.db.bulkRoleImport.findUnique({ where: { batchId: input.batchId } }),
        ctx.db.roleAuditLog.findMany({
          where: { batchId: input.batchId },
          orderBy: { at: "asc" },
          take: 1000,
        }),
      ]);
      if (!header) throw new TRPCError({ code: "NOT_FOUND" });
      return { header, rows };
    }),

  /**
   * Undo is a NORMAL guarded role change per row, not a privileged rollback —
   * so a jcrc cannot undo an admin-granting import, and no undo row can express
   * removing `resident`. It is itself an import with its own batchId; the log
   * is append-only.
   *
   * Reversed in DESCENDING `at` order, skipping any target whose current roles
   * have diverged (DIVERGED_SINCE_IMPORT) rather than silently reverting a
   * later deliberate change.
   */
  undoBulkImport: roleManagerProcedure
    .input(
      z.object({
        batchId: z.string().uuid(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "undoBulkImport");
      const actorUserID = ctx.session.user.userID;

      const original = await ctx.db.bulkRoleImport.findUnique({
        where: { batchId: input.batchId },
      });
      if (!original) throw new TRPCError({ code: "NOT_FOUND" });
      if (original.undoneBy) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "ALREADY_UNDONE" });
      }

      const undoBatchId = randomUUID();
      await ctx.db.bulkRoleImport.create({
        data: {
          batchId: undoBatchId,
          actorUserID,
          actorRoles: ctx.session.user.roles ?? [],
          mode: "set",
          note: input.reason ?? null,
          undoOf: input.batchId,
        },
      });

      // "pending.claim" is included deliberately: a grant claimed at first
      // login after the import must be reversed too, or escalation outlives the
      // rollback of the import that created it.
      const rows = await ctx.db.roleAuditLog.findMany({
        where: {
          batchId: input.batchId,
          ok: true,
          action: { in: ["set", "pending.claim"] },
        },
        orderBy: { at: "desc" },
        take: 1000,
      });

      const results: {
        targetUserID: string;
        status: "ok" | "denied";
        denyReason?: string;
      }[] = [];
      const seen = new Set<string>();

      for (const r of rows) {
        const target = r.targetUserID;
        if (!target || seen.has(target)) continue; // newest row per target wins
        seen.add(target);
        try {
          const { actorRoles, before, after, added, removed } =
            await assertCanMutateRoles({
              db: ctx.db,
              actorUserID,
              targetUserID: target,
              requestedRoles: r.rolesBefore.filter(isGrantableRole),
            });
          const diverged =
            before.length !== r.rolesAfter.filter(isGrantableRole).length ||
            before.some((x) => !r.rolesAfter.includes(x));
          if (diverged) {
            await writeAudit(ctx.db, {
              actorUserID,
              actorRoles,
              targetUserID: target,
              action: "denied",
              rolesBefore: before,
              rolesAfter: r.rolesBefore,
              ok: false,
              denyReason: "DIVERGED_SINCE_IMPORT",
              batchId: undoBatchId,
            });
            results.push({
              targetUserID: target,
              status: "denied",
              denyReason: "DIVERGED_SINCE_IMPORT",
            });
            continue;
          }
          await applyRoleChange({
            db: ctx.db,
            actorUserID,
            actorRoles,
            targetUserID: target,
            before,
            after,
            added,
            removed,
            reason: input.reason,
            batchId: undoBatchId,
          });
          results.push({ targetUserID: target, status: "ok" });
        } catch (err) {
          if (err instanceof TRPCError) {
            results.push({
              targetUserID: target,
              status: "denied",
              denyReason: err.message,
            });
          } else {
            throw err;
          }
        }
      }

      // Unclaimed deferred grants from the same import are deleted rather than
      // left to land after the undo. Counted separately so the UI does not
      // report them as reverted role changes.
      const purged = await ctx.db.pendingRoleGrant.deleteMany({
        where: { batchId: input.batchId },
      });

      await ctx.db.bulkRoleImport.update({
        where: { batchId: input.batchId },
        data: { undoneBy: undoBatchId },
      });

      return {
        undoBatchId,
        reverted: results.filter((r) => r.status === "ok").length,
        skipped: results.filter((r) => r.status === "denied").length,
        pendingGrantsDeleted: purged.count,
        results,
      };
    }),

  /* ---- deferred grants (D-8) ----------------------------------------- */

  /**
   * A pending grant is a BEARER CREDENTIAL against a mailbox nobody has claimed
   * yet, so the creation rules are enforced here and not only in the UI:
   *   1. `resident` is unrepresentable (not in roleSchema) — I-8e. A user with
   *      "no resident row yet" is I-8a/I-8b's case, never this one.
   *   2. every role must be in assignableBy(actor's LIVE roles) — a jcrc
   *      creating a pending `jcrc` is refused (D-3).
   *   3. `admin` additionally requires seeAdminIdentities, a non-empty reason
   *      and <= 14 days: the shorter it lives, the smaller the window.
   *   4. an existing User row is refused (USER_EXISTS_GRANT_DIRECTLY) — the
   *      redemption fast path fires only at true first login, so a grant
   *      created after signup would be stranded.
   *   5. keyed ONLY on a canonical E-format id from an E-id or an @u.nus.edu
   *      address. NEVER a matric (self-asserted) and never a display name.
   */
  createPendingGrants: roleManagerProcedure
    .input(
      z.object({
        rows: z
          .array(
            z.object({
              identifier: z.string().trim().min(1).max(120),
              roles: roleSchema.array().min(1).max(8),
            }),
          )
          .min(1)
          .max(200),
        expiresInDays: z.number().int().min(1).max(90).default(30),
        reason: z.string().trim().max(500).optional(),
        batchId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "createPendingGrants");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID); // I-5 re-read
      const canAssign = assignableBy(actorRoles);
      const expiresAt = new Date(
        Date.now() + input.expiresInDays * 24 * 3600 * 1000,
      );

      const results: {
        identifier: string;
        status: "ok" | "denied";
        userID?: string;
        denyReason?: string;
      }[] = [];

      for (const row of input.rows) {
        const deny = async (denyReason: string, userID?: string) => {
          await writeAudit(ctx.db, {
            actorUserID,
            actorRoles,
            targetUserID: userID,
            action: "denied",
            rolesAfter: row.roles,
            ok: false,
            denyReason,
            batchId: input.batchId,
          });
          results.push({
            identifier: row.identifier,
            status: "denied",
            denyReason,
            userID,
          });
        };

        const hit = resolveIdentifier(row.identifier);
        if (!hit) {
          await deny("UNRESOLVED_IDENTIFIER");
          continue;
        }
        const bad = row.roles.find((r) => !canAssign.has(r));
        if (bad) {
          await deny(
            bad === CCA_HEAD_ROLE
              ? "USE_CCA_HEAD_ENDPOINT"
              : `CANNOT_GRANT_${bad.toUpperCase()}`,
            hit.userID,
          );
          continue;
        }
        // G8 at the QUEUE. redeemPendingGrants re-checks this at redemption
        // against the target's roles at the time — that is the authoritative
        // check, since a target can acquire the other half of the pair between
        // now and their first login. This one is here so a row that can NEVER
        // redeem is refused while there is still a human looking at the result,
        // rather than failing silently months later on a login nobody watches.
        const combination = forbiddenRoleCombination(row.roles);
        if (combination) {
          await deny(combination, hit.userID);
          continue;
        }
        if (row.roles.includes(ADMIN_ROLE)) {
          if (
            !c.seeAdminIdentities ||
            !input.reason ||
            input.expiresInDays > 14
          ) {
            await deny("ADMIN_PENDING_GRANT_RESTRICTED", hit.userID);
            continue;
          }
        }
        const existing = await ctx.db.user.findFirst({
          where: {
            email: {
              equals: `${hit.userID.toLowerCase()}@u.nus.edu`,
              mode: "insensitive",
            },
          },
          select: { id: true },
        });
        if (existing) {
          await deny("USER_EXISTS_GRANT_DIRECTLY", hit.userID);
          continue;
        }

        const prior = await ctx.db.pendingRoleGrant.findUnique({
          where: { userID: hit.userID },
        });
        // Union the roles and take the LATER expiry, so two operators adding
        // the same person do not silently shorten or narrow each other's grant.
        const roles = [...new Set([...(prior?.roles ?? []), ...row.roles])];
        const laterExpiry =
          prior && prior.expiresAt > expiresAt ? prior.expiresAt : expiresAt;

        await ctx.db.pendingRoleGrant.upsert({
          where: { userID: hit.userID },
          create: {
            userID: hit.userID,
            roles,
            createdBy: actorUserID,
            createdByRoles: actorRoles,
            expiresAt: laterExpiry,
            batchId: input.batchId ?? null,
            reason: input.reason ?? null,
          },
          update: {
            roles,
            expiresAt: laterExpiry,
            createdBy: actorUserID,
            createdByRoles: actorRoles,
            batchId: input.batchId ?? null,
            reason: input.reason ?? null,
          },
        });
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: hit.userID,
          action: "pending.create",
          rolesBefore: prior?.roles ?? [],
          rolesAfter: roles,
          reason: input.reason,
          batchId: input.batchId,
        });
        results.push({
          identifier: row.identifier,
          status: "ok",
          userID: hit.userID,
        });
      }

      return { results };
    }),

  listPendingGrants: roleManagerProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(50) })
        .default({ limit: 50 }),
    )
    .query(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      const rows = await ctx.db.pendingRoleGrant.findMany({
        take: input.limit,
        orderBy: { createdAt: "desc" },
      });
      // D-2: admin-bearing rows are hidden, not redacted — a row whose only
      // role is `admin` must not surface as an empty-roles mystery entry.
      return c.seeAdminIdentities
        ? rows
        : rows.filter((r) => !r.roles.includes(ADMIN_ROLE));
    }),

  revokePendingGrant: roleManagerProcedure
    .input(
      z.object({
        userID: userIDSchema,
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = caps(ctx.session.user.roles);
      requireCapability(c, "createPendingGrants");
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      const row = await ctx.db.pendingRoleGrant.findUnique({
        where: { userID: input.userID },
      });
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      // A jcrc must not be able to delete an admin-bearing grant they could not
      // have created and cannot even see.
      if (row.roles.includes(ADMIN_ROLE) && !c.seeAdminIdentities) {
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: input.userID,
          action: "denied",
          ok: false,
          denyReason: "CANNOT_MODIFY_AN_ADMIN",
        });
        forbid("CANNOT_MODIFY_AN_ADMIN");
      }
      await ctx.db.pendingRoleGrant.delete({ where: { userID: input.userID } });
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: input.userID,
        action: "pending.revoke",
        rolesBefore: row.roles,
        reason: input.reason,
        batchId: row.batchId ?? undefined,
      });
      return { userID: input.userID };
    }),

  purgeExpiredPendingGrants: adminProcedure.mutation(async ({ ctx }) => {
    const res = await ctx.db.pendingRoleGrant.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await writeAudit(ctx.db, {
      actorUserID: ctx.session.user.userID,
      actorRoles: ctx.session.user.roles ?? [],
      action: "pending.revoke",
      reason: `purged ${res.count} expired`,
    });
    return { deleted: res.count };
  }),
});
