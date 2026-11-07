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
    "You added yourself to this position, so you can't hand it over. Ask another JCRC member, an RF or Hall Office to assign it to you.",
  ALREADY_HANDED_OVER:
    "You've already handed this position over. Someone else has to assign it to you again first.",
  ONE_SUCCESSOR_ONLY:
    "A position that gives director powers goes to one successor. Pick one person.",
  NEEDS_STAFF_CONFIRMATION:
    "You were handed this director position, so you can't hand it on yet. An admin, an RF or the Hall Office has to confirm you as its holder first.",
  HEADS_LISTED_CCA:
    "That person heads a CCA this position oversees, so they can't hold it.",
  STEP_OUT_LOCKED:
    "A position that gives director powers can't have its step-out date cancelled or moved later. You can still move it earlier.",
  SELF_ASSIGN:
    "You can't add yourself to a position. Ask another JCRC member to add you.",
  NO_STEP_OUT_PENDING: "You don't have a step-out date to change.",
  CONFLICT: "Someone changed this at the same time. Reload and try again.",
  POSITION_LOCKED:
    "This position gives director powers, so only an admin, an RF or the Hall Office can change its name, CCAs or holders.",
  SELF_ASSIGN_FLAGGED:
    "Nobody can add themselves to a position that gives director powers, admins included. Ask someone else to add you.",
  NOT_FLAGGED:
    "This panel only changes positions that give director powers. Use the Positions page for the others.",
  NOT_STAFF: "Only an admin, an RF or the Hall Office can use this.",
  SCRC_DISABLED:
    "The Staff tools are switched off. An admin can still edit positions on the Positions page.",
  ADMIN_REQUIRED: "Only an admin can set or clear director powers.",
  DIRECTORS_DISABLED: "Director powers are switched off.",
  CONFIRMATION_STALE:
    "The holders or CCAs changed while you were working. Reload and try again.",
  SELF_ASSIGNED_HOLDER:
    "A current holder added themselves to this position. Remove them and have someone else add them first.",
};

export function positionsErrorCopy(message: string | undefined): string {
  return (message && COPY[message]) ?? "That didn't work. Try again.";
}
