/**
 * A readable line for a failed evidence upload, record or removal. The routes'
 * codes are stable strings; anything else is never shown.
 */
export function describeEvidenceError(message: string): string {
  if (message.includes("TOO_LARGE")) {
    return "That photo is still too large after resizing. Try a smaller one.";
  }
  if (message.includes("EVIDENCE_TOO_MANY")) {
    return "This CCA already has the most photos it can hold before they are used. Remove one first.";
  }
  if (message.includes("EVIDENCE_ATTACHED")) {
    return "That photo is already part of a record and cannot be removed.";
  }
  if (message.includes("EVIDENCE_DUPLICATE")) {
    return "That photo has already been added.";
  }
  if (
    message.includes("NOT_EVIDENCE_HEAD") ||
    message.includes("EVIDENCE_NOT_FOUND")
  ) {
    return "Only a head of this CCA can add or remove photos.";
  }
  if (message.includes("MILESTONES_DISABLED")) {
    return "Milestone evidence is not switched on.";
  }
  if (message.includes("MILESTONE_STORAGE_NOT_CONFIGURED")) {
    return "Photo storage is not set up yet. Tell an admin.";
  }
  if (message.includes("RATE_LIMITED")) {
    return "You have done a lot with photos in the last hour. Try again later.";
  }
  return "That did not work. Try again.";
}
