import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { canonicalUserID, isCanonicalResidentID } from "~/lib/identity";

/**
 * Role VOCABULARY + the stored-baseline machinery (RBAC v2, 02-backend-authz.md
 * §3.1, §2.5, §7.1). `access.ts` remains POLICY; this file is what policy is
 * expressed in.
 *
 * The plan's file map splits this across roles.ts / baseline.ts /
 * capabilities.ts. They are consolidated here by explicit instruction. The
 * split was never load-bearing: nothing below imports access.ts, so there is no
 * cycle, and the module stays runtime-pure (PrismaClient is a TYPE-ONLY import
 * and is erased), which is what let doc 03's client components import the
 * vocabulary. Keep it that way — do not add a value import of `~/server/db`,
 * `~/env`, `@trpc/server` or `next/server` here. That is why `requireCapability`
 * (02 §7.1), which needs TRPCError, is deliberately NOT in this file.
 */

export {
  canonicalUserID,
  isNusStudentEmail,
  normalizeEmail,
} from "~/lib/identity";

/**
 * Single source of truth for role identifiers.
 * Adding a role = add it here and to ASSIGNABLE_BY, and nothing else.
 */
export const ROLES = ["admin", "jcrc", "cca_head", "resident"] as const;
// The v1 pseudo-role "user" is DELETED from the vocabulary (00-overview.md
// §2.2); `resident` is the floor. Do not re-add it — an unused enum member is a
// read-boundary hazard (07-cca-future.md §1.4).
export type Role = (typeof ROLES)[number];

export const ADMIN_ROLE = "admin" as const;
export const JCRC_ROLE = "jcrc" as const;
export const CCA_HEAD_ROLE = "cca_head" as const;
/**
 * Baseline capability of every verified NUS account. STORED and auto-assigned
 * (I-8), never GRANTABLE: it is written only by ensureBaseline, the register
 * route, the createUser event and the backfill — never through the role UI.
 */
export const BASELINE_ROLE = "resident" as const;

/**
 * Roles that survive every role write, because they cannot be expressed in a
 * removal payload (I-8c). SINGLE SOURCE — roleService imports it, and doc 03's
 * admin UI imports it so the preview's `After` column matches what the server
 * will actually do. The UI list is NOT the mechanism; the chokepoint is.
 */
export const STICKY = [BASELINE_ROLE] as const;

/**
 * PRE-V2 LEGACY CONSTANT ONLY — the value the still-deployed `access.ts:19`
 * falls back to (`row?.role ?? DEFAULT_ROLE`). It is deliberately NOT a member
 * of `ROLES` and is `Role`-incompatible: "user" is not part of the v2
 * vocabulary. Never stored, never granted, never compared against `roles[]`.
 * Removed with the legacy scalar in `06-legacy-cutover.md` §5 step 4.
 */
export const DEFAULT_ROLE = "user" as const;

/**
 * Roles the role machinery may WRITE — the domain of the `removed` set at the
 * write chokepoint (`removed ⊆ before ∩ GRANTABLE_ROLES`).
 *
 * `resident` is DELIBERATELY ABSENT (I-8e), and under the STORED baseline its
 * absence does more work than it used to. Because `resident` is not in this
 * list, it is not FILTERED OUT of a removal set — it is INCAPABLE OF APPEARING
 * IN ONE. roleSchema cannot express it, ASSIGNABLE_BY and
 * REVOCABLE_FROM_OTHERS_BY do not contain it, and no set, bulk, undo or
 * deferred payload can carry it in either direction. That is the mechanism, not
 * a convention and not a UI list.
 *
 * `cca_head` IS here — the CCA endpoints must be able to remove it — but it is
 * absent from ASSIGNABLE_BY / REVOCABLE_FROM_OTHERS_BY, which is what keeps it
 * off the GENERIC path (I-14). Membership here is "writable by some chokepoint",
 * not "reachable from grant/revoke/set/bulk".
 *
 * Corollary, stated where someone might try it: a manual DATABASE revocation of
 * `resident` is not a sanction — I-8b repairs it at the target's next page
 * load. A booking ban is a separate affirmative flag (00-overview.md §3.4),
 * never the absence of the baseline.
 */
