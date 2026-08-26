import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { editScope, normalizeStatus } from "~/lib/schemas/event";

/**
 * Events feature server helpers: the kill switch, the eventID allocator, and the
 * per-event signup lock. Modelled on services/booking.ts (nextBookingId /
 * withFacilityLock) and services/ccaScope.ts (isCcaManagementEnabled).
 *
 * Depends on unique indexes on `EventLock.key`, `Counter.key` and
 * `Event.eventID` — those indexes are what make the lock, the counter and the
 * id allocation safe. They are created with `createIndexes`; see
 * scripts/remediation/create-event-phase2-indexes.mjs. Never `prisma db push`
 * on this cluster — it drops `User.email_unique_ci`.
 */

/* -------------------------------------------------------------------------- */
/* The Events kill switch                                                       */
/* -------------------------------------------------------------------------- */

const EVENTS_FLAG_KEY = "events.enabled";
const FLAG_TTL_MS = 15_000;

let flagCache: { at: number; on: boolean } | null = null;

/**
 * Same reasoning as isCcaManagementEnabled (ccaScope.ts): this gates a NEW
 * SURFACE that did not exist yesterday, so "behave as yesterday" means DISABLED.
 * The absence of the row returns false, and an unreachable flag returns false:
 * the entire Events feature is inert until someone deliberately writes
 * `events.enabled = "on"`. Fails CLOSED, and a failed read is NOT cached so the
 * next request retries rather than pinning "disabled" on a transient hiccup.
 */
export async function areEventsEnabled(db: PrismaClient): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: EVENTS_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetEventsFlagCache(): void {
  flagCache = null;
}

/**
 * Assert the switch is on. Called at the top of EVERY event procedure — the
 * page-level checks are cosmetic, this one is the boundary.
 */
export async function assertEventsEnabled(db: PrismaClient): Promise<void> {
  if (!(await areEventsEnabled(db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "EVENTS_DISABLED",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* eventID allocation                                                          */
/* -------------------------------------------------------------------------- */

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

/**
 * Allocate the next eventID atomically from the shared Counter collection
 * (key "eventID"). Mirrors nextBookingId. The Event collection starts empty, so
 * the lazy seed reads the current max (0 on first run).
 */
export async function nextEventId(db: PrismaClient): Promise<number> {
  const existing = await db.counter.findUnique({ where: { key: "eventID" } });
  if (!existing) {
    const last = await db.event.findFirst({
      orderBy: { eventID: "desc" },
      select: { eventID: true },
    });
    try {
      await db.counter.create({
        data: { key: "eventID", seq: last?.eventID ?? 0 },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  const updated = await db.counter.update({
    where: { key: "eventID" },
    data: { seq: { increment: 1 } },
  });
  return updated.seq;
}

/* -------------------------------------------------------------------------- */
/* Per-event signup lock                                                       */
/* -------------------------------------------------------------------------- */

const LOCK_STALE_MS = 30_000;
const LOCK_MAX_ATTEMPTS = 50;
const LOCK_RETRY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding a per-event advisory lock so the capacity count and the
 * subsequent signup create cannot interleave and overbook. Same shape and
 * crashed-request reclaim strategy as withFacilityLock.
 */
export async function withEventLock<T>(
  db: PrismaClient,
  eventID: number,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `event:${eventID}`;
  let acquired = false;

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      await db.eventLock.create({ data: { key } });
      acquired = true;
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await db.eventLock.deleteMany({
        where: { key, createdAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } },
      });
      await sleep(LOCK_RETRY_MS);
    }
  }

  if (!acquired) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "This event is busy right now — please try again.",
    });
  }

  try {
    return await fn();
  } finally {
    await db.eventLock.deleteMany({ where: { key } });
  }
}

/* -------------------------------------------------------------------------- */
/* Custom signup questions — the freeze                                        */
/* -------------------------------------------------------------------------- */

/**
 * May this event's questions be changed right now? Called by EVERY question
 * mutation, and called INSIDE withEventLock so "no signups yet" and "write the
 * questions" cannot interleave with a signup landing.
 *
 * TWO CONDITIONS, AND THEY ARE DIFFERENT FACTS.
 *
 *   editScope === "none" covers submitted / declined / canceled. `submitted`
 *   matters most: the questions are part of the event the JCRC reviews, and an
 *   event in the queue is frozen so the reviewer never approves a form that
 *   changed underneath them. Same rule, same imported function, as every other
 *   field — never re-derived here.
 *
 *   `published` has editScope "public", which is NOT "none", so a live event
 *   with zero signups can still gain a question. That is deliberate: questions
 *   only ever matter once an event is published and open, so freezing them at
 *   publish would mean they could never be added at all.
 *
 *   ZERO SIGNUPS IS THE REAL FREEZE. Editing a live form silently invalidates
 *   existing answers: a deleted question orphans its answers, a renamed option
 *   makes a stored single_choice value refer to something that no longer
 *   exists, and a newly-required question makes every existing signup
 *   retroactively incomplete with no way to ask anyone.
 *
 * QUESTIONS_FROZEN CAN NEVER SUCCEED ON A RETRY, so the UI must not map it to a
 * "try again" string — see T-35 and the copy in plan 02 §11.2.
 */
export async function assertQuestionsEditable(
  db: PrismaClient,
  event: { eventID: number; status: string | null },
): Promise<void> {
  // QUESTIONS ARE EDITABLE ONLY WHILE THE EVENT IS FULLY EDITABLE — scope
  // `"all"`, i.e. draft and changes_requested. NOT merely `!== "none"`.
  //
  // `editScope("published")` is `"public"` (schemas/event.ts:80-81), so the old
  // `!== "none"` test let `saveQuestions` succeed on a LIVE, JCRC-APPROVED event
  // that simply had no signups yet. The builder never mounts there
  // (EventManage.tsx renders DetailsEditor only at scope `"all"`), but the
  // server is the boundary and a direct tRPC call from the owning head was
  // enough: submit innocuous questions, get approved, publish, then swap in
  // "list your medical conditions" before the first resident signs up. The JCRC
  // would never see it.
  //
  // That defeats the exact purpose of showing the reviewer the questions — a
  // reviewer approving an event is approving what residents will be asked. The
  // user ruled on 2026-08-27: freeze at approval. A head who spots a typo after
  // approval needs JCRC to send the event back, which is the same round trip
  // any other post-approval change already takes.
  if (editScope(normalizeStatus(event.status)) !== "all") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "EVENT_LOCKED",
    });
  }
  const signups = await db.eventSignup.count({
    where: { eventID: event.eventID },
  });
  if (signups > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "QUESTIONS_FROZEN",
    });
  }
}
