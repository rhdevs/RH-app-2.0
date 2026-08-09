import type { PrismaClient } from "@prisma/client";

import type { CanonicalUserID } from "~/lib/identity";
import { asExtUserID, canonicalUserID, normalizeEmail } from "~/lib/identity";

/**
 * THE D-7 BREAK-GLASS ALLOWLIST — the COLLECTION variant of
 * 08-userid-keydrift.md §3 Branch C, and the read side of the `AuthAllowlist`
 * model in prisma/schema.prisma.
 *
 * WHAT IT IS FOR. Hall office staff have `@nus.edu.sg` addresses. That domain
 * is deliberately NOT admitted by the domain rule (src/lib/identity.ts explains
 * why: it is the whole university rather than Raffles Hall, and under D-1
 * admitting a domain auto-grants hall booking rights to every address in it).
 * So a staff principal has `canonicalUserID(email) === null` and therefore no
 * identity key at all — no roles, no bookings, nothing. One admin-issued row
 * here PINS such an address to a stable key in the `EXT:` namespace.
 *
 * SERVER-ONLY. It touches Prisma. It must never be imported by a `"use client"`
 * file — that is exactly why the pure predicates it composes (`EXT_ID`,
 * `isExtUserID`, `asExtUserID`) live in src/lib/identity.ts and not here.
 *
 * ---------------------------------------------------------------------------
 * WHY `canonicalUserID` WAS NOT MADE TO CONSULT THIS
 * ---------------------------------------------------------------------------
 * 08-userid-keydrift.md §3 Branch C says canonicalUserID should consult the
 * allowlist for addresses failing the domain rule. THAT IS NOT IMPLEMENTABLE.
 * src/lib/identity.ts is declared PURE — no Prisma, no `~/env`, no
 * `next/server` — because client components value-import from it, and
 * `canonicalUserID` is synchronous at ~30 call sites. Making it async and impure
 * would break all of them, break scripts/remediation/lib/identity.mjs (which
 * cannot connect to anything), and put a database read behind
 * verify-identity-parity.mjs's assertion that `canonicalUserID(e) !== null` is
 * exactly `isNusStudentEmail(e)` — an equivalence that must stay pure.
 *
 * So resolution is a SEPARATE, COMPOSED step:
 *
 *     resolvePrincipalID(db, email) = canonicalUserID(email)
 *                                  ?? await pinnedUserIDFor(db, email)
 *
 * canonicalUserID is untouched. This module is the only thing that knows the
 * allowlist exists.
 *
 * ---------------------------------------------------------------------------
 * THE ATTACK, AND THE FOUR MECHANISMS
 * ---------------------------------------------------------------------------
 * 05-verification.md §164: a single row
 * `{ email: "attacker@gmail.com", pinnedUserID: "E1633673" }` would yield a
 * session whose role key IS an admin's, inheriting every `UserRole` and
 * `RoleAuditLog` row under it. There is NO grant path in that story, so NO
 * escalation guard fires: `auth.ts` and `access.ts` both do a bare
 * `db.userRole.findUnique({ where: { userID } })`, and whatever string lands in
 * `session.user.userID` simply IS the authorization key. Nothing downstream can
 * save you. Four independent mechanisms, in the order they fire:
 *
 *   M1  NAMESPACE DISJOINTNESS BY CONSTRUCTION. `NUS_STUDENT_EMAIL`'s capture
 *       class is `[A-Z0-9._%-]`, which excludes ':'. `EXT_ID` requires one.
 *       canonicalUserID therefore CANNOT return a string matching EXT_ID, for
 *       any input, ever. Not a convention — a property of the two regexes,
 *       asserted per fixture by verify-identity-parity.mjs.
 *   M2  READ-SIDE ENFORCEMENT, HERE. `pinnedUserIDFor` runs `asExtUserID` on
 *       the value it READ BACK OUT OF MONGO and returns the ABSENT value if it
 *       fails. THIS IS THE MECHANISM THAT SURVIVES A COMPROMISED WRITE PATH: a
 *       row typed by hand in Atlas, or written by some future code path that
 *       skipped the zod schema, mints NO IDENTITY AT ALL. M4 alone would not
 *       give you that — it only governs the writes it can see.
 *   M3  UNIQUENESS, ENFORCED IN MONGO. `pinnedUserID` carries an explicitly
 *       created unique index (scripts/remediation/create-auth-allowlist.mjs).
 *       A Prisma `@unique` on Mongo with no such index is decoration.
 *   M4  THE WRITE IS adminProcedure, AUDITED, AND REFUSES THREE SHAPES
 *       (admin.addAuthAllowlistEntry): EMAIL_IS_CANONICAL, a non-EXT pin (zod),
 *       and PIN_ALREADY_HAS_ROLES.
 *
 * M2 is not redundant with M4. Deleting it because "the write already checks"
 * is the change that re-opens the attack.
 *
 * ---------------------------------------------------------------------------
 * COST, AND WHY THE HOT PATH IS UNCHANGED
 * ---------------------------------------------------------------------------
 * `resolvePrincipalID`'s `??` short-circuits: for a canonical @u.nus.edu
 * address — which is all live traffic, ~1382 accounts — it returns WITHOUT
 * TOUCHING THE DATABASE. auth.ts's session-callback rule 2 ("steady state must
 * issue ZERO reads beyond the two indexed findUniques") is preserved exactly.
 * Only a NON-canonical session pays, and it pays one `findUnique` on a unique
 * index over a collection holding single-digit rows, behind a 15s cache.
 *
 * IT MUST NEVER THROW. auth.ts's session-callback rule 1: a rejected session
 * callback FORCE-LOGS-OUT the user, and on the hot path that is a mass
 * availability event. Everything here is wrapped and degrades to the ABSENT
 * identity — fail CLOSED, which reproduces today's behaviour exactly (today
 * these addresses already resolve to null).
 */

