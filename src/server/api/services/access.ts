import type { PrismaClient } from "@prisma/client";
import {
  ADMIN_ROLE,
  JCRC_ROLE,
  DEFAULT_ROLE,
  BASELINE_ROLE,
  ensureBaseline,
  isCanonicalResidentID,
  normalizeStoredRoles,
  type Role,
} from "./roles";

/**
 * Booking POLICY (RBAC v2, 02-backend-authz.md §4). Server-only: everything
 * here takes a PrismaClient. The VOCABULARY it is expressed in lives in
 * `./roles`, which is pure and importable from anywhere.
 *
 * This file replaces the pre-D-1 version wholesale. What that version did, and
 * what is deliberately not reproduced below:
 *   - `getUserRole` returning a single string — DELETED, see the note at the
 *     bottom of this file (I-6).
 *   - `if (!required) return true` — the open-by-default short-circuit. Gone
 *     from the D-1 path entirely; it survives ONLY inside `canBookLegacy`,
 *     which is reachable only when the kill switch reads "off" (I-10, I-11).
 */

export { ADMIN_ROLE, JCRC_ROLE, DEFAULT_ROLE };

/** D-1. A facility with no row, or an empty array, requires exactly this. */
export const DEFAULT_REQUIRED_ROLES = ["resident"] as const;

/* -------------------------------------------------------------------------- */
/* I-11 — the SystemFlag kill switch                                           */
/* -------------------------------------------------------------------------- */

export type EnforcementMode = "off" | "permissive" | "enforce";

const FLAG_KEY = "rbac.booking.enforcement";
const FLAG_TTL_MS = 15_000;
const MODES = ["off", "permissive", "enforce"] as const;

let flagCache: { at: number; mode: EnforcementMode } | null = null;

/**
 * I-11. A DATABASE ROW, not an env var. On Vercel environment variables are
 * snapshotted per deployment, so editing one in the dashboard requires a
 * redeploy — an env-only switch is a false safety net on exactly the day it
 * matters. The env var is the DEPLOY-LEVEL DEFAULT; the SystemFlag row
 * overrides it live.
 *
 * DEFAULTS TO "off", and "off" means LEGACY SEMANTICS, not blanket-allow (see
 * canBookLegacy). This is what makes the whole phase behaviourally inert until
 * someone deliberately writes the row — deployed code changes nothing.
 *
 * The cache is per-lambda-instance, so 15s is the worst-case revert skew. Do
 * NOT raise it: time-to-revert is the entire value of this switch.
 */
