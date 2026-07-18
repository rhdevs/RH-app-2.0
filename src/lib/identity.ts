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
 * Returns "" for anything that is not a valid @u.nus.edu address.
 *
 * This is a BEHAVIOUR CHANGE from src/server/auth.ts:135-137, which used an
 * unanchored .replace() with no .trim() and returned e.g. "ALICE@GMAIL.COM" —
 * a garbage-but-truthy string that was then usable as a role key. Returning ""
 * makes `canonicalUserID(e) !== ""` exactly equivalent to
 * `isNusStudentEmail(e)`, so the sign-in gate and the role key cannot disagree.
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
export function canonicalUserID(email: string | null | undefined): string {
  const m = NUS_STUDENT_EMAIL.exec(normalizeEmail(email).toUpperCase());
  return m ? m[1]! : "";
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
 * provenance was never established. Note also that an `EXT:`-namespaced
 * allowlist pin would pass this test.
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
  return typeof userID === "string" && userID.length > 0 && !userID.includes("@");
}

/** @deprecated Alias of isCanonicalResidentID — see the note above. */
export const isResidentEligible = isCanonicalResidentID;

/** Rendered by /login. */
export const AUTH_ERROR = { NOT_NUS_EMAIL: "NotNusEmail" } as const;
