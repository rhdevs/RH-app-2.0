import { db } from "~/server/db";

/**
 * Minimal DB-backed fixed-window rate limiter (#5).
 *
 * No extra infrastructure (Redis, etc.) — it uses a `RateLimit` collection in
 * the existing MongoDB. Each key tracks a request count and a window expiry.
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
 * EVERY STATE TRANSITION IS A SINGLE ATOMIC DOCUMENT WRITE. Read this before
 * "simplifying" it back into a findUnique + update pair.
 *
 * THE BUG THIS REPLACED. The previous implementation was:
 *
 *     const existing = await db.rateLimit.findUnique({ where: { key } });
 *     if (existing.count >= limit) return denied;
 *     await db.rateLimit.update({ data: { count: { increment: 1 } } });
 *
 * Read, decide, write — with an await between each. N concurrent requests all
 * complete the findUnique before any of them writes, so all N observe the same
 * pre-increment count and all N are allowed. The limit bounds SEQUENTIAL
 * requests only; a burst of 50 parallel ones passes a limit of 5 in full. That
 * is not a partial mitigation of credential stuffing or reset abuse, it is a
 * complete bypass of it, and it needs no special tooling to hit — a `for` loop
 * without an `await` is enough.
 *
 * WHY updateMany AND NOT update. A single-document update in MongoDB is atomic,
 * and `updateMany` is the only Prisma verb that takes a NON-UNIQUE filter — the
 * `count: { lt: limit }` and `expiresAt` predicates are what make the write a
 * compare-and-set rather than a blind increment. `update` requires a unique
 * `where` and would drop exactly the conditions that carry the guarantee.
 * `key` is `@unique`, so each call still touches at most one document; the
 * returned `count` is 0 or 1 and reports whether we won the transition.
 *
 * THE ORDER OF THE FOUR STEPS IS THE ALGORITHM:
 *   1. Live window with budget left  -> atomic increment, allow.
 *   2. Absent or expired window      -> atomically claim a fresh one, allow.
 *   3. No document at all            -> create it. `key` is unique, so the
 *                                       loser of a creation race lands in the
 *                                       catch and retries step 1 exactly once.
 *   4. Live window, budget spent     -> denied; read the expiry for Retry-After.
 *
 * FAILS CLOSED. If step 3's create throws for any reason other than a lost race
 * and step 4's read then finds nothing, `retryAfter` falls back to the full
 * window and the caller is refused. A rate limiter that opens on error is not
 * one.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const fresh = new Date(now.getTime() + windowMs);

  // 1. A live window that still has budget: spend one, atomically.
  const bumped = await db.rateLimit.updateMany({
    where: { key, expiresAt: { gt: now }, count: { lt: limit } },
    data: { count: { increment: 1 } },
  });
  if (bumped.count > 0) return { allowed: true, retryAfter: 0 };

  // 2. The window has expired: roll it forward and spend the first request of
  //    the new one. Matches nothing when the document is absent (step 3) or
  //    when the window is live (step 4).
  const rolled = await db.rateLimit.updateMany({
    where: { key, expiresAt: { lte: now } },
    data: { count: 1, expiresAt: fresh },
  });
  if (rolled.count > 0) return { allowed: true, retryAfter: 0 };

  // 3. First ever request for this key.
  try {
    await db.rateLimit.create({ data: { key, count: 1, expiresAt: fresh } });
    return { allowed: true, retryAfter: 0 };
  } catch {
    // Almost certainly P2002 — a concurrent caller created the document
    // between step 2 and here. Their request consumed budget and ours has not,
    // so retry the compare-and-set ONCE. Not a loop: a second failure means the
    // window is genuinely exhausted, which is step 4's answer.
    const retried = await db.rateLimit.updateMany({
      where: { key, expiresAt: { gt: now }, count: { lt: limit } },
      data: { count: { increment: 1 } },
    });
    if (retried.count > 0) return { allowed: true, retryAfter: 0 };
  }

  // 4. Live window, no budget left.
  const existing = await db.rateLimit.findUnique({ where: { key } });
  const remainingMs = existing
    ? existing.expiresAt.getTime() - now.getTime()
    : windowMs;
  return {
    allowed: false,
    retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
  };
}

/**
 * READ-ONLY budget check. Does NOT consume.
 *
 * Exists for the FAILURE-COUNTING pattern the login gate uses: check the budget
 * before doing the expensive work, and spend from it only when the attempt
 * actually fails. `rateLimit` above cannot express that on its own, because it
 * consumes on every call — which would throttle a person who signs in
 * successfully ten times as hard as one who guesses wrong ten times.
 *
 * THE CHECK-THEN-CONSUME PAIR IS RACY BY CONSTRUCTION and that is acceptable
 * HERE, unlike inside `rateLimit` itself. Concurrent attempts can all observe
 * budget before any of them records a failure, so a burst can overshoot the
 * limit by roughly the size of the burst. That bounds guessing at "limit + a
 * burst" instead of "limit", which is immaterial against a budget of ten; what
 * it must never become is unbounded, and the consume half is atomic, so it
 * cannot. Do not reach for this where the count is the whole guarantee — use
 * `rateLimit`.
 */
