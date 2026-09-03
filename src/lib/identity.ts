/**
 * THE canonical identity rules. Every domain check and every role-key
 * derivation in this codebase comes from this file. Decision D-7 + invariant
 * I-1, and I-12 ("one eligibility predicate").
 *
 * The sign-in gate and the role key are derived from the same string, in the
 * same module, on purpose: if they could drift, an account could pass the gate
 * and then be keyed under an id no backfill ever wrote (or vice versa).
 *
 * PURE. No Prisma, no `~/env`, no `next/server` — it is imported by client
 * components (src/app/login/page.tsx), which is also why this lives in
 * src/lib/ and deliberately NOT src/server/identity.ts. Keep it that way.
 *
 * MIRRORED, verbatim in behaviour, to scripts/remediation/lib/identity.mjs
 * (scripts cannot import TypeScript). I-12 forbids the two from drifting;
 * `node scripts/remediation/verify-identity-parity.mjs` is the gate.
 */

/**
 * Anchored, ASCII-only. Each property is load-bearing:
 *   ^...$        rejects bob@u.nus.edu.evil.com
 *   single @     rejects bob@evil.com@u.nus.edu (the class excludes '@')
 *   no dot in
 *   the localpart
 *   boundary     rejects bob@sub.u.nus.edu — the '@' must be immediately
 *                followed by the literal domain
 *   [A-Z0-9._%-] ASCII only, so a Cyrillic-е homograph domain cannot match
 *   NO '+'       e1234567+x@u.nus.edu would canonicalise to a DIFFERENT key
 *                for the same human — a duplicate-account vector. Gate 0.2(2)
 *                must confirm no plus-addressed account exists before shipping.
 *
 * Note the domain is `u.nus.edu` and NOT `nus.edu` / `nus.edu.sg`: a staff
 * address is the whole university rather than Raffles Hall, it has no
 * E-localpart to canonicalise, and under D-1 admitting a domain now means
 * auto-granting hall booking rights to it. Staff are admitted individually via
 * the AUTH_EMAIL_ALLOWLIST break-glass, which confers sign-in and nothing else.
 */
const NUS_STUDENT_EMAIL = /^([A-Z0-9._%-]+)@U\.NUS\.EDU$/;

/** `.trim()` is load-bearing: auth.ts historically omitted it. See gate 0.2(2). */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function isNusStudentEmail(email: string | null | undefined): boolean {
  return NUS_STUDENT_EMAIL.test(normalizeEmail(email).toUpperCase());
}

/**
 * A well-formed, non-empty PRINCIPAL KEY. Exactly two things can be one:
 *
 *   1. a NUSNET id derived from an @u.nus.edu address — `canonicalUserID()`;
 *   2. an admin-pinned allowlist id in the `EXT:` namespace — `asExtUserID()`
 *      (08-userid-keydrift.md §3 Branch C, for a principal with no NUS
 *      address).
 *
 * Those two functions are the only DERIVERS, and they both live in this file,
 * so the set of things that can be derived into an authorization key is
 * enumerable by reading one module.
 *
 * THERE IS A THIRD ENTRY POINT AND IT IS WEAKER THAN THE OTHER TWO. SAY SO.
 * `asStoredCanonicalUserID` re-admits a value read back out of Mongo, and it
 * gates on `isCanonicalResidentID` — a SHAPE test: non-empty, and no '@'. It
 * therefore brands strings that NEITHER minting function could ever have
 * produced. `asStoredCanonicalUserID("hello")` is a branded "hello". Read as a
 * security statement, "nothing new can become a key" is FALSE, and it should
 * not be written here as though it were true.
 *
 * What is actually true, and what the property rests on: it is sound only over
 * a value that a KEYED WRITER put in a *ID column, and both of its call sites
 * feed it exactly that — `UserRole.userID`, never `session.user.userID` and
 * never a client-supplied field. Its own doc comment states the rule and the
 * misuse; this paragraph exists so the summary above does not quietly cancel
 * it. If a third call site ever hands it something an operator or a request
 * body supplied, the enumerability claim at the top of this comment stops
 * holding — and nothing in the type system will say so, because the brand is
 * exactly what that function hands out.
 *
 * The NAME still says "canonical" because widening it to `PrincipalUserID`
 * would have touched ~30 call sites, each one a chance to get a guard wrong,
 * for zero runtime difference (the brand is erased). What widened is the
 * MEANING, stated here; what did not widen is the guarantee, which was never
 * "this came from NUS" — see isCanonicalResidentID's provenance note.
 *
 * The brand exists so the ABSENT identity can leave the `string` domain
 * entirely (09 §5.2, D-B). Before C9 absence was `""` — an in-band member of
 * the value domain, which `where: {userID}`, `a === b`, `dict[k]` and
 * `k ?? fallback` all accept silently (09 §0.1, condition 2). `null` is
 * out-of-band and `strictNullChecks` reports every site that spends it, so
 * `tsc --noEmit` IS the sweep, permanently.
 *
 * The brand itself prevents RE-widening (an arbitrary string being passed
 * where a canonical key is expected); the `| null` is what prevents emptiness.
 * Both are needed — see 09 §5.4's "branding alone" row.
 *
 * Erased at runtime: a CanonicalUserID is exactly the string it wraps, so no
 * serialized shape changes and nothing needs the brand back after JSON.parse.
 */
