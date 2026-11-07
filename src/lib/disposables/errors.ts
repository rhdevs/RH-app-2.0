/**
 * What to tell the person when a disposable call fails. The server sends short
 * codes (and `sanitizeErrors` hides everything else), so the screen maps the
 * ones it knows and falls back to one safe line.
 */
const KNOWN: ReadonlyArray<readonly [string, string]> = [
  [
    "DISPOSABLE_CONFLICT",
    "This request changed while you were looking at it. Reload and try again.",
  ],
  ["DISPOSABLE_DATE_PAST", "Choose today or a later collection date."],
  [
    "DISPOSABLE_PROPOSAL_TAKEN",
    "That proposal already has a disposables request.",
  ],
  ["DISPOSABLE_BAD_PROPOSAL", "That proposal could not be found."],
  ["DISPOSABLE_BAD_EVENT", "That event could not be found."],
  ["DISPOSABLE_NEEDS_TAG", "Choose the event this is for, or a proposal."],
  [
    "DISPOSABLE_EVENT_MISMATCH",
    "That proposal belongs to a different event. Choose one or the other.",
  ],
  [
    "DISPOSABLE_PROPOSAL_HAS_EVENT",
    "That proposal already has an event. Choose the event instead.",
  ],
  [
    "DISPOSABLE_PROPOSAL_NOT_OPEN",
    "That proposal is still a draft or was canceled. Submit it first.",
  ],
  ["DISPOSABLE_EVENT_CANCELED", "That event is canceled."],
  ["DISPOSABLE_EVENT_DECLINED", "That event was declined."],
  ["DISPOSABLE_EVENT_ENDED", "That event has already ended."],
  ["DISPOSABLE_EVENT_UNTITLED", "That event has no title yet."],
  ["NOT_SOCIAL_DIRECTOR", "Only the Social director can do that."],
  ["DISPOSABLE_BAD_MOVE", "That is not possible for a request in this state."],
  ["DISPOSABLE_NOT_FOUND", "That request no longer exists."],
  [
    "DISPOSABLE_NOT_PENDING",
    "Only a request waiting for a decision can be nudged.",
  ],
  [
    "DISPOSABLE_NUDGE_TRY_AGAIN",
    "That did not go through because of a clash. Press it again.",
  ],
  ["NOTIFICATIONS_DISABLED", "Notices are not switched on yet."],
  [
    "NOT_CCA_HEAD",
    "Only a current head of the event's CCA can ask for disposables for it.",
  ],
  [
    "NOT_HALL_FILER",
    "Only a JCRC member or an admin can ask for disposables for a hall-wide event.",
  ],
  ["NOT_DISPOSABLE_READER", "You cannot see these requests."],
  ["DISPOSABLES_DISABLED", "Disposables requests are not switched on yet."],
];

export function disposableErrorMessage(message: string): string {
  if (message.startsWith("RATE_LIMITED")) {
    return "You have done this a lot recently. Please try again later.";
  }
  const hit = KNOWN.find(([code]) => message.includes(code));
  return hit ? hit[1] : "Something went wrong. Try again shortly.";
}

/**
 * The event a proposal already has, from the refusal
 * `DISPOSABLE_PROPOSAL_HAS_EVENT:<eventID>`, so the form can point at it.
 */
export function proposalEventIdIn(message: string): number | null {
  const m = /DISPOSABLE_PROPOSAL_HAS_EVENT:(\d+)/.exec(message);
  return m ? Number(m[1]) : null;
}
