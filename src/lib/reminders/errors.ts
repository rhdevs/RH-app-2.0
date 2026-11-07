/**
 * What to tell the person when a reminder call fails. The server sends short
 * codes (and `sanitizeErrors` hides everything else), so the screen maps the
 * ones it knows and falls back to one safe line.
 */
const KNOWN: ReadonlyArray<readonly [string, string]> = [
  ["REMINDERS_DISABLED", "Reminders are not switched on yet."],
  [
    "NOT_DIRECTOR",
    "You can only send to CCAs you direct, and every chosen CCA must be one of them.",
  ],
  ["DIRECTOR_CHECK_FAILED", "Could not check your role. Try again shortly."],
  ["REMINDER_DEADLINE_PAST", "Choose today or a later deadline."],
  ["REMINDER_NOT_FOUND", "That reminder no longer exists."],
  ["REMINDER_CANCELLED", "That reminder was cancelled."],
  ["NOT_CCA_HEAD", "Only a head of this CCA can do that."],
  ["NOTIFICATIONS_DISABLED", "Notices are not switched on yet."],
];

export function reminderErrorMessage(message: string): string {
  if (message.startsWith("RATE_LIMITED")) {
    return "You have done this a lot recently. Please try again later.";
  }
  const hit = KNOWN.find(([code]) => message.includes(code));
  return hit ? hit[1] : "Something went wrong. Try again shortly.";
}
