import { z } from "zod";

/**
 * Recurring-booking rules and bounds. THE one statement of both.
 *
 * PURE. Imports nothing but `zod`, so the booking modal (a `"use client"`
 * component) and the router share the exact same expansion and the exact same
 * validation. Same convention, and the same reason, as
 * `src/lib/schemas/profile.ts`: a preview computed by one rule and committed
 * under another is a feature that lies to the user about what it is booking.
 */

/**
 * THE HARD CAP, AND IT IS A SYSTEMS LIMIT RATHER THAN A POLICY ONE.
 *
 * Policy — who may create a series at all — is settled by the role gate on the
 * procedure (CCA heads and JCRC). This number exists for a different reason: the
 * whole series is written inside ONE `withFacilityLock` hold, and the tRPC route
 * has `maxDuration = 60`. A lock held across an unbounded write is a facility
 * nobody else can book for as long as it takes, and a series that exceeds the
 * function ceiling dies half-written with the lock still on disk until the
 * staleness reclaim clears it.
 *
 * 26 weeks is also just over one NUS semester, which is the longest series that
 * has a real-world meaning here.
 *
 * Raising it is not a one-line change: re-measure the write path first. The
 * repo has already been bitten by exactly this, in the bulk role importer —
 * see the `maxDuration` note in api/trpc/[trpc]/route.ts, where a chunk size
 * estimated at ~300ms/row measured at ~2s/row and truncated every large import.
 */
export const SERIES_MAX_OCCURRENCES = 26;

/** Just over six months. Bounds how far a room can be claimed into the future. */
export const SERIES_MAX_HORIZON_DAYS = 186;

const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;

/** One materialised occurrence: an absolute UNIX-second window. */
export interface SeriesWindow {
  startTime: number;
  endTime: number;
}

/**
 * THE WIRE CONTRACT IS A LIST OF WINDOWS, NOT A RULE — read this before
 * "simplifying" it into `{ weekday, time, until }`.
 *
 * The client expands the rule and sends concrete windows; the server validates
 * and writes them. It is tempting to send the rule instead and expand
 * server-side, and that is the wrong call HERE for one specific reason:
 * every existing booking path builds its timestamps in the BROWSER's local zone
 * (`new Date(d); setHours(...)` in BookingModal). A server-side expansion would
 * have to re-derive a local calendar from a UTC instant, which means the server
 * needs a timezone, which means the preview and the commit can disagree for
 * anyone whose device is not on SGT — the one failure this feature must not
 * have, because the preview is the whole UX.
 *
 * Sending windows keeps recurrence on exactly the same time arithmetic as a
 * single booking, so there is no second timezone story in the codebase.
 *
 * THE RULE IS THEREFORE UI SUGAR and the bounds below are the real contract. A
 * hand-crafted call could send 26 unrelated windows rather than 26 Thursdays —
 * which is fine, because that caller could equally make 26 individual bookings.
 * What must hold is the COUNT, the HORIZON and the SHAPE, and those are checked
 * server-side by `validateSeriesWindows` regardless of what produced them.
 */
export const seriesWindowSchema = z.object({
  startTime: z.number().int(),
  endTime: z.number().int(),
});

/**
 * Expand "this window, then every 7 days, up to and including `untilTime`".
 *
 * PLAIN ARITHMETIC ON UNIX SECONDS, and that is safe HERE specifically because
 * Singapore has no daylight saving — SGT is UTC+8 all year, so a week is always
 * exactly 604,800 seconds and 08:00 stays 08:00. In a DST jurisdiction this
 * would silently shift an hour twice a year and would need calendar-aware date
 * maths instead. The constraint is worth stating because it is the reason this
 * function is five lines rather than a dependency on a recurrence library.
 *
 * Stops at `SERIES_MAX_OCCURRENCES` rather than throwing, so the caller can show
 * "capped at 26" instead of an error. The first occurrence is always included.
 */
export function expandWeekly(
  first: SeriesWindow,
  untilTime: number,
): SeriesWindow[] {
  const out: SeriesWindow[] = [];
  let { startTime, endTime } = first;
  while (out.length < SERIES_MAX_OCCURRENCES && startTime <= untilTime) {
    out.push({ startTime, endTime });
    startTime += WEEK_SECONDS;
    endTime += WEEK_SECONDS;
  }
  return out;
}

/**
 * Shared validation. Returns a user-facing message, or `null` when the list is
 * acceptable.
 *
 * A STRING RATHER THAN A THROW, matching `validatePassword`: the modal renders
 * it as a toast and the router turns it into a BAD_REQUEST, and every message
 * here is safe to show because none depends on server state.
 *
 * WHAT IT ENFORCES, and why each one is here rather than assumed:
 *   - at least one window            — an empty series is a silent no-op write
 *   - the count cap                  — see SERIES_MAX_OCCURRENCES
 *   - end strictly after start       — the single-booking rule, applied per
 *                                      occurrence rather than once
 *   - equal durations                — a series whose occurrences differ in
 *                                      length did not come from a weekly rule;
 *                                      it is either a client bug or a crafted
 *                                      payload, and both should fail loudly
 *   - strictly increasing, disjoint  — occurrences that overlap EACH OTHER would
 *                                      conflict-check against rows the same call
 *                                      is about to insert, which the per-window
 *                                      check cannot see
 *   - the horizon cap                — measured from the FIRST occurrence, so a
 *                                      series cannot be anchored in the past to
 *                                      buy extra reach
 */
export function validateSeriesWindows(windows: SeriesWindow[]): string | null {
  if (windows.length === 0) {
    return "A repeating booking needs at least one date.";
  }
  if (windows.length > SERIES_MAX_OCCURRENCES) {
    return `A repeating booking can cover at most ${SERIES_MAX_OCCURRENCES} sessions.`;
  }

  const first = windows[0]!;
  const duration = first.endTime - first.startTime;
  if (duration <= 0) {
    return "End time must be after start time.";
  }

  let previousEnd = -Infinity;
  for (const w of windows) {
    if (w.endTime - w.startTime !== duration) {
      return "Every session in a repeating booking must be the same length.";
    }
    if (w.startTime < previousEnd) {
      return "The sessions overlap each other.";
    }
    previousEnd = w.endTime;
  }

  const span = windows[windows.length - 1]!.endTime - first.startTime;
  if (span > SERIES_MAX_HORIZON_DAYS * DAY_SECONDS) {
    return `A repeating booking can't run more than ${Math.floor(
      SERIES_MAX_HORIZON_DAYS / 7,
    )} weeks ahead.`;
  }

  return null;
}
