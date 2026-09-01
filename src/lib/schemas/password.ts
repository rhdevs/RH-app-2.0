/**
 * Shared password policy — THE one statement of the rule.
 *
 * DELIBERATELY NOT IN `src/lib/password.ts`, and this is a hard constraint
 * rather than a preference: that module imports `bcrypt` and `~/env` at module
 * scope, so a `"use client"` component that imported the policy from there
 * would drag a native Node addon into the browser bundle. The signup and
 * reset-password forms mirror this validation so the user is told what is wrong
 * before a round trip, which means the rule has to live somewhere a client
 * component can value-import.
 *
 * Same convention, and the same reasoning, as `src/lib/schemas/profile.ts`:
 * this file imports NOTHING. Keep it that way.
 *
 * `src/lib/password.ts` re-exports all of this, so server callers can keep
 * importing hashing and policy from one place.
 */

/**
 * BOTH WRITERS CALL `validatePassword`. `api/register/route.ts` and
 * `api/reset-password/route.ts` each previously held a private
 * `password.length < 8`, which is exactly the shape that lets a hardening land
 * on the account-creation path and silently miss the account-recovery one — so
 * an attacker who cannot register a weak password can still reset to one.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * BCRYPT SILENTLY TRUNCATES AT 72 BYTES. It does not error and it does not
 * warn: the 73rd byte onward is simply not hashed, so a 100-character password
 * and its own 72-byte prefix produce the SAME hash and both authenticate. That
 * is a genuine surprise for anyone using a password manager with a long
 * generated string, and it is invisible from the outside.
 *
 * Refusing at the boundary makes the truncation impossible to hit rather than
 * silently tolerated. BYTES, not characters — the limit bcrypt applies is on
 * the UTF-8 encoding, so an emoji or an accented character costs more than one.
 *
 * This is NOT a DoS guard: bcrypt's cost is fixed by the round count and does
 * not grow with input length, so a long password is not an expensive one.
 */
export const PASSWORD_MAX_BYTES = 72;

/**
 * Passwords that clear the length rule by padding rather than by entropy. This
 * is deliberately SHORT and is not a breach corpus — it exists to catch the
 * handful of strings a 12-character minimum actively encourages people to
 * invent ("password1234"), not to be a substitute for a real k-anonymity check
 * against Have I Been Pwned. If that check is ever added it belongs inside
 * `validatePassword`, not in either route.
 */
const WEAK_PASSWORDS = new Set([
  "password1234",
  "password123456",
  "passwordpassword",
  "123456789012",
  "1234567890123",
  "qwertyuiopas",
  "qwerty123456",
  "letmein12345",
  "iloveyou1234",
  "administrator",
  "rhapppassword",
  "raffleshall12",
]);

/**
 * `TextEncoder`, NOT `Buffer.byteLength` — this module runs in the browser as
 * well as on the server, and `Buffer` does not exist there. Both count UTF-8
 * bytes, which is the unit bcrypt's 72-byte limit is expressed in.
 */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Returns a user-facing error string, or `null` when the password is
 * acceptable. A STRING RATHER THAN A THROW because both routes turn it straight
 * into a 400 body and both forms turn it straight into a toast; every message
 * here is safe to show, since none of them depends on server state or on
 * whether the account exists.
 */
export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password should be at least ${PASSWORD_MIN_LENGTH} characters long.`;
  }
  if (utf8Bytes(password) > PASSWORD_MAX_BYTES) {
    return `Password must be at most ${PASSWORD_MAX_BYTES} bytes.`;
  }
  if (WEAK_PASSWORDS.has(password.trim().toLowerCase())) {
    return "That password is too easy to guess. Please choose another.";
  }
  return null;
}
