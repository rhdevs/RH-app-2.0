import { describe, expect, it } from "vitest";

import { saveStatus, statusVisible } from "../saveStatus";

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

describe("statusVisible", () => {
  it("always shows a warning, even while the form has unsaved edits", () => {
    expect(statusVisible(saveStatus("Saved.", false), true)).toBe(true);
    expect(statusVisible(saveStatus("Saved.", false), false)).toBe(true);
  });

  it("hides a plain 'saved' once the form has been edited again", () => {
    expect(statusVisible(saveStatus("Saved.", true), true)).toBe(false);
  });

  it("shows a plain 'saved' while the form is clean", () => {
    expect(statusVisible(saveStatus("Saved.", true), false)).toBe(true);
  });
});
