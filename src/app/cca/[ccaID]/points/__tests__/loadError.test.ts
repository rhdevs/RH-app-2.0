import { describe, expect, it } from "vitest";

import { loadErrorInfo } from "../_components/loadError";

const err = (code: string | undefined, message = "") => ({
  message,
  data: code ? { code } : null,
});

describe("loadErrorInfo", () => {
  it("says an unauthorised viewer is signed out, with no retry", () => {
    expect(loadErrorInfo(err("UNAUTHORIZED"))).toEqual({
      message: "You're signed out. Sign in again.",
      canRetry: false,
    });
  });

  it("says only heads can enter points for FORBIDDEN, with no retry", () => {
    expect(loadErrorInfo(err("FORBIDDEN", "NOT_A_HEAD_OF_THIS_CCA"))).toEqual({
      message: "Only this CCA's heads can enter points.",
      canRetry: false,
    });
  });

  it("uses the shared copy for known server messages and keeps Retry", () => {
    expect(
      loadErrorInfo(err("INTERNAL_SERVER_ERROR", "NO_CANONICAL_IDENTITY")),
    ).toEqual({
      message:
        "Your account isn’t fully set up, so this can’t be changed. Sign out and back in.",
      canRetry: true,
    });
  });

  it("falls back to a load message, not a save message, for anything else", () => {
    expect(loadErrorInfo(err("INTERNAL_SERVER_ERROR", "boom"))).toEqual({
      message: "Couldn't load points entry.",
      canRetry: true,
    });
    expect(loadErrorInfo(err(undefined))).toEqual({
      message: "Couldn't load points entry.",
      canRetry: true,
    });
  });
});