export async function rateLimitPeek(
  key: string,
  limit: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const existing = await db.rateLimit.findUnique({ where: { key } });
  if (!existing || existing.expiresAt <= now || existing.count < limit) {
    return { allowed: true, retryAfter: 0 };
  }
  return {
    allowed: false,
    retryAfter: Math.max(
      1,
      Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000),
    ),
  };
}

/**
 * Forget a key's budget entirely — used to clear a failure counter after the
 * attempt it was counting finally succeeds, so someone who mistypes their
 * password nine times and then gets it right does not spend the rest of the
 * window one slip away from being locked out.
 *
 * Never throws: a failure to clear leaves a stale counter that expires on its
 * own, which is strictly the safe direction, and this is called on the success
 * path where an exception would turn a good login into an error.
 */
export async function rateLimitReset(key: string): Promise<void> {
  try {
    await db.rateLimit.deleteMany({ where: { key } });
  } catch {
    /* contained — a stale counter expires on its own */
  }
}

/**
 * A source of request headers. `Request` covers the Route Handlers; the plain
 * record covers next-auth v4's `authorize(credentials, req)`, whose `req.headers`
 * is an already-parsed object rather than a `Headers` instance.
 */
export type HeaderSource =
  | Request
  | { headers?: Record<string, string | string[] | undefined> };

function readHeader(src: HeaderSource, name: string): string | null {
  const maybeHeaders = (src as Partial<Request>).headers;
  if (maybeHeaders && typeof (maybeHeaders as Headers).get === "function") {
    return (maybeHeaders as Headers).get(name);
  }
  const bag = (
    src as { headers?: Record<string, string | string[] | undefined> }
  ).headers;
  const raw = bag?.[name] ?? bag?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

/**
 * ONE trusted proxy hop in front of the app — which is exactly what Vercel is
 * (see `.vercel/` and the deployment notes in README.md).
 *
 * IF A SECOND TRUSTED HOP IS EVER ADDED (a WAF or CDN placed in front of
 * Vercel, a self-hosted nginx), THIS MUST CHANGE WITH IT. With two hops the
 * real client is the second entry from the right, and leaving this at 1 buckets
 * the entire internet under the CDN's own address — a self-inflicted global
 * lockout rather than a bypass. Getting it wrong in this direction is loud and
 * immediate; getting it wrong in the other direction is silent, which is why
 * the number is named instead of inlined.
 */
const TRUSTED_PROXY_HOPS = 1;

/**
 * THE CLIENT IP, TAKEN FROM THE END OF THE FORWARDING CHAIN AND NOT THE START.
 *
 * THE BUG THIS REPLACED, because the one-character version of it is the whole
 * vulnerability:
 *
 *     return fwd.split(",")[0].trim();   // leftmost — ATTACKER CONTROLLED
 *
 * `X-Forwarded-For` is a chain that each proxy APPENDS to. Vercel's edge does
 * not discard a client-supplied value, it appends the real peer address to it.
 * So for a request that arrives carrying `X-Forwarded-For: 1.2.3.4`, the header
 * this code reads is `1.2.3.4, <real client ip>` — and the LEFTMOST entry is
 * the byte string the attacker typed. Rotating it per request gives every
 * request its own rate-limit bucket, which silently turns every per-IP limit in
 * this app into no limit at all: registration, the reset-request IP bucket, and
 * login.
 *
 * THE RIGHTMOST ENTRY IS THE ONE THE INFRASTRUCTURE WROTE. Everything to its
 * left is unverified client input. See TRUSTED_PROXY_HOPS above for the one
 * assumption this rests on.
 *
 * `x-real-ip` is only a FALLBACK, deliberately. Vercel does set it, but it is a
 * single-value header with no chain to reason about, so if a proxy ever forwards
 * a client-supplied one verbatim there is no way to tell from the value itself.
 * The chain is self-describing; prefer it when it is present.
 *
 * "unknown" IS A SHARED BUCKET, and that is the correct failure mode: every
 * caller we cannot attribute contends for one budget rather than each getting a
 * private one.
 */
export function clientIp(req: HeaderSource): string {
  const fwd = readHeader(req, "x-forwarded-for");
  if (fwd) {
    const chain = fwd
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const ip = chain[chain.length - TRUSTED_PROXY_HOPS];
    if (ip) return ip;
  }
  return readHeader(req, "x-real-ip")?.trim() ?? "unknown";
}