export type CanonicalUserID = string & { readonly __brand: "CanonicalUserID" };

/**
 * THE EXTERNAL IDENTITY NAMESPACE. An admin-pinned key for a principal that has
 * no @u.nus.edu address — hall office staff, whose addresses are @nus.edu.sg
 * (08-userid-keydrift.md §3 Branch C). One `AuthAllowlist` row pins one address
 * to one of these.
 *
 * THE ':' IS THE WHOLE MECHANISM (M1). NUS_STUDENT_EMAIL's capture class is
 * `[A-Z0-9._%-]` — it does not contain ':' — so `canonicalUserID()` can NEVER
 * return a string matching this pattern, for ANY input, because every character
 * it can return comes from that class. The two key spaces are PROVABLY
 * DISJOINT, not conventionally separate.
 *
 * That is what makes the attack in 05-verification.md §164 —
 * `{ email: "attacker@gmail.com", pinnedUserID: "E1633673" }`, which would
 * hand an admin's authorization key to a stranger with NO grant path and
 * therefore NO escalation guard firing — UNREPRESENTABLE rather than merely
 * refused. `isExtUserID("E1633673")` is false, and the parity gate asserts it.
 *
 * Uppercase and `_` only, so a pin is legible in `RoleAuditLog.actorUserID` and
 * greppable across collections. Length-bounded at both ends: the 3-char floor
 * keeps `EXT:` alone from being a key, and the 32-char ceiling stops an id
 * being used to smuggle a payload into an audit row.
 *
 * A pin is ADMIN-SUPPLIED AND VALIDATED, never auto-derived at read time — see
 * services/authAllowlist.ts.
 */
export const EXT_ID = /^EXT:[A-Z0-9_]{3,32}$/;

/** Pure shape test over the EXT namespace. See EXT_ID for why ':' matters. */
export function isExtUserID(id: string | null | undefined): boolean {
  return typeof id === "string" && EXT_ID.test(id);
}

/**
 * The ONE minting function for the EXT half of the brand — the exact mirror of
 * `asStoredCanonicalUserID` for the canonical half, and A RUNTIME CHECK, NEVER
 * A CAST. Every EXT id in this codebase passes through here.
 *
 * It is what `pinnedUserIDFor` calls on the value it READ BACK OUT OF MONGO
 * (mechanism M2), which is the half that survives a compromised write path: a
 * row typed by hand in Atlas, or written by some future code path that skipped
 * the zod schema, mints NO IDENTITY AT ALL rather than a bad one. The
 * admin-only audited write (M4) alone would not give you that — it only
 * governs the writes it can see.
 */
export function asExtUserID(
  id: string | null | undefined,
): CanonicalUserID | null {
  return isExtUserID(id) ? (id as CanonicalUserID) : null;
}