export const GRANTABLE_ROLES = ["admin", "jcrc", "cca_head"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/**
 * Roles a FACILITY may require. Separate enum from GRANTABLE_ROLES because D-1
 * pulled the two domains apart: `resident` is requirable but not grantable, and
 * `admin` is grantable but must NEVER be stored in requiredRoles (it is an
 * implicit bypass; storing it invites someone to delete it and lock admins out).
 */
export const FACILITY_ROLES = ["resident", "jcrc", "cca_head"] as const;
export type FacilityRole = (typeof FACILITY_ROLES)[number];

/** Values allowed in `RoleAuditLog.action` (prisma/schema.prisma). */
export const AUDIT_ACTIONS = [
  "grant",
  "revoke",
  "set",
  "facilityAccess.set",
  "denied",
  "pending.create",
  "pending.claim",
  "pending.revoke",
  "booking.denied.shadow",
  "ccaHead.grant",
  "ccaHead.revoke",
  "ccaHead.transfer",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Legacy-mirror precedence for the D-6 dual-write window. Must match
 * seed-roles-v2.mjs. `resident` is deliberately EXCLUDED: the only consumer of
 * the legacy scalar is a rollback to the pre-v2 access.ts, which is
 * default-OPEN and cannot interpret `resident`. Writing it there would be
 * meaningless at best and would displace a real value at worst.
 * Removed entirely in doc 06.
 */
export const PRECEDENCE = ["admin", "jcrc", "cca_head"] as const;

/**
 * The `$set: { role: ... }` half of the dual-write. Returns null when the user
 * holds no mirrorable role — including the extremely common `["resident"]`
 * case, which must write null rather than "resident" (see PRECEDENCE).
 *
 * The chokepoint that consumes this carries `$set: { role: legacyMirror(after) }`
 * and MUST NOT also carry `$setOnInsert: { role: "" }`: MongoDB rejects two
 * operators naming the same path with ConflictingUpdateOperators, at parse
 * time, for the whole command (I-8c correction 2, I-9). The `""` sentinel
 * belongs only where nothing else writes `role` — i.e. ensureBaseline below.
 */
export function legacyMirror(roles: readonly string[]): string | null {
  return PRECEDENCE.find((r) => roles.includes(r)) ?? null;
}

/**
 * Privilege-escalation firewall as DATA, not if-statements.
 * Null prototype: a router that ever passes an unvalidated string must not be
 * able to reach Object.prototype via ASSIGNABLE_BY["constructor"].
 *
 * Constrains WHICH ROLES a caller may touch. It does NOT constrain WHICH
 * TARGET — that is the separate target guard G3. Both are required; neither is
 * sufficient.
 *
 * D-3, OVERRIDING v1: a jcrc may NOT grant jcrc. Only admins grant or revoke
 * jcrc. Consequence to be aware of: a jcrc who steps down can be restored only
 * by an admin, not by a peer.
 *
 * I-14: `cca_head` is absent from EVERY entry, admin's included. It never
 * travels the generic grant/revoke/set/bulk/deferred path; it is written only
 * by admin.grantCcaHead / revokeCcaHead / transferCcaHead, which maintain the
 * UserRole string and the CcaHead row in one transaction. The jcrc power to
 * manage CCA heads is a separate CAPABILITY (`manageCcaHeads` below), not an
 * assignable role. 02-backend-authz.md §3.1 still shows the pre-I-14 form
 * (`admin: [...,"cca_head"], jcrc: ["cca_head"]`); 00-overview.md §3.2 is the
 * form that ships and is the one below.
 *
 * `resident` maps to [] and appears in no other entry, in either direction, at
 * any level — I-8e. `user` is retained as a key only so a legacy row still
 * carrying the dead scalar resolves to [] instead of undefined.
 */
export const ASSIGNABLE_BY: Record<string, readonly GrantableRole[]> =
  Object.assign(
    Object.create(null) as Record<string, readonly GrantableRole[]>,
    {
      admin: ["admin", "jcrc"] as const,
      jcrc: [] as const,
      cca_head: [] as const,
      resident: [] as const,
      user: [] as const,
    },
  );

/**
 * Roles a caller may REVOKE from ANOTHER user. Kept as a separate map from
 * ASSIGNABLE_BY even though D-3 currently makes them identical, because they
 * answer different questions and will diverge again if a role is ever made
 * grant-but-not-revoke. `resident` is absent here too (I-8e).
 */
export const REVOCABLE_FROM_OTHERS_BY: Record<string, readonly GrantableRole[]> =
  Object.assign(
    Object.create(null) as Record<string, readonly GrantableRole[]>,
    {
      admin: ["admin", "jcrc"] as const,
      jcrc: [] as const,
      cca_head: [] as const,
      resident: [] as const,
      user: [] as const,
    },
  );

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

export function isGrantableRole(v: string): v is GrantableRole {
  return (GRANTABLE_ROLES as readonly string[]).includes(v);
}

export function isFacilityRole(v: string): v is FacilityRole {
  return (FACILITY_ROLES as readonly string[]).includes(v);
}

function union(
  map: Record<string, readonly GrantableRole[]>,
  callerRoles: readonly string[],
): Set<GrantableRole> {
  const out = new Set<GrantableRole>();
  for (const r of callerRoles) for (const a of map[r] ?? []) out.add(a);
  return out;
}
export const assignableBy = (roles: readonly string[]) =>
  union(ASSIGNABLE_BY, roles);
export const revocableFromOthersBy = (roles: readonly string[]) =>
  union(REVOCABLE_FROM_OTHERS_BY, roles);

/**
 * POST-CANONICALIZATION SANITY CHECK on an id. NOT an authorization test and
 * NOT a provenance test — it is a pure SHAPE test and it carries no evidence
 * about where its argument came from.
 *
 * Renamed from `isResidentEligible` on purpose. Under the stored baseline this
 * predicate GATES A WRITE (I-8d), and the old name invited exactly the misuse
 * that breaks it: calling it on an admin-supplied `targetUserID` and concluding
 * that the principal is NUS-verified. It is sound ONLY over a string that
 * canonicalUserID() has just produced, which is why ensureBaseline takes an
 * EMAIL and canonicalizes internally rather than accepting an id.
 *
 * Deliberately NOT E_FORMAT.test(id): `g.s_samuel@u.nus.edu` is a real,
 * legitimate account whose canonical id is "G.S_SAMUEL". Gating the baseline
 * WRITE on E-format would withhold it permanently, not merely mis-derive once
 * (lockout mode L-27).
 *
 * Re-exported from src/lib/identity.ts rather than redefined: two copies of a
 * write guard is how they drift.
 */
export { isCanonicalResidentID };

/**
 * THE read boundary. Every role consumer goes through this. Replaces v1's
 * normalizeRoles entirely.
 *
 * Takes ONLY the stored array. It does not take a userID and it derives
 * nothing: under I-8 the stored value IS the truth. Unknown strings are
 * dropped, so a stray script write can never become a live permission — and
 * `resident` is KEPT, because it is now a known, valid member of ROLES. The v2
 * discard-then-re-derive step is gone; keeping it would have made a
 * read-boundary filter able to erase a real stored grant.
 */
export function normalizeStoredRoles(
  stored: readonly string[] | null | undefined,
): Role[] {
  const out = new Set<Role>();
  for (const r of stored ?? []) {
    if (isGrantableRole(r)) out.add(r);
    else if (r === BASELINE_ROLE) out.add(r);
  }
  return [...out];
}

/**
 * E-format NUSNET id. A VALIDATION rule for grant targets and pasted bulk input
 * ONLY (guard G7) — never an eligibility test (see isCanonicalResidentID) and
 * never a gate on the baseline write.
 */
export const E_FORMAT = /^E\d{7}$/;
export function isEFormatUserID(id: string): boolean {
  return E_FORMAT.test(id);
}

/**
 * THE identity predicate for grant targets and for any UI that filters on one
 * (I-12: one predicate, not two). Lives here — and not in admin.ts — because
 * this module is runtime-pure and therefore importable by client components,
 * while admin.ts pulls in `node:crypto` and `~/env` and cannot be.
 *
 * `.trim()` and `.toUpperCase()` run BEFORE the regex and are load-bearing: a
 * value pasted from a spreadsheet carries an invisible trailing space, and a
 * client guard that rejects what this schema accepts fails open (09 §2.6).
 * Behaviour is exactly what admin.ts defined locally before this move — do not
 * "tidy" it; 11 server input sites depend on it verbatim.
 */
export const userIDSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(E_FORMAT, "Must be an E-format NUSNET id");

/* -------------------------------------------------------------------------- */
/* I-8b — the stored baseline's self-heal                                      */
/* -------------------------------------------------------------------------- */

/**
 * Circuit breaker for ensureBaseline. Per-lambda-instance, same shape as the
 * 15s SystemFlag cache in access.ts.
 *
 * NOT a correctness mechanism. It is the thing that stops a `UserRole`-scoped
 * write fault from turning a per-user denial into an app-wide latency event:
 * without it every request from every affected user would issue 1-2 failing
 * AWAITED writes plus a console.error before the session resolves, on the
 * hottest route in the app. The same bound applies to a mass cold start
 * (stale-backup restore: ~515 users cold at once).
 */
const BREAKER_TTL_MS = 45_000;
const BREAKER_THRESHOLD = 5;
let breakerFailures = 0;
let breakerOpenUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}
function breakerSuccess(): void {
  breakerFailures = 0;
  breakerOpenUntil = 0;
}
function breakerFailure(): void {
  breakerFailures += 1;
  if (breakerFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_TTL_MS;
    breakerFailures = 0;
  }
}

/** Shape of the MongoDB `update` command reply, as Prisma passes it through. */
type RawUpdateReply = {
  ok?: number;
  n?: number;
  nModified?: number;
  upserted?: unknown[];
  writeErrors?: { code?: number }[];
};

/**
 * I-8b. Idempotent, race-safe top-up of the STORED baseline.
 *
 * Returns true if the baseline is (now) present, false if the repair failed.
 * NEVER throws — it is called from the NextAuth session callback, and an
 * unhandled rejection there rejects the session and force-logs-out the user,
 * which is an unrecoverable state.
 *
 * TAKES THE EMAIL, NOT THE ID (I-8d). The eligibility predicate is a pure SHAPE
 * test with no provenance; it is sound only over a string that canonicalUserID()
 * just produced. Canonicalizing inside means the only way to reach this write is
 * to have presented an @u.nus.edu address. Do not add an id-taking overload
 * "for convenience" — that is how an admin-supplied E-format string becomes a
 * stored baseline for a principal that was never email-verified.
 */
export async function ensureBaseline(
  db: PrismaClient,
  email: string | null | undefined,
): Promise<boolean> {
  const userID = canonicalUserID(email);
  // I-8d trust boundary. The isCanonicalResidentID call is a belt-and-braces
  // sanity check on a string canonicalUserID just produced; the PROVENANCE is
  // established by the line above it, not by the shape test.
  if (!userID || !isCanonicalResidentID(userID)) return false;

  if (breakerOpen()) return false;

  // Exactly two attempts: the initial write, and ONE retry reserved for E11000.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Raw, not typed Prisma, and this is the one place in the design where
      // that is correct: Prisma's Mongo connector cannot express $addToSet
      // (its `push` does not dedupe — I-13 forbids it) and cannot express
      // $setOnInsert at all. This write is NOT inside a $transaction, so the
      // "raw commands do not join an interactive transaction" hazard does not
      // apply here; it is precisely why the role-mutation chokepoint may not
      // copy this shape.
      //
      // `role: ""` on insert satisfies the still-present legacy scalar without
      // polluting doc 06's containment gate. It MUST be the empty string, not
      // null: the still-deployed old client throws on absence AND on null,
      // while "" is falsy and preserves the live `if (!required) return true`.
      // Nothing else in this command touches `role`, which is why $setOnInsert
      // is legal HERE and illegal at the chokepoint (I-9 / I-8c correction 2).
      const res = (await db.$runCommandRaw({
        update: "UserRole",
        updates: [
          {
            q: { userID },
            u: {
              $addToSet: { roles: BASELINE_ROLE },
              $setOnInsert: { role: "" },
            },
            upsert: true,
          },
        ],
        ordered: false,
      })) as unknown as RawUpdateReply;

      // I-8f: INSPECT THE REPLY, DO NOT RELY ON THE EXCEPTION PATH. The MongoDB
      // `update` command does NOT throw on per-write failures — it resolves with
      // { ok: 1, n: 0, writeErrors: [{ code: 11000 | 121 | ... }] }, and
      // $runCommandRaw passes that through as DATA (it rejects only on ok:0 or
      // a driver-level fault). Reading only the catch block would (a) make the
      // E11000 retry below dead code, (b) return true for a write that never
      // applied, and (c) never log baseline_repair_failed — turning the design's
      // single honest residual from MITIGATED+DETECTED into UNDETECTED.
      const errs = res.writeErrors ?? [];
      if (res.ok === 1 && errs.length === 0) {
        breakerSuccess();
        return true;
      }

      // E11000: a CONCURRENT upsert inserted the document between our match and
      // our insert. This is NOT unconditionally success. Treating it as success
      // is wrong under a stored baseline: if the winner was a concurrent bulk
      // grant inserting { roles: ["jcrc"] }, our $addToSet never applied and the
      // user has no baseline. Retry ONCE — the document now exists, so the retry
      // MATCHES and $addToSet applies. Never swallowed, never retried forever.
      if (
        attempt === 0 &&
        errs.length > 0 &&
        errs.every((e) => e.code === 11000)
      ) {
        continue;
      }

      breakerFailure();
      console.error(
        JSON.stringify({ evt: "baseline_repair_failed", userID, writeErrors: errs }),
      );
      return false;
    } catch (err) {
      // Connection-level / ok:0 faults DO throw. Secondary path, kept because
      // the reply check above cannot see them.
      if (attempt === 0) continue;
      breakerFailure();
      console.error(
        JSON.stringify({ evt: "baseline_repair_failed", userID, err: String(err) }),
      );
      return false;
    }
  }

  // Reachable only if attempt 0 signalled `continue` and attempt 1 did too,
  // which the loop bound forbids — kept so the function is total without a
  // non-null assertion.
  breakerFailure();
  return false;
}

