import { createHash, randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { canonicalUserID } from "~/lib/identity";
import { rateLimit } from "~/lib/rateLimit";

/**
 * The personal feed token. Made with `randomBytes` (256 bits, base64url, 43
 * characters), shown to its owner once, and kept only as a SHA-256 hash, so
 * a copy of the database cannot subscribe anywhere. The hash is looked up by
 * a unique index: a wrong token costs the same hash and the same single read
 * whatever it looks like, and no comparison of secrets happens in code.
 *
 * One token per person. Rotating replaces the hash in place, so the old link
 * stops working in the same write; revoking deletes the row. Nothing here
 * reads or writes calendar data: what a feed holds is worked out when it is
 * fetched (feed.ts).
 */

export const FEED_TOKEN_BYTES = 32;
/** Longer input is cut before hashing, so the cost of a lookup is bounded. */
const TOKEN_INPUT_MAX = 256;

export const FEED_EXISTS = "FEED_TOKEN_EXISTS";
export const FEED_MISSING = "FEED_TOKEN_MISSING";

export const FEED_WINDOW_MS = 60 * 60 * 1000;
/** Per person per hour. A person makes a link once; only a script hits these. */
export const FEED_LIMITS = { create: 5, rotate: 10, revoke: 10 } as const;
export type FeedAction = keyof typeof FEED_LIMITS;

export const generateFeedToken = (): string =>
  randomBytes(FEED_TOKEN_BYTES).toString("base64url");

export const hashFeedToken = (token: string): string =>
  createHash("sha256").update(token.slice(0, TOKEN_INPUT_MAX)).digest("hex");

/** Spend one unit of the caller's budget or refuse with RATE_LIMITED. */
export async function assertFeedWithinLimit(
  action: FeedAction,
  userID: string,
): Promise<void> {
  const result = await rateLimit(
    `calendar.feed.${action}:${userID}`,
    FEED_LIMITS[action],
    FEED_WINDOW_MS,
  );
  if (!result.allowed) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `RATE_LIMITED:${result.retryAfter}`,
    });
  }
}

type TokenDb = Pick<PrismaClient, "calendarFeedToken">;
type OwnerDb = Pick<
  PrismaClient,
  "calendarFeedToken" | "user" | "credentialRevocation"
>;

/** Make this person's token. Refuses if they already have one. */
export async function createFeedToken(
  db: TokenDb,
  userID: string,
): Promise<{ token: string }> {
  const token = generateFeedToken();
  try {
    await db.calendarFeedToken.create({
      data: { userID, tokenHash: hashFeedToken(token), rotatedAt: null },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new TRPCError({ code: "CONFLICT", message: FEED_EXISTS });
    }
    throw err;
  }
  return { token };
}

/** Replace this person's token. The old one stops working with the write. */
export async function rotateFeedToken(
  db: TokenDb,
  userID: string,
): Promise<{ token: string }> {
  const token = generateFeedToken();
  const changed = await db.calendarFeedToken.updateMany({
    where: { userID },
    data: { tokenHash: hashFeedToken(token), rotatedAt: new Date() },
  });
  if (changed.count === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: FEED_MISSING });
  }
  return { token };
}

/** Delete this person's token. Succeeds quietly if there is none. */
export async function revokeFeedToken(
  db: TokenDb,
  userID: string,
): Promise<void> {
  await db.calendarFeedToken.deleteMany({ where: { userID } });
}

/** Whether this person has a link, and when it was made. Never the token. */
export async function feedTokenStatus(
  db: TokenDb,
  userID: string,
): Promise<{ hasToken: boolean; since: Date | null }> {
  const row = await db.calendarFeedToken.findFirst({
    where: { userID },
    select: { createdAt: true, rotatedAt: true },
  });
  return row
    ? { hasToken: true, since: row.rotatedAt ?? row.createdAt }
    : { hasToken: false, since: null };
}

/**
 * Whose feed this token opens, or null for any token that opens none. A token
 * opens nothing once its owner could no longer sign in:
 *  - the account is gone, or its email no longer resolves to the NUSNET id the
 *    token was made for (the same "eligible" rule as trpc.ts: a person with no
 *    canonical id has no standing);
 *  - the owner's credentials changed after the link was made. A password reset
 *    writes `CredentialRevocation.changedAt`; a link made before it (or last
 *    rotated before it) is refused, so a link made from a stolen session does
 *    not outlive the reset. Compared in whole seconds with `<`, as auth.ts
 *    does, so a link made in the same second as the reset survives. This reads
 *    the one watermark every credential change writes, so it covers every
 *    path with no per-path deletion to forget.
 * A read that fails THROWS (the caller answers 503); nothing is served on a
 * guess.
 */
export async function ownerOfFeedToken(
  db: OwnerDb,
  token: string,
): Promise<string | null> {
  const row = await db.calendarFeedToken.findUnique({
    where: { tokenHash: hashFeedToken(token) },
    select: { userID: true, createdAt: true, rotatedAt: true },
  });
  if (!row) return null;
  const user = await db.user.findFirst({
    where: { userID: row.userID },
    select: { id: true, email: true },
  });
  if (!user || canonicalUserID(user.email) !== row.userID) return null;
  const revoked = await db.credentialRevocation.findUnique({
    where: { userId: user.id },
    select: { changedAt: true },
  });
  if (revoked) {
    const issued = (row.rotatedAt ?? row.createdAt).getTime();
    if (
      Math.floor(issued / 1000) < Math.floor(revoked.changedAt.getTime() / 1000)
    ) {
      return null;
    }
  }
  return row.userID;
}

/** Per-address and per-owner budgets for the feed route, per hour. */
export const FEED_FETCH_WINDOW_MS = 60 * 60 * 1000;
/** A hall shares addresses; this only caps guessing and runaway loops. */
export const FEED_FETCH_IP_LIMIT = 600;
/** Calendar apps poll every 15 minutes to a few hours; 60 leaves room for hand refreshes. */
export const FEED_FETCH_OWNER_LIMIT = 60;
