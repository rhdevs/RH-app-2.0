import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertDisposablesEnabled,
  isDisposablesEnabled,
  resetDisposablesFlagCache,
} from "../disposables/flag";
import {
  assertRemindersEnabled,
  isRemindersEnabled,
  resetRemindersFlagCache,
} from "../reminders/flag";

/** A db whose flag row is whatever `state.value` currently holds. */
function fakeDb(key: string) {
  const state = { value: "on" as string | null, fail: false };
  const findUnique = vi.fn(() => {
    if (state.fail) return Promise.reject(new Error("db down"));
    return Promise.resolve(
      state.value === null ? null : { key, value: state.value },
    );
  });
  return { db: { systemFlag: { findUnique } } as never, state, findUnique };
}

const CASES = [
  {
    name: "disposables.enabled",
    isOn: isDisposablesEnabled,
    assertOn: assertDisposablesEnabled,
    reset: resetDisposablesFlagCache,
    message: "DISPOSABLES_DISABLED",
  },
  {
    name: "reminders.enabled",
    isOn: isRemindersEnabled,
    assertOn: assertRemindersEnabled,
    reset: resetRemindersFlagCache,
    message: "REMINDERS_DISABLED",
  },
] as const;

describe.each(CASES)(
  "$name is cached for a short time (the header reads it on every page)",
  ({ name, isOn, assertOn, reset, message }) => {
    beforeEach(() => {
      reset();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
      reset();
    });

    it("reads the row once for calls inside the window", async () => {
      const { db, findUnique } = fakeDb(name);
      for (let i = 0; i < 5; i += 1) {
        expect(await isOn(db)).toBe(true);
      }
      expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it("reads again once the window has passed, and sees a change", async () => {
      const { db, state, findUnique } = fakeDb(name);
      expect(await isOn(db)).toBe(true);
      state.value = "off";
      vi.setSystemTime(new Date("2026-01-01T00:00:14Z"));
      expect(await isOn(db)).toBe(true);
      vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
      expect(await isOn(db)).toBe(false);
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it("does not cache a failed read: it is off, and the next call asks again", async () => {
      const { db, state, findUnique } = fakeDb(name);
      state.fail = true;
      expect(await isOn(db)).toBe(false);
      state.fail = false;
      expect(await isOn(db)).toBe(true);
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it("stays closed for an absent row or any value but exactly on", async () => {
      for (const value of [null, "off", "ON ", ""]) {
        reset();
        const { db, state } = fakeDb(name);
        state.value = value;
        expect(await isOn(db), String(value)).toBe(false);
      }
    });

    it("the assert refuses with the same answer", async () => {
      const { db, state } = fakeDb(name);
      state.value = "off";
      await expect(assertOn(db)).rejects.toMatchObject({
        code: "FORBIDDEN",
        message,
      });
    });

    it("the reset seam makes the next call read the row", async () => {
      const { db, state } = fakeDb(name);
      expect(await isOn(db)).toBe(true);
      state.value = "off";
      reset();
      expect(await isOn(db)).toBe(false);
    });
  },
);

describe("the two caches are separate", () => {
  it("resetting one does not drop the other", async () => {
    resetDisposablesFlagCache();
    resetRemindersFlagCache();
    const d = fakeDb("disposables.enabled");
    const r = fakeDb("reminders.enabled");
    await isDisposablesEnabled(d.db);
    await isRemindersEnabled(r.db);
    resetDisposablesFlagCache();
    await isDisposablesEnabled(d.db);
    await isRemindersEnabled(r.db);
    expect(d.findUnique).toHaveBeenCalledTimes(2);
    expect(r.findUnique).toHaveBeenCalledTimes(1);
    resetDisposablesFlagCache();
    resetRemindersFlagCache();
  });
});
