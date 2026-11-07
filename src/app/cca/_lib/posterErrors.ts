/**
 * A readable line for a failed poster upload. The upload route's codes are
 * stable strings; anything else is never shown.
 */
export function describePosterError(message: string): string {
  if (message.includes("TOO_LARGE")) {
    return "That image is still too large after resizing. Try a smaller one.";
  }
  if (message.includes("PROPOSAL_NOT_EDITABLE")) {
    return "This proposal can no longer be edited.";
  }
  if (message.includes("PROPOSAL_NOT_FOUND")) {
    return "Only a head of this CCA can add a poster.";
  }
  if (message.includes("PROPOSALS_DISABLED")) {
    return "Proposals are not switched on.";
  }
  if (message.includes("RATE_LIMITED")) {
    return "You have uploaded a lot of posters in the last hour. Try again later.";
  }
  return "That image could not be uploaded. Try again.";
}
