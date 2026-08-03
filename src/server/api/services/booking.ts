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
 * Resolve a chosen facility to its id + name. The name is DENORMALIZED into the
 * owning row (Event.location, CcaInterviewSlot.location) so every display path
 * renders the location without a join; the id drives the auto-booking. Throws if
 * the facility does not exist.
 *
 * Lives here rather than in either router because both the events flow and the
 * interview-slot flow resolve a facility the same way, and a second copy is a
 * second chance for the two to disagree about what a missing facility means.
 */
export async function resolveFacility(
  db: PrismaClient,
  facilityID: number,
): Promise<{ facilityID: number; name: string }> {
  const f = await db.facilities.findUnique({
    where: { facilityID },
    select: { facilityName: true },
  });
  if (!f) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "NO_SUCH_FACILITY" });
  }
  return { facilityID, name: f.facilityName };
}

/**
 * The FIRST booking overlapping [startTime, endTime) on a facility, or null.
 *
 * Half-open, matching every other overlap check in the codebase: a booking that
 * ends exactly when this one starts does NOT conflict. MUST be called inside
 * withFacilityLock by anything that then creates a booking — otherwise two
 * requests can both read "free" and both insert.
 */
export async function findFacilityConflict(
  db: PrismaClient,
  facilityID: number,
  startTime: number,
  endTime: number,
): Promise<{ bookingID: number; startTime: number; endTime: number } | null> {
  const clash = await db.bookings.findFirst({
    where: {
      facilityID,
      AND: [{ endTime: { gt: startTime } }, { startTime: { lt: endTime } }],
    },
    select: { bookingID: true, startTime: true, endTime: true },
    orderBy: { startTime: "asc" },
  });
  return clash;
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