/** Matches ccaScope.ts's flag cache and every SystemFlag cache in access.ts. */
const CACHE_TTL_MS = 15_000;

/**
 * TWO MAPS, NOT ONE, AND THE SPLIT IS A SECURITY DECISION.
 *
 * `pinnedUserIDFor` is reachable from UNAUTHENTICATED endpoints — `maySignIn`
 * on both sign-in paths, and the password-reset request route. So the KEY SPACE
 * OF THE MISS CACHE IS ATTACKER-CONTROLLED: anyone can make this module observe
 * an address that has never existed. The key space of the HIT cache is not — a
 * hit requires a real `AuthAllowlist` row, and that collection is written only
 * by an audited adminProcedure and is meant to hold single digits.
 *
 * A SINGLE SHARED MAP LETS THE ATTACKER-CONTROLLED HALF EVICT THE OTHER. The
 * first version of this was one map with `if (size >= MAX) cache = new Map()` —
 * wholesale replacement, not eviction. Cycling more than MAX addresses through
 * the reset route therefore wiped the map every MAX requests, and each wipe took
 * the handful of REAL pinned identities with it. Nothing broke — every read
 * degrades to a query — but the cache stopped existing during exactly the
 * traffic it most needed to absorb, and the session path (which shares this
 * module) paid a database round-trip per request for the duration. Cache
 * behaviour under adversarial load should not be "turn the cache off".
 *
 * Split, a flood of unknown addresses can only churn `missCache`. A pinned
 * identity's cached hit is unreachable from that traffic, by construction.
 *
 * Both maps are still BOUNDED and now evict OLDEST-FIRST (JS Map iterates in
 * insertion order, and `cacheGet` re-inserts on a hit, which makes that
 * recency order). Bounded because an unbounded map on a lambda is a memory
 * leak; oldest-first because dropping one stale entry is the correct response
 * to pressure and dropping everything is not.
 */
const HIT_CACHE_MAX = 200;
const MISS_CACHE_MAX = 200;

type CacheEntry = { at: number; id: CanonicalUserID | null };
let hitCache = new Map<string, CacheEntry>();
let missCache = new Map<string, CacheEntry>();

/**
 * Test/ops seam, and — more importantly — the thing every allowlist WRITE must
 * call. Without it, adding or removing a pin would take up to CACHE_TTL_MS to
 * be observable, and a REMOVAL that is not observable is a revocation that has
 * not happened.
 *
 * Clears BOTH maps. A newly added pin's address is almost certainly sitting in
 * `missCache` from whatever attempt prompted the operator to add it, so
 * clearing only the hits would leave the new identity invisible for 15s on the
 * one path that matters.
 */