/* -------------------------------------------------------------------------- */
/* D-8 — deferred grant redemption                                             */
/* -------------------------------------------------------------------------- */

/**
 * D-8. The READER for `PendingRoleGrant`, called once per user from the session
 * callback and guarded by `UserRole.pendingCheckedAt`.
 *
 * It exists because the WRITER (admin.createPendingGrants + the dashboard
 * panel) shipped without it: rows were validated, audited and persisted, the UI
 * reported success, and nothing ever consulted them — so 30 incoming JCRC
 * members would each sign up, receive `resident` only, hold no `jcrc`, and the
 * grants would sit until purgeExpiredPendingGrants silently deleted them.
 * Shipping the writer without the reader is worse than shipping neither.
 *
 * FOUR PROPERTIES, all load-bearing:
 *
 *  1. NEVER THROWS. Same rule as ensureBaseline — it is awaited (indirectly) on
 *     the NextAuth session path, and a rejection there force-logs-out the user.
 *     Every failure returns quietly and leaves the pending row intact, so the
 *     next login retries.
 *
 *  2. ADDITIVE ONLY. `$addToSet`, never a set-payload, never a `$pull` (I-13).
 *     This is the fourth role-write surface and it deliberately does NOT go
 *     through applyRoleChange's chokepoint; it is sticky by construction
 *     because it is incapable of removing anything, `resident` included.
 *
 *  3. RE-AUTHORIZED AT REDEMPTION AGAINST THE GRANTER'S CURRENT ROLES
 *     (02 §2.5). A grant is a bearer credential that outlives the session that
 *     created it: if the jcrc who queued it has since been demoted, the grant
 *     must not still confer what they may no longer confer. So the granter's
 *     roles are RE-READ here, now, and each role must still be in
 *     assignableBy(them). `resident` is filtered out unconditionally (I-8e) —
 *     the baseline is ensureBaseline's job and only its job (I-8d provenance).
 *
 *  4. `pendingCheckedAt` IS STAMPED UNCONDITIONALLY, including the no-grant and
 *     expired cases. That stamp is what makes the steady-state cost of this
 *     whole feature exactly zero queries after one run per user.
 */
