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
/* The Attendance kill switch — a SECOND flag, on purpose                       */
/* -------------------------------------------------------------------------- */

const ATTENDANCE_FLAG_KEY = "events.attendance.enabled";

let attendanceFlagCache: { at: number; on: boolean } | null = null;

/**
 * A SECOND FLAG, NESTED UNDER THE FIRST. Attendance is off unless BOTH
 * `events.enabled` and `events.attendance.enabled` are on — every attendance
 * procedure calls `assertEventsEnabled` first and this second.
 *
 * WHY A SEPARATE SWITCH. The door layer is the only part of Events that depends
 * on a camera, on a phone the hall does not own, on a network at a venue, and
 * on an env var that may not be set. It has to be switchable on for ONE trial
 * event without turning it on hall-wide, and switchable off again from a phone
 * while standing at a door that is not working. Bundling it under
 * `events.enabled` would mean the only way to stop a misbehaving scanner is to
 * take the entire events feature down, including timelines and signups people
 * are already using.
 *
 * FAILS CLOSED, same as areEventsEnabled: an absent row is OFF, and a failed
 * read is OFF and is NOT cached, so the next request retries rather than
 * pinning "disabled" on a transient hiccup.
 *
 * IT MUST NOT BE SWITCHED ON BEFORE THE EventAttendance UNIQUE INDEX EXISTS AND
 * HAS BEEN PROVEN TO ENFORCE (pending tasks T1/T2). A Prisma `@@unique` creates
 * nothing on MongoDB; without the real index, `checkIn`'s P2002 branch is
 * unreachable and every double scan writes a second row, silently.
 */
export async function isAttendanceEnabled(db: PrismaClient): Promise<boolean> {
  if (attendanceFlagCache && Date.now() - attendanceFlagCache.at < FLAG_TTL_MS) {
    return attendanceFlagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: ATTENDANCE_FLAG_KEY },
    });
    const on = row?.value === "on";
    attendanceFlagCache = { at: Date.now(), on };
    return on;
  } catch {
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetAttendanceFlagCache(): void {
  attendanceFlagCache = null;
}

/**
 * Assert the door layer is on. Called at the top of EVERY attendance procedure,
 * AFTER assertEventsEnabled — the page-level checks are cosmetic, these two are
 * the boundary.
 */
export async function assertAttendanceEnabled(db: PrismaClient): Promise<void> {
  if (!(await isAttendanceEnabled(db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "ATTENDANCE_DISABLED",
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
/** How long a signup waits for its turn before giving up (well under the
 *  serverless timeout). */
const LOCK_WAIT_BUDGET_MS = 8_000;
const LOCK_RETRY_BASE_MS = 25;
const LOCK_RETRY_CAP_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full-jitter backoff. A fixed 100 ms retry made every waiter wake in lockstep
 * when a popular event opened, so most of them collided again and gave up
 * after 50 tries with "busy". Spreading the retries lets the queue drain.
 */
export function lockRetryDelayMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(LOCK_RETRY_CAP_MS, LOCK_RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(random() * ceiling) + 1;
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

  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    try {
      await db.eventLock.create({ data: { key } });
      acquired = true;
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await db.eventLock.deleteMany({
        where: { key, createdAt: { lt: new Date(Date.now() - LOCK_STALE_MS) } },
      });
      await sleep(lockRetryDelayMs(attempt));
    }
  }

  if (!acquired) {
    // A code, not prose: the client words it (see errorCopy).
    throw new TRPCError({ code: "CONFLICT", message: "EVENT_BUSY" });
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
/**
 * May questions be edited at this status? Draft and changes_requested always.
 * A PUBLISHED event too while review is off (`allowPublished`): the freeze at
 * approval protected what a JCRC reviewer had approved, and with review off
 * there is no reviewer. The zero-signups rule in assertQuestionsEditable still
 * applies, so nobody's answers are invalidated.
 */
export function questionsEditableScope(
  status: string | null,
  allowPublished: boolean,
): boolean {
  const normal = normalizeStatus(status);
  if (editScope(normal) === "all") return true;
  return allowPublished && normal === "published";
}

export async function assertQuestionsEditable(
  db: PrismaClient,
  event: { eventID: number; status: string | null },
  opts: { allowPublished: boolean } = { allowPublished: false },
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
  //
  // With review OFF (the default) there is no reviewer to protect, so a
  // published event's questions may change until the first signup — see
  // questionsEditableScope. The signups check below then becomes live.
  if (!questionsEditableScope(event.status, opts.allowPublished)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "EVENT_LOCKED",
    });
  }
  // UNREACHABLE TODAY, AND KEPT ON PURPOSE.
  //
  // Freezing at approval (above) made this branch dead: `signup` refuses
  // anything but `published` (routers/event.ts:2340), `published` is not scope
  // `"all"`, and no transition returns a published event to an editable scope
  // — `withdraw` is submitted -> draft only. So an event that is editable here
  // can never have a signup, and QUESTIONS_FROZEN cannot fire. Confirmed in a
  // browser on 2026-08-27: saving questions on a published event with a real
  // signup returns EVENT_LOCKED, not QUESTIONS_FROZEN.
  //
  // Left standing as defence in depth, because it is the guard that stops
  // answers being invalidated under people who already gave them, and the
  // status machine is exactly the kind of thing a later phase edits. Deleting
  // it would silently transfer that protection to a rule three files away.
  // Its user-facing copy and the T-35 "can never succeed on a retry" mapping
  // are correspondingly unreachable — do not spend time tuning them, and do
  // not treat their absence from the UI as a bug.
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
