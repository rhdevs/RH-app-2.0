/**
 * Plain-English copy for a failed /admin/points write. The sentinels are the
 * ones `roleManagerProcedure` and requirePointsCapability can throw (see
 * RecruitmentControlPanel's setStateErrorCopy for the walk through the middleware
 * chain); `sanitizeErrors` only rewrites INTERNAL_SERVER_ERROR, so they reach
 * the client verbatim. BAD_REQUEST messages are already plain English, written
 * by the server for exactly this screen, so they are shown as they are.
 */
export function pointsErrorCopy(message: string, code?: string): string {
  if (code === "UNAUTHORIZED") {
    return "You’re signed out. Sign in again to change this.";
  }
  if (
    message.startsWith("CAPABILITY_REQUIRED") ||
    message === "INSUFFICIENT_ROLE"
  ) {
    return "You don’t have permission to change this any more. Reload the page.";
  }
  if (
    message === "NO_CANONICAL_IDENTITY" ||
    message === "NUS_ACCOUNT_REQUIRED"
  ) {
    return "Your account isn’t fully set up, so this can’t be changed. Sign out and back in.";
  }
  if (message === "CCA_NOT_FOUND") return "That CCA no longer exists.";
  if (code === "BAD_REQUEST" && message) return message;
  return "That didn’t save. Try again.";
}
