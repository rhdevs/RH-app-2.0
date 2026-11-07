import { parseShortMessage } from "~/lib/equipment/stock";

/**
 * What to tell the person when an equipment call fails. The server sends short
 * codes (and `sanitizeErrors` hides everything else), so the screens map the
 * ones they know and fall back to one safe line. Server-import free.
 */
const KNOWN: ReadonlyArray<readonly [string, string]> = [
  [
    "EQUIPMENT_CONFLICT",
    "This loan changed while you were looking at it. Reload and try again.",
  ],
  [
    "EQUIPMENT_TRY_AGAIN",
    "That did not go through because someone else was changing the same items. Press it again.",
  ],
  ["EQUIPMENT_BAD_MOVE", "That is not possible for a loan in this state."],
  ["EQUIPMENT_NOT_FOUND", "That loan no longer exists."],
  ["EQUIPMENT_LOAN_GONE", "That loan no longer exists."],
  ["EQUIPMENT_ITEM_NOT_FOUND", "That item no longer exists."],
  [
    "EQUIPMENT_ITEM_IN_USE",
    "A loan already names this item, so it cannot be deleted. Retire it instead.",
  ],
  ["EQUIPMENT_ITEM_RETIRED", "One of those items has been retired."],
  ["EQUIPMENT_BAD_ITEM", "One of those items could not be found."],
  ["EQUIPMENT_BAD_EVENT", "That event could not be found."],
  ["EQUIPMENT_BAD_WINDOW", "The return must be after the collection."],
  [
    "EQUIPMENT_EVENT_CLOSED",
    "The event is canceled, declined or gone, so this loan cannot be approved or collected.",
  ],
  [
    "EQUIPMENT_WINDOW_TOO_LONG",
    "A loan can run for at most 60 days from collection to return.",
  ],
  [
    "EQUIPMENT_NOT_RETURNED",
    "A note can be added only after the kit has been returned.",
  ],
  ["EQUIPMENT_BAD_FILE", "That photo could not be used. Try another one."],
  ["EQUIPMENT_NOT_UPLOADED", "That photo was not found. Upload it again."],
  [
    "EQUIPMENT_PHOTO_TOO_MANY",
    "Too many photos are waiting for this loan. Try again later.",
  ],
  ["NOT_SOCIAL_DIRECTOR", "Only the Social director can do that."],
  [
    "NOT_EVENT_LEADER",
    "Only the leaders of the event's CCA or the Social director can do that.",
  ],
  ["NOT_EQUIPMENT_READER", "You cannot see equipment loans."],
  ["EQUIPMENT_DISABLED", "Equipment loans are not switched on yet."],
  ["DISPOSABLE_EVENT_CANCELED", "That event is canceled."],
  ["DISPOSABLE_EVENT_DECLINED", "That event was declined."],
  ["DISPOSABLE_EVENT_ENDED", "That event has already ended."],
  ["DISPOSABLE_EVENT_UNTITLED", "That event has no title yet."],
  ["TOO_LARGE", "That photo is still too large after resizing."],
];

export function equipmentErrorMessage(message: string): string {
  if (message.startsWith("RATE_LIMITED") || message.includes("RATE_LIMITED")) {
    return "You have done this a lot recently. Please try again later.";
  }
  const short = parseShortMessage(message);
  if (short) {
    return `Not enough ${short.name}: ${short.owned} owned, ${short.heldAtPeak} already held, ${short.wanted} wanted.`;
  }
  const hit = KNOWN.find(([code]) => message.includes(code));
  return hit ? hit[1] : "Something went wrong. Try again shortly.";
}