export function resetAuthAllowlistCache(): void {
  hitCache = new Map();
  missCache = new Map();
}

/** Evict oldest-first until there is room for one more. */
function evictOldest(map: Map<string, CacheEntry>, max: number): void {
  while (map.size >= max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

function cacheGet(email: string): CacheEntry | undefined {
  const map = hitCache.has(email)
    ? hitCache
    : missCache.has(email)
      ? missCache
      : null;
  if (!map) return undefined;

  const hit = map.get(email)!;
  if (Date.now() - hit.at >= CACHE_TTL_MS) {
    map.delete(email);
    return undefined;
  }
  // Re-insert to move this key to the END of the iteration order, which is what
  // makes `evictOldest` above LEAST-RECENTLY-USED rather than
  // least-recently-written. Without it a pinned address read a thousand times
  // would still age out ahead of a miss written once.
  map.delete(email);
  map.set(email, hit);
  return hit;
}

function cacheSet(email: string, id: CanonicalUserID | null): void {
  // A hit and a miss for the same key must not coexist — the answer changed, so
  // the other map's copy is stale. Cheap, and it keeps `cacheGet`'s two-map
  // lookup unambiguous.
  const target = id === null ? missCache : hitCache;
  const other = id === null ? hitCache : missCache;
  other.delete(email);
  evictOldest(target, id === null ? MISS_CACHE_MAX : HIT_CACHE_MAX);
  target.set(email, { at: Date.now(), id });
}

/**
 * The pinned principal key for an address, or the ABSENT value.
 *
 * HITS AND MISSES ARE BOTH CACHED. A miss is the COMMON case here — every
 * legacy non-NUS `User` row that still holds a session resolves to null — so
 * caching only hits would leave exactly the population this function exists to
 * be cheap for paying a query every request.
 *
 * THE ERROR PATH IS DELIBERATELY NOT CACHED, the same way isCcaManagementEnabled
 * does it: the next request retries rather than pinning a wrong answer for 15
 * seconds on a transient Atlas hiccup. Pinning "absent" would sign an
 * allowlisted user out for 15s per fault; pinning it after a write is worse.
 *
 * M2 LIVES ON THE RETURN STATEMENT. `asExtUserID(row.pinnedUserID)` re-validates
 * the namespace on the value we just read, so a row whose pin is `E1633673`
 * yields NOTHING — not an identity, not an error, not a partial. The structured
 * console.error is how such a row becomes visible: it can only have arrived by
 * a hand edit in Atlas or by a code path that bypassed the zod schema, and both
 * of those are worth an alert.
 */
export async function pinnedUserIDFor(
  db: PrismaClient,
  rawEmail: string | null | undefined,
): Promise<CanonicalUserID | null> {
  // I-12: THE shared normalizer, never a private copy. A private
  // `.toLowerCase()` here would miss the `.trim()`, and `AuthAllowlist.email`
  // must match `User.email` byte for byte (email_unique_ci folds CASE but not
  // WHITESPACE). verify-identity-parity.mjs bans private derivations by source
  // scan for exactly this reason.
  const email = normalizeEmail(rawEmail);
  if (!email) return null;

  const cached = cacheGet(email);
  if (cached) return cached.id;

  try {
    const row = await db.authAllowlist.findUnique({
      where: { email },
      select: { pinnedUserID: true },
    });
    if (!row) {
      cacheSet(email, null);
      return null;
    }

    // ---- M2 ------------------------------------------------------------
    const pin = asExtUserID(row.pinnedUserID);
    if (pin === null) {
      console.error(
        JSON.stringify({
          evt: "allowlist_pin_namespace_violation",
          email,
          pin: row.pinnedUserID,
        }),
      );
      // Cache the refusal like any other miss. The row is not going to start
      // being valid within 15 seconds, and a poisoned row must not become a
      // per-request query amplifier on top of everything else.
      cacheSet(email, null);
      return null;
    }

    cacheSet(email, pin);
    return pin;
  } catch (err) {
    // FAIL CLOSED, UNCACHED. Never rethrow — auth.ts rule 1.
    console.error(
      JSON.stringify({
        evt: "allowlist_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Batch form, for admin.listUsers. Same M2 filter, applied PER ROW.
 *
 * Keyed by NORMALIZED email on both sides — the caller must normalize its
 * lookups too, or a stored `" Ngocanh.Mai@nus.edu.sg"` will silently miss.
 *
 * Deliberately BYPASSES THE CACHE in both directions: it is called once per
 * admin page render on a ≤100-row page, so the hit rate would be near zero, and
 * seeding the shared map from an admin listing would let one operator's page
 * load decide what the session path sees for the next 15 seconds. The session
 * path's cache should be filled by the session path.
 */
export async function pinnedUserIDsFor(
  db: PrismaClient,
  rawEmails: readonly (string | null | undefined)[],
): Promise<Map<string, CanonicalUserID>> {
  const out = new Map<string, CanonicalUserID>();
  const emails = [...new Set(rawEmails.map(normalizeEmail).filter(Boolean))];
  if (emails.length === 0) return out;

  try {
    const rows = await db.authAllowlist.findMany({
      where: { email: { in: emails } },
      select: { email: true, pinnedUserID: true },
    });
    for (const row of rows) {
      const pin = asExtUserID(row.pinnedUserID);
      if (pin === null) {
        console.error(
          JSON.stringify({
            evt: "allowlist_pin_namespace_violation",
            email: row.email,
            pin: row.pinnedUserID,
          }),
        );
        continue;
      }
      out.set(normalizeEmail(row.email), pin);
    }
  } catch (err) {
    // Fail closed: an admin page that renders "no canonical id" is a visible,
    // recoverable inconvenience. Throwing here would 500 the whole user list.
    console.error(
      JSON.stringify({
        evt: "allowlist_batch_lookup_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return out;
}

/**
 * THE resolution step. `canonicalUserID` first, ALWAYS.
 *
 * THE ORDER IS THE HOT PATH, not a preference. For every @u.nus.edu address the
 * left operand is non-null and the right one is never evaluated, so no query is
 * issued and no cache is consulted — which is what keeps auth.ts's rule 2
 * ("ZERO reads in steady state") true after this change. Swapping the operands
 * would put a database read in front of every authenticated request in the app.
 *
 * The env-var allowlist (`AUTH_EMAIL_ALLOWLIST`, in auth.ts's passesDomainRule)
 * is DELIBERATELY NOT CONSULTED HERE. It survives as break-glass for an outage
 * in which the database is the broken thing, and it confers SIGN-IN ONLY: an
 * env-allowlisted address still resolves to the absent identity, holds no roles
 * and cannot book. That asymmetry is the whole point of keeping both.
 */
export async function resolvePrincipalID(
  db: PrismaClient,
  rawEmail: string | null | undefined,
): Promise<CanonicalUserID | null> {
  return canonicalUserID(rawEmail) ?? (await pinnedUserIDFor(db, rawEmail));
}

/**
 * Does a LIVE pin exist for this key? Used by one caller: guard G7's EXT branch
 * in assertCanMutateRoles.
 *
 * G7 asks "can any session ever produce this target key" — it is a REACHABILITY
 * guard, not an authorization one (see its comment in routers/admin.ts). For an
 * E-format id the shape test answers that. For an EXT id it does not: the shape
 * is admin-supplied, and a grant keyed on `EXT:TYPO` would silently write a row
 * no session matches, which is precisely the failure G7 exists to prevent. So
 * the EXT branch demands PROOF OF A LIVE ROW instead — strictly stronger than
 * the shape test it sits beside.
 *
 * UNCACHED, on purpose. It gates a WRITE, and it is reached at most once per
 * role mutation. Reading a 15-second-old answer to "does this pin still exist"
 * on the path that grants privileges is a trade with no upside.
 *
 * Fails CLOSED (false) on fault: a role grant that cannot prove its target is
 * reachable must not proceed.
 */
export async function allowlistPinExists(
  db: PrismaClient,
  pinnedUserID: string,
): Promise<boolean> {
  // Re-validate the shape before spending a query. A caller that hands us
  // something outside the namespace has already made a mistake, and we must not
  // let a `findUnique` on an arbitrary string be the thing that decides.
  if (asExtUserID(pinnedUserID) === null) return false;
  try {
    const row = await db.authAllowlist.findUnique({
      where: { pinnedUserID },
      select: { id: true },
    });
    return row !== null;
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "allowlist_pin_exists_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
