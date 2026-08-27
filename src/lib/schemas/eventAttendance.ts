import { z } from "zod";

/**
 * Shared Attendance validation and the QR WIRE FORMAT.
 *
 * CLIENT-SAFE BY CONSTRUCTION: this module imports `zod` and nothing else.
 *
 * That is not a style preference, it is the whole reason the file exists. The
 * signing half lives in `src/server/api/services/eventQr.ts`, which imports
 * `~/env` and `node:crypto` at module scope — and a module that does so CANNOT
 * be imported from a `"use client"` file. The repo already documents that
 * consequence (`services/roles.ts`, `AuditLogTable.tsx`). The door page and the
 * resident's QR both need the prefix, the refresh interval and the payload
 * parser; none of them may pull the secret into the browser bundle. Same split,
 * and same reasoning, as `_lib/format.ts` beside it.
 *
 * DO NOT import anything server-side here, and do not move `mintCheckInToken`
 * or `verifyCheckInToken` in. If this file ever needs `node:crypto`, the split
 * has been broken.
 */

/* -------------------------------------------------------------------------- */
/* The QR wire format                                                          */
/* -------------------------------------------------------------------------- */

/** Version prefix, so a later format change is detectable rather than silent. */
export const QR_PREFIX = "RH1";

/**
 * Refetch a new token before the 30-second signing window closes. 20s leaves a
 * 10s margin for a slow round trip; the verifier also accepts the PREVIOUS
 * window, so a scan straddling a rotation boundary still works.
 */
export const QR_REFRESH_MS = 20_000;

/**
 * `RH1|{userID}|{token}`.
 *
 * PIPE, NOT COLON. `EXT:` allowlist ids contain a colon (T-25), so `:` cannot
 * delimit anything keyed by a userID. `|` is provably safe rather than merely
 * untried: the principal key space has exactly two halves and both are
 * regex-bounded in `src/lib/identity.ts` — canonical NUS ids are capture group
 * one of `/^([A-Z0-9._%-]+)@U\.NUS\.EDU$/`, and allowlist pins are
 * `/^EXT:[A-Z0-9_]{3,32}$/`. Neither charset admits `|`; one admits `:`.
 *
 * The corollary matters for the parser below: because `|` cannot occur inside a
 * userID, splitting on it is EXACT rather than heuristic, which is what makes
 * the `parts.length !== 3` check sound. If a later phase widens the id charset,
 * this parser and the HMAC payload become ambiguous on the same day.
 */
export function buildCheckInPayload(userID: string, token: string): string {
  return `${QR_PREFIX}|${userID}|${token}`;
}

/**
 * Inverse of buildCheckInPayload. Returns null for anything that is not one of
 * our codes, so a scanner pointed at an arbitrary QR says "not an RHApp code"
 * rather than attempting a lookup.
 *
 * THE userID IS IN THE PAYLOAD IN CLEARTEXT, and that is an accepted cost
 * (T-27): the server cannot reverse an HMAC, so it must be told whose token to
 * recompute. What leaks to someone photographing a resident's screen is a
 * canonical userID — already visible to every head who exports an attendee list
 * — plus a token that is dead within 30 seconds.
 *
 * THIS PARSER MUST NOT BE USED TO LOOK A PERSON UP FOR ANY PURPOSE OTHER THAN A
 * CHECK-IN, and `event.checkIn` must never return anything about a userID whose
 * token did not verify. Otherwise the door page becomes an oracle for "does
 * this id exist".
 */
