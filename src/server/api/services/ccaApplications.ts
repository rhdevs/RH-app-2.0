import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import {
  SLOT_CAPACITY_DEFAULT,
  SLOT_CAPACITY_MAX,
} from "~/lib/schemas/ccaApplication";

/**
 * Infrastructure for the CCA membership-application + interview workflow: the
 * feature's kill switch, an atomic id allocator, a per-CCA advisory lock, and
 * the seat arithmetic for group interview slots.
 *
 * The lock and counter reuse the SAME `BookingLock` and `Counter` collections
 * the booking system uses (booking.ts) — a different key namespace, not a new
 * collection — so they inherit the unique indexes that make them safe. Requires
 * `prisma db push` so those indexes exist.
 */

/* -------------------------------------------------------------------------- */
/* The applications kill switch                                                */
/* -------------------------------------------------------------------------- */

const APPLICATIONS_FLAG_KEY = "cca.applications.enabled";
const FLAG_TTL_MS = 15_000;

let flagCache: { at: number; on: boolean } | null = null;

/**
 * Gates the ENTIRE applications surface — resident apply/book and head
 * review/decide alike.
 *
 * Same shape as `isCcaManagementEnabled` (ccaScope.ts), and for the same
 * reason: this is a NEW WRITE SURFACE, so "behave as yesterday" means DISABLED,
 * not "no gate". An unreachable flag returns false and an absent row returns
 * false — the surface is inert until someone deliberately writes
 * `cca.applications.enabled = "on"`. Fails CLOSED, and the closed result is
 * deliberately NOT cached so a transient Atlas hiccup does not pin "disabled"
 * for 15s.
 */
export async function isApplicationsEnabled(
  db: PrismaClient,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: APPLICATIONS_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetApplicationsCache(): void {
  flagCache = null;
}

/**
 * Assert the switch is on. Called at the top of EVERY applications mutation and
 * every read that would otherwise leak the existence of the feature — the
 * page-level check is cosmetic, this one is the boundary.
 */
export async function assertApplicationsEnabled(
  db: PrismaClient,
): Promise<void> {
  if (!(await isApplicationsEnabled(db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "CCA_APPLICATIONS_DISABLED",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Atomic id allocation                                                        */
/* -------------------------------------------------------------------------- */

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Allocate the next id for a `Counter` key atomically. Generic sibling of
 * `nextBookingId` (booking.ts). Our collections start empty, so there is no
 * historical max to seed from — the counter is created at 0 and the first id is
 * 1. The unique index on `Counter.key` makes the create-then-increment safe:
 * a create that loses the first-ever race falls through to the increment.
 */
export async function nextCounter(
  db: PrismaClient,
  key: string,
): Promise<number> {
  const existing = await db.counter.findUnique({ where: { key } });
  if (!existing) {
    try {
      await db.counter.create({ data: { key, seq: 0 } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  const updated = await db.counter.update({
    where: { key },
    data: { seq: { increment: 1 } },
  });
  return updated.seq;
}

export const APPLICATION_COUNTER_KEY = "ccaApplicationID";
export const SLOT_COUNTER_KEY = "ccaInterviewSlotID";

/* -------------------------------------------------------------------------- */
/* Per-CCA advisory lock                                                       */
/* -------------------------------------------------------------------------- */

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding a per-CCA advisory lock, so the check-then-write pairs
 * in this workflow cannot interleave for the same CCA:
 *   - two residents claiming the same open slot
 *   - a resident applying twice concurrently (the "one open application" check)
 *   - two heads deciding the same application at once
 *
 * Same mechanism as `withFacilityLock` (booking.ts) — a `BookingLock` document
 * whose unique key is the mutex — under a distinct `ccaApp:` namespace. A lock
 * abandoned by a crashed request is reclaimed after LOCK_STALE_MS.
 */
export async function withCcaLock<T>(
  db: PrismaClient,
  ccaID: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `ccaApp:${ccaID}`;
  let acquired = false;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      await db.bookingLock.create({ data: { key } });
      acquired = true;
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await db.bookingLock.deleteMany({
        where: { key, createdAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } },
      });
      await sleep(LOCK_RETRY_MS);
    }
  }

  if (!acquired) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "CCA_BUSY",
    });
  }

  try {
    return await fn();
  } finally {
    await db.bookingLock.deleteMany({ where: { key } });
  }
}

/* -------------------------------------------------------------------------- */
/* Interview slot seats                                                        */
/* -------------------------------------------------------------------------- */

// Re-exported so a server caller reaches for the seat vocabulary in ONE place
// rather than importing half of it from the zod module. The definitions live in
// src/lib/schemas/ccaApplication.ts because the head's generator is a client
// component and needs the values (see the note there).
export { SLOT_CAPACITY_DEFAULT, SLOT_CAPACITY_MAX };

/**
 * How many applicants may claim a slot, from its stored `capacity`.
 *
 * THE ONLY PLACE THE LEGACY DEFAULT LIVES. Every slot opened before group slots
 * existed has `capacity` ABSENT, which Prisma hands back as null, and a fresh
 * `?? 1` sprinkled at each call site is exactly how "absent means 1" drifts into
 * "absent means 0 seats" at the one site that forgot. Inline `?? 1` NOWHERE
 * else — call this.
 *
 * 0 and negatives also mean 1, deliberately: they are only reachable by a
 * hand-edit or a partial restore (the zod bound is min 1), and the safe reading
 * of a corrupt capacity is the pre-feature behaviour, not "this slot can never
 * be booked" — which would look identical to a full slot and be unfixable from
 * the UI, since the edit form cannot save a capacity below the occupancy.
 */
export function slotCapacity(c: number | null | undefined): number {
  if (typeof c !== "number" || !Number.isFinite(c)) return SLOT_CAPACITY_DEFAULT;
  const n = Math.floor(c);
  return n >= SLOT_CAPACITY_DEFAULT ? n : SLOT_CAPACITY_DEFAULT;
}

/**
 * slotID -> seats taken, for one CCA. Slots with nobody on them are ABSENT from
 * the map, so read it through `occupancy.get(slotID) ?? 0`.
 *
 * Occupancy is DERIVED from `CcaApplication.interviewSlotID` — there is no
 * counter to keep in step and no claim on the slot row, so the pointer cannot
 * disagree with itself. One application holds at most one seat structurally
 * (the pointer is a single scalar), which is why a re-book of the slot you
 * already hold is a no-op rather than a double count.
 *
 * PRIVACY: this runs on RESIDENT paths (availableSlots, getCca). It projects
 * `interviewSlotID` and NOTHING else, so no other applicant's userID, name or
 * notes is loaded to compute a number a resident is allowed to see. Do not add
 * a field to this select "while you're here" — add a second, head-only query.
 *
 * The null test is done in JS, not in the query: `{ interviewSlotID: { not:
 * null } }` would miss every application whose pointer is ABSENT rather than a
 * stored null (Prisma+Mongo), which is most of them, and the count would come
 * back looking plausible.
 */
export async function occupancyBySlot(
  db: PrismaClient,
  ccaID: number,
): Promise<Map<number, number>> {
  const rows = await db.ccaApplication.findMany({
    where: { ccaID },
    select: { interviewSlotID: true },
  });
  const out = new Map<number, number>();
  for (const r of rows) {
    if (r.interviewSlotID === null) continue;
    out.set(r.interviewSlotID, (out.get(r.interviewSlotID) ?? 0) + 1);
  }
  return out;
}
