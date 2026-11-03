/**
 * ONE place that turns an event error code into words. The server throws bare
 * codes (`INCOMPLETE:title,banner`, `FACILITY_CLASH:{json}`); everything a
 * head or resident sees goes through here, so a raw code or a zod message can
 * never reach the screen and two screens can never word the same refusal
 * differently.
 *
 * Every refusal that a retry cannot fix says so ("Reload the page") rather
 * than falling through to the generic "Try again".
 */

import { formatDateRange } from "./format";

const FIELD_LABELS: Record<string, string> = {
  title: "event name",
  description: "description",
  startTime: "start time",
  endTime: "end time",
  location: "location",
  banner: "banner image",
  publicDescription: "public description",
};

const labelList = (codes: string): string =>
  codes
    .split(",")
    .map((f) => FIELD_LABELS[f] ?? f)
    .join(", ");

type Clash = { eventName: string | null; startTime: number; endTime: number };

function parseClash(json: string): Clash | null {
  try {
    const v = JSON.parse(json) as Partial<Clash>;
    if (typeof v.startTime !== "number" || typeof v.endTime !== "number") {
      return null;
    }
    return {
      eventName: typeof v.eventName === "string" ? v.eventName : null,
      startTime: v.startTime,
      endTime: v.endTime,
    };
  } catch {
    return null;
  }
}

/** Codes carrying a payload after a colon. */
function prefixed(message: string): string | null {
  const at = message.indexOf(":");
  if (at < 0) return null;
  const code = message.slice(0, at);
  const rest = message.slice(at + 1);
  switch (code) {
    case "INCOMPLETE":
      return `Please add: ${labelList(rest)}.`;
    case "FIELD_LOCKED":
      return `The ${labelList(rest)} can't change once the event is live.`;
    case "CAPACITY_BELOW_SIGNUPS":
      return `${rest} people have already signed up, so the capacity can't go below ${rest}.`;
    case "NOT_SIGNED_IN":
      return "Some of the people you picked have never signed in to the app, so they can't scan yet. Ask them to sign in once, then add them.";
    case "FACILITY_CLASH": {
      const clash = parseClash(rest);
      if (!clash) return "The facility is already booked for that time.";
      const what = clash.eventName?.trim() || "another booking";
      return `The facility is already booked for that time by ${what} (${formatDateRange(clash.startTime, clash.endTime)}). Pick another time or place.`;
    }
    case "CAPABILITY_REQUIRED":
      return rest === "reviewEvents"
        ? "You can't review events."
        : rest === "manageHallEvents"
          ? "You can't manage hall events."
          : "You don't have permission to do that.";
    default:
      return null;
  }
}

const EXACT: Record<string, string> = {
  END_BEFORE_START: "The end time must be after the start time.",
  DOOR_CLOSES_BEFORE_OPEN: "Check-in must close after it opens.",
  BANNER_REQUIRED: "A live event needs a banner image.",
  PUBLIC_DESCRIPTION_REQUIRED: "A live event needs a public description.",
  LOCATION_REQUIRED: "Add where the event is.",
  END_TIME_REQUIRED: "A booked facility needs an end time.",
  NO_SUCH_FACILITY: "That facility no longer exists. Pick another.",
  NOT_A_HEAD_OF_THIS_CCA: "You're no longer a head of this CCA.",
  EVENTS_DISABLED: "Events aren't switched on yet.",
  // Two people pressing at once on a busy event. Retrying genuinely helps.
  EVENT_BUSY: "Lots of people are doing this at once. Try again in a moment.",
  // Deliberately ACTIONABLE. "This can't be edited any more" would be a lie
  // for a submitted event, which CAN be edited — after a withdraw. Declined
  // and canceled never render an editor, so the string is unreachable there.
  EVENT_LOCKED:
    "This event is in the review queue. Withdraw it first to make changes.",
  EVENT_CHANGED:
    "Someone else changed this event while you were editing. Reload the page to see their changes.",
  REVIEW_REQUIRED:
    "JCRC review is switched on, so this has to be submitted for review instead. Reload the page.",
  REVIEW_OFF:
    "JCRC review is switched off, so you can publish this yourself. Reload the page.",
  NOT_PUBLISHABLE:
    "This event can't be published from its current state. Reload the page.",
  REASON_REQUIRED: "Tell the people who signed up why it's cancelled.",
  NOT_DELETABLE:
    "Only a draft that was never published can be deleted. Cancel it instead.",
  // submitForReview refuses anything whose editScope is not "all"; retrying
  // cannot succeed from any refusing state.
  NOT_SUBMITTABLE:
    "This event can't be submitted from its current state — it's already in the queue, or it's been decided. Reload the page.",
  NOT_WITHDRAWABLE: "This event isn't in the review queue. Reload the page.",
  NOT_UNDER_REVIEW: "Someone has already decided this event. Reload the page.",
  // Both refusing states are terminal, so "Try again" would loop forever.
  NOT_CANCELABLE:
    "This event is already declined or cancelled, so there's nothing to cancel. Reload the page.",
  NO_SUCH_EVENT: "This event no longer exists.",
  // A signup landed since the builder last read — the race the freeze
  // exists to catch, and permanent for this event.
  QUESTIONS_FROZEN:
    "The questions are locked now — someone signed up, or the event is live. Reload the page.",
  // Another head removed a question since this list was fetched.
  NO_SUCH_QUESTION:
    "One of these questions was removed by another head. Reload the page.",
  // Resident-side signup refusals.
  MATRIC_REQUIRED: "Add your matric number to sign up.",
  EVENT_FULL: "This event just filled up.",
  SIGNUP_CLOSED: "Signups have closed for this event.",
  ANSWERS_INVALID: "Some answers need fixing — check the form above.",
};

/** Words for a server error, falling back to `fallback`. */
export function eventErrorMessage(
  e: unknown,
  fallback = "That didn't save. Try again.",
): string {
  const message = e instanceof Error ? e.message : "";
  return EXACT[message] ?? prefixed(message) ?? fallback;
}

/**
 * Words for a CLIENT-side schema issue. Zod's own messages are English but
 * written for developers ("Number must be greater than 0"), so only the codes
 * the schema defines on purpose get through; anything else becomes a plain
 * "check the fields".
 */
export function eventIssueMessage(issue: {
  message?: string;
  path?: (string | number)[];
}): string {
  if (issue.message === "NOT_A_VALID_EVENT_BLOB_URL") {
    return "An image doesn't belong to this event. Re-upload it.";
  }
  if (issue.message === "End time must be after the start time") {
    return EXACT.END_BEFORE_START!;
  }
  const field = issue.path?.[0];
  if (field === "capacity") return "Capacity must be a whole number above 0.";
  if (typeof field === "string" && FIELD_LABELS[field]) {
    return `Check the ${FIELD_LABELS[field]}.`;
  }
  return "Please check the fields.";
}
