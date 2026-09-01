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
 * Allocate `count` consecutive bookingIDs in ONE atomic round trip.
 *
 * WHY IT EXISTS. `nextBookingId` above costs a full round trip per id, and a
 * recurring booking needs one per occurrence — all of them inside a
 * `withFacilityLock` hold, against a route with `maxDuration = 60`. A 26-week
 * series would spend 26 sequential round trips on ids alone, holding the
 * facility lock the entire time, before it writes anything. This turns that into
 * a constant two, whatever the length of the series.
 *
 * ATOMIC FOR THE SAME REASON THE SINGLE VERSION IS: a single-document `$inc` in
 * MongoDB is atomic, so two concurrent callers asking for 10 each get two
 * disjoint blocks. Reading the counter and then writing `seq + count` would not
 * be — that is the read-then-write race the rate limiter was just fixed for.
 *
 * RETURNS THE BLOCK, not the top: `seq` after the increment is the LAST id in
 * the block, so the block is `[seq - count + 1 .. seq]`. Returning the array
 * rather than the bounds keeps the arithmetic in one place instead of at every
 * call site.
 *
 * IDS ARE CONSUMED WHETHER OR NOT THE WRITE SUCCEEDS. If the series then fails
 * to insert, the block is simply never used and `bookingID` has a gap. That is
 * correct and intended — `bookingID` is an identifier, not a count, and nothing
 * in the app derives meaning from it being contiguous. Trying to "give back"
 * unused ids is what reintroduces the race.
 */
export async function nextBookingIdBlock(
  db: PrismaClient,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];
  // Reuse the single allocator for the first id purely for its lazy-init side
  // effect: it is the one place that seeds `Counter` from the existing max when
  // no row exists yet, and duplicating that here would be a second, drifting
  // copy of the seeding rule.
  const firstId = await nextBookingId(db);
  if (count === 1) return [firstId];

  // Claim the remaining `count - 1` ids in one more atomic $inc. After this the
  // block [firstId .. firstId + count - 1] belongs to this caller and no other
  // caller can be inside it, because both increments moved the shared counter.
  await db.counter.update({
    where: { key: "bookingID" },
    data: { seq: { increment: count - 1 } },
  });

  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(firstId + i);
  return out;
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
