import { pointsErrorCopy } from "~/app/admin/points/_components/errorCopy";

export type LoadErrorInfo = { message: string; canRetry: boolean };

const LOAD_FAILED = "Couldn't load points entry.";
// pointsErrorCopy's answer when it recognises nothing; that wording is about saving.
const UNRECOGNISED = pointsErrorCopy("", undefined);

/** What to tell the leader when the page's reads fail, by tRPC error code. */
export function loadErrorInfo(error: {
  message: string;
  data?: { code?: string } | null;
}): LoadErrorInfo {
  const code = error.data?.code;
  if (code === "FORBIDDEN") {
    return {
      message: "Only this CCA's heads can enter points.",
      canRetry: false,
    };
  }
  if (code === "UNAUTHORIZED") {
    return { message: "You're signed out. Sign in again.", canRetry: false };
  }
  const copy = pointsErrorCopy(error.message, code);
  return {
    message: copy === UNRECOGNISED ? LOAD_FAILED : copy,
    canRetry: true,
  };
}
