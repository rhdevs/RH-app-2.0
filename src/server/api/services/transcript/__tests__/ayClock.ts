import { afterEach, beforeEach, vi } from "vitest";

/** A moment inside AY2026/27, when its heads may edit and it may be opened. */
export const APR_2027 = new Date("2027-04-15T04:00:00Z");

/**
 * Database tests that call procedures run "today" = 15 April 2027, inside
 * AY2026/27, whatever the real date: the edit rights and Open transcripts read
 * the clock, so on the real one these tests would fail from 1 August 2027.
 * Only Date is faked, and it keeps ticking from there, so timers, the database
 * driver, "newest first" ordering and elapsed-time checks all behave as usual.
 * Call it inside the file's top-level describe.
 */
export function useAy2026Clock() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    vi.setSystemTime(APR_2027);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
