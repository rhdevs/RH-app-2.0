import { db } from "~/server/db";
import { clientIp, rateLimit } from "~/lib/rateLimit";
import {
  buildFeed,
  tokenFromSegment,
} from "~/server/api/services/calendar/feed";
import {
  FEED_FETCH_IP_LIMIT,
  FEED_FETCH_OWNER_LIMIT,
  FEED_FETCH_WINDOW_MS,
} from "~/server/api/services/calendar/token";

/**
 * The personal calendar feed, `/api/calendar/feed/<token>.ics`. A calendar app
 * cannot sign in, so the unguessable token in the path IS the credential: it
 * is per person, read-only, kept only as a hash and revocable (merge proposal
 * A11 and A28). Everything that decides what the response holds is in
 * services/calendar/feed.ts.
 *
 *  - GET only. A dynamic route, never cached by Next, and the response is
 *    `private, no-store` so no shared cache keeps a person's calendar.
 *  - The app never logs the token, here or in the service: no request URL, no
 *    header and no parameter is written by this code. A failure logs its kind.
 *    The token is in the URL path, though, so the host's own request logs
 *    (for example Vercel's) do keep it in plaintext; the app cannot change
 *    that. Treat those logs as holding the credential, and rotate the token if
 *    they are shared.
 *  - Refusals carry no detail: 401 for any token that opens nothing, 429 when
 *    a budget is spent, 503 when the feed is off, a read failed or the rate
 *    limiter itself failed (it refuses rather than opening).
 *  - Two budgets per hour: per address before anything is read, and per owner
 *    once the token names one.
 *  - There is no sign-in check and no middleware to allow-list: the app has
 *    none, and this route does not read the session.
 */
export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(
  request: Request,
  { params }: { params: { token: string } },
): Promise<Response> {
  const refuse = (status: 429 | 503, retryAfter?: number) =>
    new Response(
      status === 429 ? "Too many requests\n" : "Service unavailable\n",
      {
        status,
        headers: {
          ...HEADERS,
          "Content-Type": "text/plain; charset=utf-8",
          ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
        },
      },
    );
  try {
    const ip = await rateLimit(
      `calendar.feed.ip:${clientIp(request)}`,
      FEED_FETCH_IP_LIMIT,
      FEED_FETCH_WINDOW_MS,
    );
    if (!ip.allowed) return refuse(429, ip.retryAfter);
  } catch {
    return refuse(503);
  }
  let ownerRetry = 0;
  const result = await buildFeed(
    db,
    tokenFromSegment(params.token),
    new Date(),
    async (userID) => {
      const owner = await rateLimit(
        `calendar.feed.owner:${userID}`,
        FEED_FETCH_OWNER_LIMIT,
        FEED_FETCH_WINDOW_MS,
      );
      ownerRetry = owner.retryAfter;
      return owner.allowed;
    },
  );
  if (result.status !== 200) {
    return new Response(result.body, {
      status: result.status,
      headers: {
        ...HEADERS,
        "Content-Type": "text/plain; charset=utf-8",
        ...(result.status === 429 && ownerRetry
          ? { "Retry-After": String(ownerRetry) }
          : {}),
      },
    });
  }
  return new Response(result.body, {
    status: 200,
    headers: {
      ...HEADERS,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="rhapp.ics"',
    },
  });
}
