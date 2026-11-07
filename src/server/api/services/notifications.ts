import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

/**
 * The in-app inbox: the `notifications.enabled` switch and `notify`, the ONLY
 * code that writes a `Notification` row.
 *
 * Recipients are user ids taken from user records by the caller. Nothing here
 * or in the router accepts a typed address, and no procedure lets a client
 * name a recipient.
 */

export const NOTIFICATIONS_FLAG_KEY = "notifications.enabled";
export const NOTIFICATIONS_DISABLED = "NOTIFICATIONS_DISABLED";
const FLAG_TTL_MS = 15_000;

/** About 180 days (Q21). The TTL index removes a row once this date passes. */
export const NOTIFICATION_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

export const TITLE_MAX = 200;
export const BODY_MAX = 1000;
export const KIND_PATTERN = /^[a-z][a-z0-9_.]{0,63}$/;
/** One write for a broadcast, but not an unbounded one. */
export const MAX_RECIPIENTS = 5000;

let flagCache: { at: number; on: boolean } | null = null;

/**
 * Fail CLOSED, like events.enabled: an absent row, any value but "on", or a
 * failed read all mean off. A failed read is not cached, so the next request
 * retries instead of pinning "off".
 */
export async function areNotificationsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: NOTIFICATIONS_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetNotificationsFlagCache(): void {
  flagCache = null;
}

/** Called first in every gated procedure. */
export async function assertNotificationsEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await areNotificationsEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: NOTIFICATIONS_DISABLED });
  }
}

/** The PrismaClient, or the `tx` a caller's `$transaction` hands out. */
export type NotifyClient = Pick<PrismaClient, "systemFlag" | "notification">;

export type NotifyInput = {
  /** Canonical user ids from user records. Duplicates are collapsed. */
  recipients: readonly string[];
  /** A stable machine name such as "event.cancelled". */
  kind: string;
  /** Plain text. Stored exactly as given. */
  title: string;
  body?: string;
  /** An in-app path starting with a single "/". */
  href?: string;
  /**
   * Send at most once per recipient for this scope (for example a nudge,
   * "proposal.nudge:<proposal>:<Singapore day>"). A recipient who already has
   * a row with the same scope and id is skipped and counted in
   * `alreadySent`; the partial unique index on `noticeKey` is the backstop
   * for two writers at once (the loser's write throws, so inside a
   * transaction it rolls back as a whole).
   */
  once?: string;
};

export const ONCE_PATTERN = /^[A-Za-z0-9_.:-]{1,150}$/;
const onceKey = (scope: string, userID: string) => `${scope}|${userID}`;

/** A path inside this app: "/x", never "//host", a scheme, or a backslash. */
const isInAppPath = (href: string) =>
  /^\/(?![/\\])[^\s\\]*$/.test(href) && href.length <= 500;

/**
 * Write one inbox row per recipient, in one write. Pass the `tx` of the
 * caller's `$transaction` and the rows commit or roll back with the caller's
 * own change; pass the plain client for a best-effort notice after the fact.
 *
 * While `notifications.enabled` is off (row absent or any value but "on") it
 * writes nothing, so rows do not pile up unseen and then surface as stale news
 * the day the switch goes on. The flag is read fresh on every call; a failed
 * read throws rather than counting as off.
 *
 * Throws on bad input (a programming error in the caller) and on a failed
 * write; it never swallows either, so inside a transaction the caller's change
 * rolls back too. A caller that wants best-effort wraps the call itself.
 */
export async function notify(
  db: NotifyClient,
  input: NotifyInput,
): Promise<{ written: number; alreadySent?: number }> {
  const recipients = [...new Set(input.recipients)];
  if (recipients.some((r) => typeof r !== "string" || r.trim() === "")) {
    throw new Error("notify: a recipient must be a non-empty user id");
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(`notify: more than ${MAX_RECIPIENTS} recipients`);
  }
  if (!KIND_PATTERN.test(input.kind)) {
    throw new Error("notify: bad kind");
  }
  if (input.title.trim() === "" || input.title.length > TITLE_MAX) {
    throw new Error("notify: title must be 1 to 200 characters");
  }
  if (input.body !== undefined && input.body.length > BODY_MAX) {
    throw new Error("notify: body is over 1000 characters");
  }
  if (input.href !== undefined && !isInAppPath(input.href)) {
    throw new Error("notify: href must be an in-app path");
  }
  if (input.once !== undefined && !ONCE_PATTERN.test(input.once)) {
    throw new Error("notify: bad once scope");
  }
  if (recipients.length === 0) return { written: 0 };
  // Strict read, unlike the cached fail-closed one the router uses: no cache,
  // no catch. A failed read throws so the caller's transaction rolls back
  // instead of committing without its notice, and a freshly set flag counts at once.
  const flag = await db.systemFlag.findUnique({
    where: { key: NOTIFICATIONS_FLAG_KEY },
  });
  if (flag?.value !== "on") return { written: 0 };

  let targets = recipients;
  let alreadySent: number | undefined;
  if (input.once !== undefined) {
    const scope = input.once;
    const have = await db.notification.findMany({
      where: { noticeKey: { in: recipients.map((r) => onceKey(scope, r)) } },
      select: { noticeKey: true },
    });
    const taken = new Set(have.map((h) => h.noticeKey));
    targets = recipients.filter((r) => !taken.has(onceKey(scope, r)));
    alreadySent = recipients.length - targets.length;
    if (targets.length === 0) return { written: 0, alreadySent };
  }

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + NOTIFICATION_RETENTION_DAYS * DAY_MS,
  );
  const result = await db.notification.createMany({
    data: targets.map((userID) => ({
      userID,
      kind: input.kind,
      title: input.title,
      ...(input.body !== undefined && { body: input.body }),
      ...(input.href !== undefined && { href: input.href }),
      ...(input.once !== undefined && {
        noticeKey: onceKey(input.once, userID),
      }),
      createdAt: now,
      // Written as an explicit null: on MongoDB Prisma's `readAt: null` filter
      // (the unread count and mark-read) does not match a missing key.
      readAt: null,
      expiresAt,
    })),
  });
  return alreadySent === undefined
    ? { written: result.count }
    : { written: result.count, alreadySent };
}