export async function redeemPendingGrants(
  db: PrismaClient,
  userID: string,
): Promise<void> {
  if (!userID) return;

  try {
    const grant = await db.pendingRoleGrant.findUnique({ where: { userID } });

    // No grant, or an expired one. Stamp and leave. An expired row is DELETED
    // rather than left for purgeExpiredPendingGrants: the person it names has
    // now signed up, so the row can never be redeemed again and keeping it
    // would make listPendingGrants lie about who is still outstanding.
    if (!grant || grant.expiresAt.getTime() <= Date.now()) {
      if (grant) {
        await db.pendingRoleGrant.deleteMany({ where: { userID } });
        await writeRedemptionAudit(db, {
          actorUserID: grant.createdBy,
          actorRoles: grant.createdByRoles,
          targetUserID: userID,
          rolesAfter: grant.roles,
          ok: false,
          denyReason: "PENDING_GRANT_EXPIRED",
          batchId: grant.batchId,
        });
      }
      await stampPendingChecked(db, userID);
      return;
    }

    // Property 3. The granter's roles NOW, not the ones frozen on the row at
    // creation time (`createdByRoles` is kept for the audit trail only).
    const granterRow = await db.userRole.findUnique({
      where: { userID: grant.createdBy },
    });
    const granterRoles = normalizeStoredRoles(
      granterRow?.roles?.length
        ? granterRow.roles
        : granterRow?.role
          ? [granterRow.role]
          : [],
    );
    const canAssign = assignableBy(granterRoles);
    const granted = grant.roles.filter(
      (r) => isGrantableRole(r) && canAssign.has(r),
    );
    const refused = grant.roles.filter((r) => !granted.includes(r));

    if (granted.length > 0) {
      const applied = await addRolesAdditive(db, userID, granted);
      if (!applied) {
        // The write failed. Do NOT delete the row and do NOT stamp — leaving
        // both intact is what makes this resumable on the next login, which is
        // the only recovery path a user has here.
        console.error(
          JSON.stringify({ evt: "pending_claim_failed", userID, granted }),
        );
        return;
      }
    }

    // Claimed (or wholly refused) — either way the row is spent. Deleted BEFORE
    // the stamp so a crash between the two re-runs a no-op rather than
    // re-granting.
    //
    // deleteMany, not delete: two concurrent session reads can both observe a
    // null `pendingCheckedAt` and both redeem. The grant itself is idempotent
    // ($addToSet), but `delete` throws P2025 on the loser, which would skip the
    // stamp and leave the check running forever. deleteMany treats zero rows as
    // success.
    await db.pendingRoleGrant.deleteMany({ where: { userID } });
    await writeRedemptionAudit(db, {
      actorUserID: grant.createdBy,
      actorRoles: grant.createdByRoles,
      targetUserID: userID,
      rolesBefore: grant.roles,
      rolesAfter: granted,
      ok: granted.length > 0,
      denyReason:
        refused.length > 0
          ? `GRANTER_NO_LONGER_MAY_ASSIGN:${refused.join("+")}`
          : null,
      batchId: grant.batchId,
    });
    await stampPendingChecked(db, userID);
  } catch (err) {
    // Property 1. Contained: the row and the absent stamp both survive, so the
    // next session read retries.
    console.error(
      JSON.stringify({ evt: "pending_redeem_failed", userID, err: String(err) }),
    );
  }
}