/**
 * Returns null for anything that is not a valid @u.nus.edu address.
 *
 * This is a BEHAVIOUR CHANGE from src/server/auth.ts:135-137, which used an
 * unanchored .replace() with no .trim() and returned e.g. "ALICE@GMAIL.COM" —
 * a garbage-but-truthy string that was then usable as a role key. Returning an
 * absent value makes `canonicalUserID(e) !== null` exactly equivalent to
 * `isNusStudentEmail(e)`, so the sign-in gate and the role key cannot disagree.
 *
 * RUNTIME BEHAVIOUR IS UNCHANGED from the `""` era: both `""` and `null` are
 * falsy, so every pre-existing `if (!userID)` guard keeps working identically.
 * Only the TYPE moved. `scripts/remediation/lib/identity.mjs` mirrors this and
 * `verify-identity-parity.mjs` gates the pair.
 *
 * NOTE: the localpart is NOT required to be E-format. `g.s_samuel@u.nus.edu`
 * exists in this database and canonicalises to "G.S_SAMUEL". Never gate
 * eligibility or the resident baseline on /^E\d{7}$/ — that is lockout mode
 * L-27, and it is a real one. E_FORMAT is a validation rule for GRANT TARGETS
 * only (roles.ts `isEFormatUserID`, guard G7). Under the STORED baseline the
 * blast radius has increased: the same predicate now gates the WRITE, so an
 * E-format test here withholds the baseline permanently rather than
 * mis-deriving it once.
 */
export function canonicalUserID(
  email: string | null | undefined,
): CanonicalUserID | null {
  const m = NUS_STUDENT_EMAIL.exec(normalizeEmail(email).toUpperCase());
  return m ? (m[1]! as CanonicalUserID) : null;
}

/**
 * A BARE NUSNET ID AS A HUMAN TYPES IT — `E1234567`, but also `MARCUS-CHUA` —
 * back to the canonical key. For the identifier boxes ("NUSNET id, email, or
 * matric") and for pasted bulk input, where the operator omits the domain.
 *
 * WHY IT ROUTES THROUGH canonicalUserID AND DOES NOT TEST A SHAPE. Every
 * lookup that wanted this used `isEFormatUserID` — /^E\d{7}$/ — as its
 * stand-in, and that predicate does not describe NUSNET ids, it describes a
 * SUBSET of them. Measured 2026-08-28: 420 of 1624 accounts, 25.9%, have a
 * non-E localpart (`G.S_SAMUEL`, `MARCUS-CHUA`, `NICOLEYAU`). Those people
 * could be granted a headship — resolveCcaHeadTarget resolves them, guard G7
 * admits them, `CcaHead` stores them — but could not be FOUND by the box in
 * front of the grant, so the lockout survived the fix to the grant itself.
 * That is lockout mode L-27 wearing a different hat.
 *
 * Reconstructing the address and canonicalizing it means the value set of this
 * function is a SUBSET of canonicalUserID's, by construction rather than by a
 * second regex kept in sync with the first. Two consequences worth stating:
 *
 *   - M1 STILL HOLDS. `EXT:` cannot come out of here for the same reason it
 *     cannot come out of canonicalUserID: ':' is not in NUS_STUDENT_EMAIL's
 *     capture class, so `EXT:FOO` fails the whole regex and returns null. The
 *     parity gate asserts this over the EXT fixtures rather than trusting the
 *     argument.
 *   - IT PROVES NOTHING ABOUT AN ACCOUNT. It is a spelling conversion, not a
 *     lookup: `canonicalFromNusnetID("ASDF")` is `"ASDF"`. Every caller must
 *     still establish that somebody is behind the key — a `UserRole` row for a
 *     preview, a `User` row for a grant target (I-8d). Callers that skip that
 *     step get a silent wrong-key grant, which is exactly what resolving to a
 *     live account exists to prevent.
 *
 * An input containing '@' returns null: that is an address, and it belongs to
 * canonicalUserID directly. Callers branch on '@' before reaching here.
 */
