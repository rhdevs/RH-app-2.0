import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

/**
 * Booking concurrency helpers (#11/#12/#13).
 *
 * MongoDB can't express an "overlapping range" unique constraint, so bookings
 * for a given facility are serialized through an advisory lock document, and
 * bookingIDs come from an atomic counter instead of a racy max()+1 read.
 *
 * Requires `prisma db push` so the unique indexes on `BookingLock.key` and
 * `Counter.key` exist — those indexes are what make the lock and counter safe.
 */

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Allocate the next bookingID atomically. Lazily seeds the counter from the
 * current max bookingID the first time it runs.
 */
export async function nextBookingId(db: PrismaClient): Promise<number> {
  const existing = await db.counter.findUnique({ where: { key: "bookingID" } });
  if (!existing) {
    const last = await db.bookings.findFirst({
      orderBy: { bookingID: "desc" },
      select: { bookingID: true },
    });
    // create may lose a race on first-ever call; the unique index on
    // Counter.key makes the loser fall through to the update below.
    try {
      await db.counter.create({
        data: { key: "bookingID", seq: last?.bookingID ?? 0 },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  const updated = await db.counter.update({
    where: { key: "bookingID" },
    data: { seq: { increment: 1 } },
  });
  return updated.seq;
}

/**
 * Run `fn` while holding a per-facility advisory lock so overlapping-time
 * conflict checks and the subsequent create can't interleave.
 */
export async function withFacilityLock<T>(
  db: PrismaClient,
  facilityID: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `facility:${facilityID}`;
  let acquired = false;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      await db.bookingLock.create({ data: { key } });
      acquired = true;
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Reclaim a lock abandoned by a crashed request.
      await db.bookingLock.deleteMany({
        where: { key, createdAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } },
      });
      await sleep(LOCK_RETRY_MS);
    }
  }

  if (!acquired) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This facility is busy right now — please try again.",
    });
  }

  try {
    return await fn();
  } finally {
    await db.bookingLock.deleteMany({ where: { key } });
  }
}