export function parseCheckInPayload(
  raw: string,
): { userID: string; token: string } | null {
  const parts = raw.split("|");
  if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
  if (!parts[1] || !parts[2]) return null;
  return { userID: parts[1], token: parts[2] };
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How a check-in was recorded. Enforced HERE, in code — `method` is a nullable
 * String with a default in the schema, never a DB enum, for the same reason
 * `Event.status` is.
 *
 *   qr      — the organiser scanned the resident's rotating code
 *   manual  — ticked off the pre-loaded roster, because a phone was flat, the
 *             resident was offline, or the camera would not open
 */
export const ATTENDANCE_METHODS = ["qr", "manual"] as const;
export type AttendanceMethod = (typeof ATTENDANCE_METHODS)[number];

/** Unrecognised or absent reads back as "qr", the overwhelmingly common case. */
export function normalizeMethod(raw: string | null | undefined): AttendanceMethod {
  return (ATTENDANCE_METHODS as readonly string[]).includes(raw ?? "")
    ? (raw as AttendanceMethod)
    : "qr";
}

/* -------------------------------------------------------------------------- */
/* Check-in window defaults                                                    */
/* -------------------------------------------------------------------------- */

/** One hour before the event starts. UNIX epoch SECONDS, the Bookings convention. */
export const ATTENDANCE_OPENS_BEFORE_SECONDS = 60 * 60;
/** One hour after it ends. */
export const ATTENDANCE_CLOSES_AFTER_SECONDS = 60 * 60;

/**
 * THE WINDOW A DOOR MAY CHECK PEOPLE IN. Three states, not two.
 *
 *   1. BOTH NULL — nobody has touched the timing, so it is DERIVED:
 *      start − 1h through end + 1h. Every row created so far is in this state,
 *      and it is what a head who never opens the Door section gets.
 *
 *   2. HEAD-CONTROLLED, WITH A CLOSE TIME — explicit `opensAt` and `closesAt`.
 *
 *   3. HEAD-CONTROLLED, OPEN-ENDED — an explicit `opensAt` and `closesAt: null`,
 *      meaning "open until I close it". Closing writes `closesAt = now`.
 *
 * WHY `closesAt: null` CHANGES MEANING ONCE `opensAt` IS SET, and why that is
 * not the sentinel trap this repo keeps hitting. The alternative was a magic
 * far-future timestamp or a fourth column, and both are worse: a sentinel is a
 * second value meaning something the type does not say, and a new `Event`
 * column is an SCRC disclosure decision every time. Here the PAIR carries the
 * state — "no close time" is only readable as such when there IS an open time
 * beside it, so no single field is doing double duty on its own.
 *
 * A DOOR WITH NO CLOSE TIME STAYS OPEN, and that is deliberate: a head who
 * opens it and forgets is a door that accepts a check-in the next morning,
 * which is a wrong row in a table nothing punishes anyone with. A door that
 * shuts on its own mid-queue is a committee that cannot check people in and
 * cannot see why. The failure directions are not symmetric.
 *
 * `null` OUT OF THIS FUNCTION MEANS CLOSED, NEVER OPEN-FOREVER. An event with
 * no `startTime` and no explicit open time has no derivable window at all;
 * callers must read that as shut rather than as unrestricted.
 */
export function resolveAttendanceWindow(event: {
  startTime: number | null;
  endTime: number | null;
  attendanceOpensAt: number | null;
  attendanceClosesAt: number | null;
}): { opensAt: number; closesAt: number | null } | null {
  const { startTime, endTime, attendanceOpensAt, attendanceClosesAt } = event;

  // State 1 — untouched. Derive, and require a startTime to derive from.
  if (attendanceOpensAt == null && attendanceClosesAt == null) {
    if (startTime == null) return null;
    return {
      opensAt: startTime - ATTENDANCE_OPENS_BEFORE_SECONDS,
      closesAt: (endTime ?? startTime) + ATTENDANCE_CLOSES_AFTER_SECONDS,
    };
  }

  // States 2 and 3 — the head owns the timing. An open time is required: if
  // they somehow have only a close time, fall back to the derived open, and if
  // that is not derivable either the door is shut rather than open-ended.
  const opensAt = attendanceOpensAt ?? (startTime != null ? startTime - ATTENDANCE_OPENS_BEFORE_SECONDS : null);
  if (opensAt == null) return null;

  // closesAt null here is OPEN-ENDED, not "derive" — see the docblock.
  if (attendanceClosesAt != null && attendanceClosesAt <= opensAt) return null;
  return { opensAt, closesAt: attendanceClosesAt };
}

/** Is the door open at `nowSec`? `closesAt: null` is open-ended, not closed. */
export function doorIsOpen(
  w: { opensAt: number; closesAt: number | null } | null,
  nowSec: number,
): boolean {
  if (!w) return false;
  if (nowSec < w.opensAt) return false;
  return w.closesAt == null || nowSec <= w.closesAt;
}

/* -------------------------------------------------------------------------- */
/* Scanner nominations                                                         */
/* -------------------------------------------------------------------------- */

/** A soft product cap. More than this at one door is not a real arrangement. */
export const MAX_SCANNERS_PER_EVENT = 12;

/**
 * SHAPE ONLY, DELIBERATELY NOT `userIDSchema`.
 *
 * `userIDSchema` enforces `/^E\d{7}$/`, which `identity.ts` calls out as lockout
 * mode L-27: `g.s_samuel@u.nus.edu` canonicalises to `G.S_SAMUEL` and is a real
 * row in this database. Gating nominations on E-format would tell those people
 * they cannot be nominated, with no way to discover why.
 *
 * This checks only that the value looks like a STORED canonical id — the union
 * of the two halves of the key space — and the real authority is
 * `assertMayScan`, which re-validates every nominee against LIVE CCA membership
 * at scan time (I-5). A stale or wrong id here fails closed at the door.
 */
const storedCanonicalID = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^(EXT:[A-Z0-9_]{3,32}|[A-Z0-9._%-]+)$/, "Not a valid account id");

export const saveScannersInput = z.object({
  eventID: z.number().int().positive(),
  scannerUserIDs: z.array(storedCanonicalID).max(MAX_SCANNERS_PER_EVENT),
});
export type SaveScannersInput = z.input<typeof saveScannersInput>;

/* -------------------------------------------------------------------------- */
/* Check-in payloads                                                           */
/* -------------------------------------------------------------------------- */

export const checkInInput = z.object({
  eventID: z.number().int().positive(),
  /** The raw decoded QR string. Parsed and verified server-side. */
  payload: z.string().trim().min(1).max(512),
});
export type CheckInInput = z.input<typeof checkInInput>;

export const manualCheckInInput = z.object({
  eventID: z.number().int().positive(),
  userID: storedCanonicalID,
});
export type ManualCheckInInput = z.input<typeof manualCheckInInput>;

export const undoCheckInInput = z.object({
  eventID: z.number().int().positive(),
  userID: storedCanonicalID,
  /** Mandatory: an undo erases a record of where a person physically was. */
  reason: z.string().trim().min(1).max(500),
});
export type UndoCheckInInput = z.input<typeof undoCheckInInput>;

/* -------------------------------------------------------------------------- */
/* The attendance window / update payload                                      */
/* -------------------------------------------------------------------------- */

const epochSecondsField = z.number().int().positive();

export const setAttendanceWindowInput = z
  .object({
    eventID: z.number().int().positive(),
    /** null CLEARS the override and returns the field to its derived default. */
    attendanceOpensAt: epochSecondsField.nullable(),
    attendanceClosesAt: epochSecondsField.nullable(),
  })
  .superRefine((val, ctx) => {
    if (
      val.attendanceOpensAt != null &&
      val.attendanceClosesAt != null &&
      val.attendanceClosesAt <= val.attendanceOpensAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attendanceClosesAt"],
        message: "Check-in must close after it opens",
      });
    }
  });
export type SetAttendanceWindowInput = z.input<typeof setAttendanceWindowInput>;