/**
 * `$addToSet` with `$each`, via a raw command for the same reason ensureBaseline
 * uses one: Prisma's Mongo connector cannot express $addToSet, and its `push`
 * does not dedupe (I-13 forbids it). NOT inside a $transaction, so the "raw
 * commands do not join an interactive transaction" hazard does not apply.
 *
 * The legacy `role` mirror is deliberately NOT updated. Computing it needs the
 * post-write set, which a concurrent revocation can invalidate — and a stale
 * mirror that RE-ADDS a just-revoked role is a privilege-retention bug, whereas
 * an un-updated mirror merely under-privileges the caller on the still-deployed
 * old client. During the dual-write window this path fails closed on purpose;
 * doc 06 deletes the scalar. `$setOnInsert role: ""` still applies (I-9), and
 * it names a path no `$set` here touches (ConflictingUpdateOperators).
 */
async function addRolesAdditive(
  db: PrismaClient,
  userID: string,
  roles: string[],
): Promise<boolean> {
  const res = (await db.$runCommandRaw({
    update: "UserRole",
    updates: [
      {
        q: { userID },
        u: {
          $addToSet: { roles: { $each: roles } },
          $set: { updatedAt: { $date: new Date().toISOString() } },
          $setOnInsert: { role: "" },
        },
        upsert: true,
      },
    ],
    ordered: false,
  })) as unknown as RawUpdateReply;

  // I-8f: INSPECT THE REPLY. $runCommandRaw resolves with
  // { ok: 1, writeErrors: [...] } on a per-write failure rather than throwing,
  // so try/catch alone would report a grant that never applied as success.
  return res.ok === 1 && (res.writeErrors ?? []).length === 0;
}