export function canonicalFromNusnetID(
  raw: string | null | undefined,
): CanonicalUserID | null {
  const s = (raw ?? "").trim();
  if (!s || s.includes("@")) return null;
  return canonicalUserID(`${s}@u.nus.edu`);
}

/**
 * POST-CANONICALIZATION SANITY CHECK on an id. NOT an authorization test and
 * NOT a provenance test — it is a pure SHAPE test and it carries no evidence
 * about where its argument came from.
 *
 * It is sound ONLY over a string that canonicalUserID() has just produced,
 * which is why every baseline writer (ensureBaseline, the register route, the
 * createUser event, the backfill, the merge scripts) takes an EMAIL and
 * canonicalizes internally rather than accepting a caller-supplied id (I-8d).
 * Calling this on an admin-supplied `targetUserID` and concluding that the
 * principal is NUS-verified is exactly the misuse that breaks it — a pasted
 * bulk list would mint stored `resident` rows for principals whose NUS
 * provenance was never established.
 *
 * AN `EXT:`-NAMESPACED ALLOWLIST PIN PASSES THIS TEST. Not hypothetically —
 * `AuthAllowlist` exists and pins are stored in `UserRole.userID`, so
 * `isCanonicalResidentID("EXT:NGOCANH_MAI")` is true today, and the parity gate
 * asserts it as a documented false positive. It is DESIRED there: it is what
 * lets `asStoredCanonicalUserID` re-admit a pin read out of `UserRole` so the
 * admin roster row is a usable grant target.
 *
 * IT IS SAFE ONLY BECAUSE EVERY BASELINE WRITER TAKES AN EMAIL AND
 * CANONICALIZES INTERNALLY (I-8d). `ensureBaseline` returns false at its
 * `!userID` clause — `canonicalUserID("ngocanh.mai@nus.edu.sg")` is null —
 * BEFORE this predicate is ever consulted, so an EXT principal receives no
 * `resident` baseline mechanically rather than by convention (08 §3.4). A
 * future function that takes an ID and mints a baseline breaks this, and the
 * breakage is silent. That property is the load-bearing one; do not remove it
 * without removing this false positive too.
 *
 * Deliberately NOT E_FORMAT.test(id): see canonicalUserID above (L-27).
 *
 * `isCanonicalResidentID` is the name 00-overview.md §2.4 and 02-backend-authz
 * §3.1 settled on, precisely because the older name read like an authorization
 * predicate. `isResidentEligible` is kept as an alias only because
 * 05-verification.md §5 still names it; they are the same function and must
 * stay that way.
 */
export function isCanonicalResidentID(
  userID: string | null | undefined,
): boolean {
  return (
    typeof userID === "string" && userID.length > 0 && !userID.includes("@")
  );
}

/**
 * C9. The ONE checked entry point into the branded domain for an id that was
 * read back from storage rather than derived here — e.g. `UserRole.userID`,
 * which Prisma types `string` because Mongo has no brand.
 *
 * It is a RUNTIME CHECK, not a cast: it applies the same shape test
 * `isCanonicalResidentID` documents above, and returns `null` — the absent
 * value — for anything that fails, including `""`. That is the whole point: a
 * `""`-keyed `UserRole` row (the I-8d red line) enters the app as ABSENT rather
 * than as a usable key, which is what stops it being spent.
 *
 * It carries NO provenance evidence — read `isCanonicalResidentID`'s note.
 * Never use it to launder a CLIENT-supplied id into `CanonicalUserID`; the
 * brand would then assert something the value has not earned, which is the
 * re-widening it exists to prevent.
 */
export function asStoredCanonicalUserID(
  id: string | null | undefined,
): CanonicalUserID | null {
  return isCanonicalResidentID(id) ? (id as CanonicalUserID) : null;
}

/** @deprecated Alias of isCanonicalResidentID — see the note above. */
export const isResidentEligible = isCanonicalResidentID;

/** Rendered by /login. */
export const AUTH_ERROR = { NOT_NUS_EMAIL: "NotNusEmail" } as const;
