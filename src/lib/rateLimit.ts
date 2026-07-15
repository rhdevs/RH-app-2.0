import { db } from "~/server/db";

/**
 * Minimal DB-backed fixed-window rate limiter (#5).
 *
 * No extra infrastructure (Redis, etc.) — it uses a `RateLimit` collection in
 * the existing MongoDB. Each key tracks a request count and a window expiry.
 * Good enough to blunt credential stuffing / reset-code abuse on a small app.
 *
 * NOTE: requires `prisma db push` to create the RateLimit collection and its
 * unique index on `key` before it becomes effective.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets (when blocked). */
  retryAfter: number;
}

/**
 * @param key      Stable bucket identifier, e.g. `login:<ip>` or `reset:<email>`.
 * @param limit    Max requests permitted within the window.
 * @param windowMs Window length in milliseconds.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = new Date();

  const existing = await db.rateLimit.findUnique({ where: { key } });

  // No window yet, or the previous window has expired → start a fresh one.
  if (!existing || existing.expiresAt <= now) {
    await db.rateLimit.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date(now.getTime() + windowMs) },
      update: { count: 1, expiresAt: new Date(now.getTime() + windowMs) },
    });
    return { allowed: true, retryAfter: 0 };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    };
  }

  await db.rateLimit.update({
    where: { key },
    data: { count: { increment: 1 } },
  });
  return { allowed: true, retryAfter: 0 };
}

/** Best-effort client IP from a Next.js request's headers. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