/** Property 4. Best-effort: a failed stamp only costs one repeated lookup. */
async function stampPendingChecked(
  db: PrismaClient,
  userID: string,
): Promise<void> {
  try {
    await db.userRole.update({
      where: { userID },
      data: { pendingCheckedAt: new Date() },
    });
  } catch {
    // The row may not exist (ensureBaseline failed for an ineligible or
    // partially-created identity). Not worth a retry: the next session read
    // simply re-checks, which is one indexed findUnique.
  }
}

/**
 * Audit rows for redemption. A local copy rather than an import of admin.ts's
 * `writeAudit`: this module is imported by auth.ts, and admin.ts pulls in
 * ../trpc → auth.ts, so importing it here would close a cycle through the
 * NextAuth options object.
 */
async function writeRedemptionAudit(
  db: PrismaClient,
  e: {
    actorUserID: string;
    actorRoles: string[];
    targetUserID: string;
    rolesBefore?: string[];
    rolesAfter?: string[];
    ok: boolean;
    denyReason?: string | null;
    batchId?: string | null;
  },
): Promise<void> {
  try {
    await db.roleAuditLog.create({
      data: {
        actorUserID: e.actorUserID,
        actorRoles: e.actorRoles ?? [],
        targetUserID: e.targetUserID,
        action: "pending.claim",
        rolesBefore: e.rolesBefore ?? [],
        rolesAfter: e.rolesAfter ?? [],
        ok: e.ok,
        denyReason: e.denyReason ?? null,
        batchId: e.batchId ?? null,
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "audit_write_failed",
        action: "pending.claim",
        targetUserID: e.targetUserID,
        error: String(err),
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* D-2 — the server-computed capability set                                    */
/* -------------------------------------------------------------------------- */

/**
 * The capability set. Computed ONCE, server-side, from the caller's live roles.
 * The dashboard renders off this object and branches on NOTHING else.
 *
 * D-2 forbids an `isAdmin` fork. v1 forked in seven independent places; none
 * was a security hole — the server guards are independent — but seven copies of
 * a policy is how the eighth one gets it wrong.
 *
 * Adding a capability = one field here + one server guard. If you find yourself
 * writing `roles.includes("admin")` in a component, it belongs here.
 */
export type Capabilities = {
  reachDashboard: boolean;
  listUsers: boolean;
  /** Roles this caller may grant, from ASSIGNABLE_BY. D-3: jcrc gets []. */
  assignableRoles: GrantableRole[];
  revocableRoles: GrantableRole[];
  /**
   * I-14. `cca_head` is not an assignable ROLE, so this power cannot be read
   * off assignableRoles — it is a capability in its own right, exercised only
   * through the dedicated CCA endpoints. Per 00-overview.md §3 it belongs to
   * admin AND jcrc.
   */
  manageCcaHeads: boolean;
  /** May act on a user who holds `admin` at all. D-2: admin only. */
  modifyAdmins: boolean;
  /** May see WHO holds admin (counts and identities). D-2: admin only. */
  seeAdminIdentities: boolean;
  bulkAssign: boolean;
  createPendingGrants: boolean;
  undoBulkImport: boolean;
  readAuditLog: boolean;
  manageFacilityAccess: boolean;
  /** Aggregate health counts. Per-user identifier lists are admin-only. */
  viewSystemHealth: boolean;
  viewSystemHealthDetail: boolean;
  manageEnforcementFlag: boolean;
};

export function computeCapabilities(roles: readonly string[]): Capabilities {
  const admin = roles.includes(ADMIN_ROLE);
  const manager = admin || roles.includes(JCRC_ROLE);
  return {
    reachDashboard: manager,
    listUsers: manager,
    // Derived from the maps, so D-3 and I-14 are expressed once, here in
    // roles.ts, and propagate everywhere. Note `admin` is ABSENT for jcrc
    // rather than rendered-disabled: do not leak the ladder.
    assignableRoles: [...assignableBy(roles)],
    revocableRoles: [...revocableFromOthersBy(roles)],
    manageCcaHeads: manager,
    modifyAdmins: admin,
    seeAdminIdentities: admin,
    bulkAssign: manager,
    createPendingGrants: manager,
    undoBulkImport: manager,
    readAuditLog: admin,
    manageFacilityAccess: admin,
    viewSystemHealth: manager,
    viewSystemHealthDetail: admin,
    manageEnforcementFlag: admin,
  };
}
