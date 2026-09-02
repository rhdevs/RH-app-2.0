/**
 * DO NOT BUMP `bcrypt` TO 6.x WITHOUT VERIFYING IT ON A VERCEL DEPLOYMENT FIRST.
 * It is pinned to 5.x deliberately, and this is not caution — it is a rollback.
 *
 * WHAT HAPPENED. bcrypt 6.0.0 changed how it ships its native binary: 5.x uses
 * node-pre-gyp and installs to `lib/binding/napi-v3/bcrypt_lib.node`, while 6.x
 * uses the prebuildify layout, `prebuilds/<platform>/bcrypt.node`. Next.js
 * output-file tracing bundles the former into the serverless function and MISSES
 * the latter, so the module throws at import time in the lambda.
 *
 * `auth.ts` imports `verifyPassword` from this file at module scope, so that
 * import failure took down EVERY route that touches auth: `/api/auth/session`
 * returned 500, and with it every page calling `auth()`. Nobody could sign in.
 *
 * IT PASSES EVERY LOCAL CHECK. `tsc`, `eslint`, `next build` and even a direct
 * `require('bcrypt')` in Node all succeed, because the binary is present on the
 * build machine. The Vercel BUILD succeeds too. It fails only at RUNTIME inside
 * the deployed function, which is the one place none of those checks look.
 *
 * THE REAL FIX, if the tar advisory that 5.x drags in via node-pre-gyp matters
 * enough, is `bcryptjs` — pure JavaScript, no native addon, hash-format
 * compatible with the `$2a$`/`$2b$` digests already in `User.passwordHash`. That
 * removes this entire failure class rather than pinning around it. It is a
 * deliberate change to the authentication path and deserves its own PR.
 */
import bcrypt from "bcrypt";
import { createHash, timingSafeEqual } from "crypto";

import { env } from "~/env";

/**
 * Centralized password hashing (#3).
 *
 * The codebase historically stored unsalted SHA-256 hex digests (64 hex chars)
 * for password hashes, written from several places. This module makes bcrypt
 * the single source of truth and transparently upgrades any legacy SHA-256 hash
 * to bcrypt the next time the user authenticates successfully.
 */

const BCRYPT_ROUNDS = env.BCRYPT_ROUNDS;

/** True for a bcrypt modular-crypt hash ($2a$/$2b$/$2y$...). */
function isBcryptHash(hash: string): boolean {
  return /^\$2[aby]\$/.test(hash);
}

/** True for a legacy 64-char lowercase-hex SHA-256 digest. */
function isLegacySha256Hash(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

/** Constant-time comparison of two SHA-256 hex digests. */
function legacySha256Matches(password: string, hash: string): boolean {
  const candidate = createHash("sha256").update(password).digest("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * THE POLICY LIVES IN `~/lib/schemas/password` AND IS RE-EXPORTED HERE.
 *
 * It cannot live in this file: this module imports `bcrypt` (a native Node
 * addon) and `~/env` at module scope, and the signup and reset-password forms
 * are `"use client"` components that mirror the same validation so the user is
 * told what is wrong before a round trip. Importing the policy from here would
 * drag bcrypt into the browser bundle.
 *
 * Re-exported rather than left for callers to find, so server code keeps
 * importing hashing and policy from one place and there is no second spelling
 * of "where do I get the password rule".
 */
export {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_BYTES,
  validatePassword,
} from "~/lib/schemas/password";

/** Hash a new/updated password with bcrypt. */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export interface VerifyResult {
  /** Whether the supplied password matched the stored hash. */
  valid: boolean;
  /**
   * A bcrypt hash to persist in place of the stored one, present only when the
   * stored hash was a legacy SHA-256 digest and the password matched. Callers
   * should write it back to upgrade the user transparently.
   */
  upgradedHash?: string;
}

/**
 * Verify a password against a stored hash, supporting both bcrypt and legacy
 * SHA-256 hashes. On a successful legacy match, returns `upgradedHash` so the
 * caller can rehash-on-login.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<VerifyResult> {
  if (isBcryptHash(storedHash)) {
    return { valid: await bcrypt.compare(password, storedHash) };
  }

  if (isLegacySha256Hash(storedHash)) {
    if (legacySha256Matches(password, storedHash)) {
      return { valid: true, upgradedHash: await hashPassword(password) };
    }
    return { valid: false };
  }

  // Unknown hash format — fail closed.
  return { valid: false };
}
