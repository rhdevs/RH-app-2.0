import { describe, expect, it } from "vitest";

import { saveStatus } from "../saveStatus";

describe("saveStatus", () => {
  it("passes the message through when the settings reloaded", () => {
    expect(saveStatus("Saved the waiver.", true)).toEqual({
      text: "Saved the waiver.",
      tone: "ok",
    });
  });

  it("warns that the page may show stale settings when the reload failed", () => {
    expect(saveStatus("Saved the waiver.", false)).toEqual({
      text: "Saved, but couldn't reload the current settings. Reload the page.",
      tone: "warn",
    });
  });
});
