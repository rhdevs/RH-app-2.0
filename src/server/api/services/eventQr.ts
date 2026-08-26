import { createHmac, timingSafeEqual } from "node:crypto";
import { TRPCError } from "@trpc/server";

import { env } from "~/env";

/**
 * SERVER ONLY. Never imported from `src/app/**`.
 *
 * This module imports `~/env` and `node:crypto` at module scope, which means it
 * CANNOT be imported from a `"use client"` file — the repo already documents
 * that consequence elsewhere (`services/roles.ts`, `AuditLogTable.tsx`). That
 * is the point: the signing key must not be reachable from the browser bundle.
 * Everything the client legitimately needs — the wire prefix, the refresh
 * interval, the payload parser — lives in `src/lib/schemas/eventAttendance.ts`,
 * which imports nothing but `zod`.
 *
 * THE TOKEN. A resident's QR carries `RH1|{userID}|{token}` where `token` is an
 * HMAC over a purpose string, the canonical userID, and a 30-second window
 * index. It is not a bearer credential for anything else and it dies within
 * thirty seconds, which is what makes photographing someone's screen useless.
 */

/**
 * DOMAIN SEPARATION, AND IT COMES FIRST IN THE PAYLOAD.
 *
 * Today this is the only thing signed with this key. The day a second feature
 * signs something, a token minted for one must not verify against the other.
 * Putting the purpose first means no other payload can be built that collides
 * with an `event-checkin` payload by rearranging its own fields.
 */
const PURPOSE = "event-checkin";

/**
 * Thirty seconds. Long enough that a scan is not a race against the clock,
 * short enough that a forwarded screenshot is dead before it arrives.
 */
const WINDOW_SECONDS = 30;

/**
 * 192 bits of the digest, base64url. The QR has to decode from a phone screen
 * across a table: 32 characters of tag plus a ~10-character userID plus a
 * 3-character prefix is a version-3 QR at error-correction level M, which is
 * comfortable. A 192-bit tag with a 30-second life is not the weak link in
 * anything here.
 */
const TAG_CHARS = 32;

/**
 * Fails CLOSED and LOUDLY. `EVENT_QR_SECRET` is declared `.optional()` in
 * `env.js` so a contributor without it can still build the app (the same shape
 * as `BLOB_READ_WRITE_TOKEN`) — so the check has to happen here, at the point
 * of use, rather than at boot.
 *
 * PRECONDITION_FAILED rather than INTERNAL_SERVER_ERROR: this is a deployment
 * that is missing a value, not a bug, and the door page maps it to copy telling
 * the committee to fall back to the manual list instead of showing a stack
 * trace to someone standing at a door.
 */
function qrSecret(): string {
  const secret = env.EVENT_QR_SECRET;
  if (!secret) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "ATTENDANCE_NOT_CONFIGURED",
    });
  }
  return secret;
}

/**
 * PIPE-SEPARATED, because `EXT:` allowlist ids contain a colon (T-25) and this
 * payload is keyed by a userID. `admin.ts`'s `signRow` already made the same
 * choice for the same reason. `|` is provably absent from both halves of the
 * key space: canonical ids are `[A-Z0-9._%-]+` and allowlist pins are
 * `EXT:[A-Z0-9_]{3,32}` (`src/lib/identity.ts`).
 */
function tag(userID: string, window: number): string {
  return createHmac("sha256", qrSecret())
    .update(`${PURPOSE}|${userID}|${window}`)
    .digest("base64url")
    .slice(0, TAG_CHARS);
}

/** Which 30-second window a UNIX-seconds timestamp falls in. */
export function currentWindow(nowSec: number): number {
  return Math.floor(nowSec / WINDOW_SECONDS);
}

/**
 * Constant-time compare, LENGTH CHECKED FIRST.
 *
 * `timingSafeEqual` THROWS on a length mismatch rather than returning false
 * (T-26), so the guard is load-bearing and not defensive padding. A bare `===`
 * on an HMAC leaks length, which the existing copy of this function in
 * `admin.ts` already calls "a bad habit".
 */
function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(given, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Mint the resident's current token. `expiresAt` is the start of the NEXT
 * window, in UNIX seconds, so the client knows when to refetch.
 */
export function mintCheckInToken(
  userID: string,
  nowSec: number,
): { token: string; expiresAt: number } {
  const w = currentWindow(nowSec);
  return { token: tag(userID, w), expiresAt: (w + 1) * WINDOW_SECONDS };
}

/**
 * Accept the CURRENT window and the PREVIOUS one, so a scan that straddles a
 * rotation boundary works — otherwise a resident whose code refreshes in the
 * instant between being shown and being read is told they are invalid.
 *
 * BOTH COMPARISONS ARE EVALUATED AND NEITHER IS SHORT-CIRCUITED. Assigning both
 * before the `||` is deliberate: an early `return true` on the first match
 * leaks WHICH window matched, which is a thirty-second timing oracle at the
 * boundary. It costs one extra HMAC per verification.
 */
export function verifyCheckInToken(
  userID: string,
  token: string,
  nowSec: number,
): boolean {
  const w = currentWindow(nowSec);
  const a = tokenMatches(tag(userID, w), token);
  const b = tokenMatches(tag(userID, w - 1), token);
  return a || b;
}

/**
 * Is the feature configured at all? Lets a query answer "can this door work?"
 * without minting a token or throwing — the door page needs to render an honest
 * "not set up" state rather than a broken scanner.
 */
export function isQrConfigured(): boolean {
  return Boolean(env.EVENT_QR_SECRET);
}