export async function getEnforcementMode(
  db: PrismaClient,
): Promise<EnforcementMode> {
  const fallback = (process.env.RBAC_BOOKING_ENFORCEMENT ??
    "off") as EnforcementMode;
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) return flagCache.mode;
  try {
    const row = await db.systemFlag.findUnique({ where: { key: FLAG_KEY } });
    const mode = (MODES as readonly string[]).includes(row?.value ?? "")
      ? (row!.value as EnforcementMode)
      : MODES.includes(fallback)
        ? fallback
        : "off";
    flagCache = { at: Date.now(), mode };
    return mode;
  } catch {
    // Degrade to LEGACY semantics on an Atlas hiccup. An unreachable flag must
    // fall back to today's behaviour, not to no behaviour — and deliberately
    // NOT cached, so the next request retries rather than pinning "off" for 15s.
    return "off";
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetEnforcementModeCache(): void {
  flagCache = null;
  matricFlagCache = null;
  authFlagCache = null;
}

/* -------------------------------------------------------------------------- */
/* I-11 (second switch) — the MATRIC onboarding gate                           */
/* -------------------------------------------------------------------------- */

export type MatricEnforcement = "off" | "enforce";

const MATRIC_FLAG_KEY = "rbac.matric.enforcement";
const MATRIC_MODES = ["off", "enforce"] as const;

let matricFlagCache: { at: number; mode: MatricEnforcement } | null = null;

/**
 * I-11, applied to the matric gate.
 *
 * The matric feature — the `UserMatric` collection, `user.setMatric`, the
 * `/onboarding/matric` page and `MatricGate` — is ENTIRELY NEW in this change.
 * Nothing backfills `UserMatric`, so on deploy the collection is empty and
 * `hasMatric` is false for 100% of the existing population. An ungated matric
 * check is therefore not a gradual rollout, it is a total outage: every user
 * bounced to onboarding, unable to book, edit an existing booking, or post,
 * until they each individually type a matric number — and NOT revertible by
 * flipping `rbac.booking.enforcement`, because that switch never reaches this
 * code path.
 *
 * So the gate gets its OWN switch, defaulting to "off" exactly like the booking
 * one, and for the same reason: deployed code must be behaviourally inert until
 * someone deliberately writes the row. Flip it only once every active user has
 * a `UserMatric` row (or you are content to onboard them one at a time).
 *
 * Same fallback-to-legacy-on-error shape as getEnforcementMode: an unreachable
 * flag means "behave as the app did yesterday", i.e. no gate.
 */
export async function getMatricEnforcement(
  db: PrismaClient,
): Promise<MatricEnforcement> {
  const fallback = (process.env.RBAC_MATRIC_ENFORCEMENT ??
    "off") as MatricEnforcement;
  if (matricFlagCache && Date.now() - matricFlagCache.at < FLAG_TTL_MS) {
    return matricFlagCache.mode;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: MATRIC_FLAG_KEY },
    });
    const mode = (MATRIC_MODES as readonly string[]).includes(row?.value ?? "")
      ? (row!.value as MatricEnforcement)
      : MATRIC_MODES.includes(fallback)
        ? fallback
        : "off";
    matricFlagCache = { at: Date.now(), mode };
    return mode;
  } catch {
    // Not cached, deliberately — see getEnforcementMode.
    return "off";
  }
}

/** True when the matric gate should actually deny. The ONE predicate. */
export async function isMatricRequired(db: PrismaClient): Promise<boolean> {
  return (await getMatricEnforcement(db)) === "enforce";
}

/* -------------------------------------------------------------------------- */
/* I-11 (third switch) — the D-7 @u.nus.edu sign-in restriction                 */
/* -------------------------------------------------------------------------- */

export type AuthEnforcement = "off" | "permissive" | "enforce";

const AUTH_FLAG_KEY = "rbac.auth.enforcement";
const AUTH_MODES = ["off", "permissive", "enforce"] as const;

let authFlagCache: { at: number; mode: AuthEnforcement } | null = null;

/**
 * I-11, applied to D-7.
 *
 * The domain restriction is the one part of this change that is NOT inert on
 * deploy: it denies at the door, so an ungated rollout logs out every non-NUS
 * account the moment it ships — and, via `protectedProcedure`'s `eligible`
 * backstop, strips their bookings, posts and profile too, not merely new
 * logins. The Phase-1 inventory that would tell us who those accounts are is a
 * production read and has not been run.
 *
 * `AUTH_EMAIL_ALLOWLIST` is a real break-glass but a slow one: it is an env
 * var, so on Vercel recovering someone costs an env edit plus a redeploy. That
 * is the wrong shape for a lockout you discover from a user's message.
 *
 * Hence a row, defaulting to "off":
 *   off        no restriction at all — exactly today's behaviour
 *   permissive allow, but log every address that WOULD be denied. This is the
 *              discovery mode: run it for a day and the logs tell you the
 *              non-NUS population without touching the database by hand.
 *   enforce    deny (the D-7 design)
 *
 * Same degrade-to-legacy-on-error shape as the other two switches: an
 * unreachable flag must mean "behave as the app did yesterday", and a database
 * hiccup must never lock the whole userbase out of signing in.
 */
