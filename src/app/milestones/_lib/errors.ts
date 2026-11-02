/**
 * A readable line for a failed milestone call. The server's codes are stable
 * strings; anything else is never shown.
 */
export function describeMilestoneError(message: string): string {
  if (message.includes("MILESTONES_DISABLED")) {
    return "Milestones are not switched on.";
  }
  if (message.includes("MILESTONE_FROZEN")) {
    return "A director has already rated this milestone, so it can no longer change.";
  }
  if (message.includes("MILESTONE_ALREADY_RATED")) {
    return "This milestone has already been rated.";
  }
  if (message.includes("MILESTONE_CONFLICT")) {
    return "Someone else changed this milestone at the same time. It has been reloaded; check it and try again.";
  }
  if (message.includes("MILESTONE_NOT_OPEN")) {
    return "This milestone cannot be filed or rated now. It opens when the event has ended and stays closed if the event was canceled.";
  }
  if (message.includes("MILESTONE_NOTHING_TO_RATE")) {
    return "There is nothing to rate yet. The head needs to attach at least one photo.";
  }
  if (message.includes("MILESTONE_TOO_MANY_PHOTOS")) {
    return "A milestone can hold at most 12 photos.";
  }
  if (message.includes("EVIDENCE_TOO_OLD")) {
    return "That photo is too old to attach. Add it again.";
  }
  if (message.includes("EVIDENCE_ALREADY_ATTACHED")) {
    return "That photo is already used by a milestone.";
  }
  if (message.includes("EVIDENCE_ATTACH_CONFLICT")) {
    return "A photo changed while it was being attached. Reload and try again.";
  }
  if (message.includes("EVIDENCE_STORAGE_UNAVAILABLE")) {
    return "The photo could not be removed from storage. Try again.";
  }
  if (
    message.includes("MILESTONE_NOT_FOUND") ||
    message.includes("EVIDENCE_NOT_FOUND")
  ) {
    return "That milestone or photo was not found, or you are not a head or director of its CCA.";
  }
  if (message.includes("MILESTONE_ACCESS_CHECK_FAILED")) {
    return "Your access could not be checked. Try again shortly.";
  }
  if (message.includes("RATE_LIMITED")) {
    return "You have done a lot in the last hour. Try again later.";
  }
  return "That did not work. Try again.";
}

/** The label shown on a rating a director gave to a CCA they also head. */
export const SELF_RATED_LABEL =
  "Rated by a director who is also a head of this CCA";
