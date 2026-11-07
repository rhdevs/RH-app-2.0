import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertProposalsEnabled,
  isProposalsEnabled,
  resetProposalsFlagCache,
} from "../proposals/flag";

/** A db whose flag row is whatever `value` currently holds. */
function fakeDb() {
  const state = { value: "on" as string | null, fail: false };
  const findUnique = vi.fn(() => {
    if (state.fail) return Promise.reject(new Error("db down"));
    return Promise.resolve(
      state.value === null
        ? null
        : { key: "proposals.enabled", value: state.value },
    );
  });
  return { db: { systemFlag: { findUnique } } as never, state, findUnique };
}

describe("isProposalsEnabled caches the flag for a short time", () => {
  beforeEach(() => {
    resetProposalsFlagCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    resetProposalsFlagCache();
  });

  it("reads the row once for calls inside the window", async () => {
    const { db, findUnique } = fakeDb();
    for (let i = 0; i < 5; i += 1) {
      expect(await isProposalsEnabled(db)).toBe(true);
    }
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("reads again once the window has passed, and sees a change", async () => {
    const { db, state, findUnique } = fakeDb();
    expect(await isProposalsEnabled(db)).toBe(true);
    state.value = "off";
    vi.setSystemTime(new Date("2026-01-01T00:00:14Z"));
    expect(await isProposalsEnabled(db)).toBe(true);
    vi.setSystemTime(new Date("2026-01-01T00:00:16Z"));
    expect(await isProposalsEnabled(db)).toBe(false);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed read: it is off, and the next call asks again", async () => {
    const { db, state, findUnique } = fakeDb();
    state.fail = true;
    expect(await isProposalsEnabled(db)).toBe(false);
    state.fail = false;
    expect(await isProposalsEnabled(db)).toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("stays closed for an absent row or any value but exactly on", async () => {
    for (const value of [null, "off", "ON ", ""]) {
      resetProposalsFlagCache();
      const { db, state } = fakeDb();
      state.value = value;
      expect(await isProposalsEnabled(db), String(value)).toBe(false);
    }
  });

  it("assertProposalsEnabled refuses with the same answer", async () => {
    const { db, state } = fakeDb();
    state.value = "off";
    await expect(assertProposalsEnabled(db)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "PROPOSALS_DISABLED",
    });
  });

  it("the reset seam makes the next call read the row", async () => {
    const { db, state } = fakeDb();
    expect(await isProposalsEnabled(db)).toBe(true);
    state.value = "off";
    resetProposalsFlagCache();
    expect(await isProposalsEnabled(db)).toBe(false);
  });
});
