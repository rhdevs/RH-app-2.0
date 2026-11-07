/** Plain-language copy for the jcrcPositions router's refusal codes. */
const COPY: Record<string, string> = {
  NAME_TAKEN: "There's already a position with that name.",
  POSITION_NOT_FOUND: "That position no longer exists. Reload the page.",
  UNKNOWN_CCA: "One of those CCAs no longer exists. Reload the page.",
  TARGET_NOT_JCRC:
    "That person isn't on the JCRC. An RF or Hall Office appoints JCRC members first.",
  NOT_JCRC: "Only JCRC members can do this.",
  NOT_YOUR_POSITION: "You can only hand over positions you hold.",
  NO_SUCCESSOR: "Add at least one successor.",
  SUCCESSOR_IS_YOU: "You can't hand a position over to yourself.",
  SUCCESSOR_IS_STAFF: "An RF or Hall Office member can't also be on the JCRC.",
  SUCCESSOR_NOT_SIGNED_IN:
    "A successor hasn't signed in to the app yet. Ask them to sign in once, then try again.",
  SELF_ASSIGNED_POSITION:
    "You added yourself to this position, so you can't hand it over. Ask an RF or Hall Office to assign it to you.",
  POSITION_NOT_STAFF_ASSIGNED:
    "Only positions an RF or Hall Office assigned to you can be handed over. Ask them to assign it to you first.",
  ALREADY_HANDED_OVER:
    "You've already handed this position over. An RF or Hall Office has to assign it to you again first.",
  STEP_OUT_ONLY_EARLIER:
    "Your step-out date can only move earlier. To undo a handover, ask an RF or Hall Office to assign the position to you again.",
  SCRC_DISABLED: "The Staff page is switched off right now.",
  SELF_ASSIGN:
    "You can't add yourself to a position. Ask another JCRC member to add you.",
  NO_STEP_OUT_PENDING: "You don't have a step-out date to change.",
  CONFLICT: "Someone changed this at the same time. Reload and try again.",
};

export function positionsErrorCopy(message: string | undefined): string {
  return (message && COPY[message]) ?? "That didn't work. Try again.";
}