export async function getAuthEnforcement(
  db: PrismaClient,
): Promise<AuthEnforcement> {
  const fallback = (process.env.RBAC_AUTH_ENFORCEMENT ??
    "off") as AuthEnforcement;
  if (authFlagCache && Date.now() - authFlagCache.at < FLAG_TTL_MS) {
    return authFlagCache.mode;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: AUTH_FLAG_KEY },
    });
    const mode = (AUTH_MODES as readonly string[]).includes(row?.value ?? "")
      ? (row!.value as AuthEnforcement)
      : AUTH_MODES.includes(fallback)
        ? fallback
        : "off";
    authFlagCache = { at: Date.now(), mode };
    return mode;
  } catch {
    // Not cached, deliberately — see getEnforcementMode.
    return "off";
  }
}

/** True when a failing address should actually be turned away. */
export async function isAuthRestricted(db: PrismaClient): Promise<boolean> {
  return (await getAuthEnforcement(db)) === "enforce";
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Canonical role read. Tolerates rows still carrying only the legacy singular
 * `role` (the D-6 dual-write window; doc 06 removes the fallback — dropping it
 * early silently demotes any admin/jcrc row the backfill missed, and unlike
 * `resident` those roles have no self-heal path).
 *
 * Under I-8 this returns EXACTLY what is stored — it derives nothing. A user
 * with no row gets []. That is not a lockout because the session callback has
 * already run ensureBaseline in this same request (every authoritative role
 * check is preceded by `callbacks.session`; trpc.ts calls `auth()` on every
 * request), and because evaluateBooking retries the repair once before denying.
 *
 * The `if (!userID) return []` guard is load-bearing, not tidiness: without it
 * a ""-keyed UserRole row would hand its roles — `admin` included — to every
 * non-canonicalizable principal, with no grant path and therefore no escalation
 * guard firing (I-8d corollary).
 */
export async function getUserRoles(
  db: PrismaClient,
  userID: string | undefined | null,
): Promise<Role[]> {
  if (!userID) return [];
  const row = await db.userRole.findUnique({ where: { userID } });
  const stored = row?.roles?.length ? row.roles : row?.role ? [row.role] : [];
  return normalizeStoredRoles(stored);
}

export async function isAdmin(
  db: PrismaClient,
  userID: string | undefined | null,
): Promise<boolean> {
  return (await getUserRoles(db, userID)).includes(ADMIN_ROLE);
}

/** admin or jcrc — may reach the role-management surface at all. */
export function canManageRoles(roles: readonly string[]): boolean {
  return roles.includes(ADMIN_ROLE) || roles.includes(JCRC_ROLE);
}

/**
 * Facility requirement, OR-set. NOTE the absence of `if (!row) return []` and
 * of any other early `return []` — those were the two default-OPEN paths, and
 * under I-10 a missing row and an empty array are the SAME state, not two.
 */
export async function getFacilityRequiredRoles(
  db: PrismaClient,
  facilityID: number,
): Promise<string[]> {
  const row = await db.facilityAccess.findUnique({ where: { facilityID } });
  if (row?.requiredRoles?.length) return row.requiredRoles;
  if (row?.requiredRole) return [row.requiredRole]; // legacy dual-write window
  return [...DEFAULT_REQUIRED_ROLES];
}

/* -------------------------------------------------------------------------- */
/* Predicates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * D-1 pure predicate. NOTE the absence of
 * `if (requiredRoles.length === 0) return true` — that short-circuit WAS the
 * lockout inversion (I-10). An empty requirement re-defaults to ["resident"]
 * here as well, so a caller that forgets to apply the default cannot open a
 * room by accident.
 *
 * This is also the single function 07-cca-future.md will edit to make
 * `cca_head` per-CCA scoped. Nothing else on the booking path consults CcaHead.
 */
export function canBookWithRoles(
  userRoles: readonly string[],
  requiredRoles: readonly string[],
): boolean {
  if (userRoles.includes(ADMIN_ROLE)) return true; // implicit bypass, never stored
  const req = requiredRoles.length ? requiredRoles : DEFAULT_REQUIRED_ROLES;
  return req.some((r) => userRoles.includes(r));
}

/**
 * Pre-D-1 predicate, byte-identical to the semantics of the version of this
 * file that is deployed today. Used ONLY by enforcement mode "off".
 *
 * `off` must NOT be blanket-allow: SCRC Room is gated today, and a kill switch
 * that returned true unconditionally would silently un-gate every currently
 * gated room for the whole soak window and for the entire duration of any
 * revert — a security regression introduced by the safety mechanism (I-11).
 *
 * It takes the RAW stored requirement, never the ["resident"] default: applying
 * the default here would make "off" enforce D-1, which is the opposite of a
 * kill switch.
 */
function canBookLegacy(
  userRoles: readonly string[],
  rawRequiredRoles: readonly string[],
): boolean {
  if (rawRequiredRoles.length === 0) return true; // pre-D-1 open-to-all
  if (userRoles.includes(ADMIN_ROLE)) return true;
  return rawRequiredRoles.some((r) => userRoles.includes(r));
}

/** Raw (un-defaulted) requirement, for the legacy path and the bulk map. */
function rawRequired(row: {
  requiredRoles?: string[] | null;
  requiredRole?: string | null;
} | null): string[] {
  if (row?.requiredRoles?.length) return row.requiredRoles;
  if (row?.requiredRole) return [row.requiredRole];
  return [];
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

export type BookDenialReason =
  | "NO_IDENTITY"
  | "NOT_ELIGIBLE"
  | "NOT_RESIDENT"
  | "ROLE_REQUIRED";

export type BookDecision =
  | { ok: true }
  | { ok: false; reason: BookDenialReason; requiredRoles: string[] };

/**
 * Full D-1 evaluation with a STRUCTURED denial, so the UI can say WHY instead
 * of a bare FORBIDDEN. The reason codes are disjoint from matricProcedure's
 * MATRIC_REQUIRED on purpose: triage of a lockout must not have to guess which
 * gate fired.
 *
 * `email` is OPTIONAL and must be the caller's VERIFIED session email. Callers
 * on a real request path (createBooking, updateBooking) pass
 * `ctx.session.user.email`; admin.explainAccess deliberately does NOT, because
 * it evaluates AS a third party and must not mint that party a baseline as a
 * side effect of being inspected. Omitting it on a real request path silently
 * downgrades a recoverable NOT_RESIDENT into a hard denial.
 *
 * This function ignores the kill switch by design — it is the D-1 evaluator.
 * `evaluateBookingWithMode` is the enforcement entry point.
 */
export async function evaluateBooking(
  db: PrismaClient,
  userID: string | null | undefined,
  facilityID: number,
  email?: string | null,
): Promise<BookDecision> {
  const [required, roles] = await Promise.all([
    getFacilityRequiredRoles(db, facilityID),
    getUserRoles(db, userID),
  ]);

  if (canBookWithRoles(roles, required)) return { ok: true };
  if (!userID) return { ok: false, reason: "NOT_ELIGIBLE", requiredRoles: required };

  if (!roles.includes(BASELINE_ROLE)) {
    // REPAIR-ON-DENY (I-8b, second site). The session callback already tried
    // once this request; if its write failed, retry here — on the exact request
    // that needs the baseline — before denying. Bounded: ensureBaseline is
    // circuit-broken per lambda, so a UserRole-scoped outage does not turn every
    // booking attempt into a retry storm.
    //
    // The EMAIL is passed, never the id: ensureBaseline canonicalizes
    // internally, so this site cannot become the provenance hole (I-8d).
    //
    // The honest limit, stated so nobody mistakes this for closure: if the
    // repair fails again, the deny stands. That is lockout mode L-6, and it is
    // MITIGATED + DETECTED (baseline_repair_failed -> admin.systemHealth -> the
    // daily doctor query), not closed. Note a booking is itself a write: if
    // Atlas is refusing writes, createBooking fails regardless of roles, so a
    // general write outage is not a DIFFERENTIAL lockout. What is genuinely
    // worse than the derived design is a PARTIAL failure — writes succeeding
    // elsewhere but failing on UserRole.
    if (email && isCanonicalResidentID(userID) && (await ensureBaseline(db, email))) {
      const repaired = await getUserRoles(db, userID);
      if (canBookWithRoles(repaired, required)) return { ok: true };
      if (repaired.includes(BASELINE_ROLE)) {
        // Baseline is present now; the room simply needs more than it.
        return { ok: false, reason: "ROLE_REQUIRED", requiredRoles: required };
      }
    }
    return { ok: false, reason: "NOT_RESIDENT", requiredRoles: required };
  }

  return { ok: false, reason: "ROLE_REQUIRED", requiredRoles: required };
}

/**
 * Kill-switch-aware. THE enforcement entry point for createBooking and
 * updateBooking. Nothing on the booking path may call `evaluateBooking`
 * directly — that would bypass I-11.
 */
export async function evaluateBookingWithMode(
  db: PrismaClient,
  userID: string | null | undefined,
  facilityID: number,
  email?: string | null,
): Promise<BookDecision> {
  // 08 §1.1: ABOVE the mode branch, deliberately. `canonicalUserID` returns ""
  // for any address that is not @u.nus.edu, so a non-NUS session reaches here
  // with an empty identity — and the "off" branch below returns before any
  // identity check while canBookLegacy allows an empty requirement, so without
  // this the default shipping config writes `Bookings.userID: ""`. Those rows
  // are invisible to their creator and collide with each other in the userDict
  // join (facilitiesBooking.ts:215-230).
  //
  // This one denial is NOT shadowed in `permissive`. Permissive exists to
  // shadow the ROLE rollout — to learn who WOULD be denied by D-1 before anyone
  // is hurt — not to permit unattributable writes. An empty identity is not a
  // policy question: there is no mode in which an unownable booking row is the
  // correct outcome, so it denies in off, permissive and enforce alike.
  //
  // Distinct reason code, NOT "NOT_RESIDENT": the shadow-denial log is the
  // permissive -> enforce go/no-go signal, and conflating "has no canonical id"
  // with "lacks the baseline" corrupts it. They need different remediation.
  if (!userID) {
    // Audited even though it is a hard deny, because this log IS the §2
    // measurement of the affected population. Best-effort, like the shadow
    // write below: an audit failure must never change the decision.
    //
    // The caller's `email` is deliberately NOT written into an id column: a
    // non-canonical value in a *ID field is the exact disease this doc is
    // about. Attribution comes from the doctor's non-NUS user list (§2).
    try {
      await db.roleAuditLog.create({
        data: {
          actorUserID: "(anon)",
          actorRoles: [],
          targetUserID: null,
          targetFacilityID: facilityID,
          action: "booking.denied.no_identity",
          rolesBefore: [],
          rolesAfter: [],
          ok: false,
          denyReason: "NO_IDENTITY",
        },
      });
    } catch {
      /* best effort */
    }
    return { ok: false, reason: "NO_IDENTITY", requiredRoles: [] };
  }

  const mode = await getEnforcementMode(db);

  if (mode === "off") {
    // Legacy branch. Reads the RAW requirement and skips the role lookup
    // entirely when nothing is required, reproducing today's query shape as
    // well as today's semantics.
    const row = await db.facilityAccess.findUnique({ where: { facilityID } });
    const legacyRequired = rawRequired(row);
    const roles = legacyRequired.length ? await getUserRoles(db, userID) : [];
    return canBookLegacy(roles, legacyRequired)
      ? { ok: true }
      : { ok: false, reason: "ROLE_REQUIRED", requiredRoles: legacyRequired };
  }

  const decision = await evaluateBooking(db, userID, facilityID, email);
  if (decision.ok) return decision;

  if (mode === "permissive") {
    // Shadow mode: record the would-be denial and ALLOW. This is the rollout
    // signal — a cluster of NOT_RESIDENT rows names the exact userIDs before
    // anyone is hurt. Best-effort: a shadow audit must never fail a booking.
    try {
      await db.roleAuditLog.create({
        data: {
          // 08 §1.1: FALSY, not nullish. `""` is not nullish, so `??` recorded
          // audit rows with an empty actor — indistinguishable in the log from
          // a genuine id. Unreachable now that the guard above denies an empty
          // identity outright, but the log must not depend on that.
          actorUserID: userID || "(anon)",
          actorRoles: [],
          targetUserID: userID || null,
          targetFacilityID: facilityID,
          action: "booking.denied.shadow",
          rolesBefore: [],
          rolesAfter: [],
          ok: false,
          denyReason: decision.reason,
        },
      });
    } catch {
      /* best effort */
    }
    return { ok: true };
  }

  return decision;
}

/**
 * Thin boolean wrapper for callers that do not need the reason code.
 *
 * REWRITTEN for multi-role + default-deny: it is now a wrapper over
 * evaluateBookingWithMode, so it carries the kill switch, the admin bypass, the
 * ["resident"] default and repair-on-deny. It has NO early `return true` of its
 * own. Prefer evaluateBookingWithMode on any user-facing path — discarding the
 * reason code turns every lockout into a support ticket.
 *
 * NOTE the 4th parameter: existing call sites that omit `email` still compile,
 * but they forfeit repair-on-deny. facilitiesBooking.ts is converted in the
 * same commit (02 §4.4).
 */
export async function canBookFacility(
  db: PrismaClient,
  userID: string | undefined | null,
  facilityID: number,
  email?: string | null,
): Promise<boolean> {
  return (await evaluateBookingWithMode(db, userID, facilityID, email)).ok;
}

/**
 * Bulk map for the booking picker. Built from `Facilities`, NOT from
 * `FacilityAccess` — v1 iterated FacilityAccess and therefore could not
 * represent a facility with no row, which under D-1 is the majority case.
 *
 * ADVISORY ONLY (I-7): createBooking remains the enforcement point. It does not
 * repair-on-deny — a picker render must not write.
 */
export async function getBookableFacilityMap(
  db: PrismaClient,
  userID: string | undefined | null,
): Promise<Map<number, { canBook: boolean; requiredRoles: string[] }>> {
  const [facilities, rows, roles, mode] = await Promise.all([
    db.facilities.findMany({ select: { facilityID: true } }),
    db.facilityAccess.findMany(),
    getUserRoles(db, userID),
    getEnforcementMode(db),
  ]);

  const req = new Map(rows.map((r) => [r.facilityID, rawRequired(r)]));
  const out = new Map<number, { canBook: boolean; requiredRoles: string[] }>();
  for (const f of facilities) {
    const raw = req.get(f.facilityID) ?? [];
    const required = raw.length ? raw : [...DEFAULT_REQUIRED_ROLES];
    out.set(f.facilityID, {
      // The picker must agree with the enforcement point, kill switch included,
      // or a room renders enabled and fails at submit (or vice versa).
      canBook: mode === "off" ? canBookLegacy(roles, raw) : canBookWithRoles(roles, required),
      // Always the DEFAULTED set: this is what the UI tells the user is needed,
      // and "nothing is required" is not a state that exists under D-1.
      requiredRoles: required,
    });
  }
  return out;
}

// getUserRole (singular) and getFacilityRequiredRole (singular) are DELETED,
// not deprecated. Invariant I-6: roles[0] is $addToSet insertion order, so a
// user holding ["jcrc","admin"] would silently lose admin at the two
// facilitiesBooking.ts call sites. A deprecated shim would have kept compiling
// and kept being wrong. Use isAdmin() / getUserRoles() /
// getFacilityRequiredRoles() instead.
