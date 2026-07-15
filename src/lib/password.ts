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
