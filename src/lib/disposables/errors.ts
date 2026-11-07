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
  ["DISPOSABLE_BAD_PROPOSAL", "Choose one of your own CCA's proposals."],
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
  ["NOT_CCA_HEAD", "Only a head of this CCA can do that."],
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
