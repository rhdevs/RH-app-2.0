import { describe, expect, it } from "vitest";

import {
  dayKey,
  epochToLocalInput,
  formatDateRange,
  formatDateTime,
  isStillOn,
  localInputToEpoch,
} from "./format";

// 2026-08-06 23:30 SGT is 15:30 UTC — the late-evening case that crosses the
// UTC date line and broke on a device not set to Singapore time.
const LATE_EVENING = Date.UTC(2026, 7, 6, 15, 30) / 1000;

describe("event dates are Singapore time whatever the device says", () => {
  it("renders a datetime-local value in SGT", () => {
    expect(epochToLocalInput(LATE_EVENING)).toBe("2026-08-06T23:30");
  });

  it("reads a datetime-local value as SGT", () => {
    expect(localInputToEpoch("2026-08-06T23:30")).toBe(LATE_EVENING);
  });

  it("round-trips through the input", () => {
    expect(localInputToEpoch(epochToLocalInput(LATE_EVENING))).toBe(
      LATE_EVENING,
    );
  });

  it("rejects a malformed input", () => {
    expect(localInputToEpoch("")).toBeNull();
    expect(localInputToEpoch("not a date")).toBeNull();
  });

  it("groups by the SGT day", () => {
    expect(dayKey(LATE_EVENING)).toBe("2026-08-06");
  });

  it("formats the SGT wall time", () => {
    expect(formatDateTime(LATE_EVENING)).toMatch(/11:30/);
    expect(formatDateTime(null)).toBe("Date TBC");
  });

  it("collapses a same-SGT-day range", () => {
    const end = LATE_EVENING + 20 * 60;
    expect(formatDateRange(LATE_EVENING, end)).toMatch(/– 11:50/);
  });
});

describe("isStillOn", () => {
  const now = 1_000_000;

  it("keeps an event that has started but not ended", () => {
    expect(isStillOn({ startTime: now - 60, endTime: now + 60 }, now)).toBe(
      true,
    );
  });

  it("drops an event once it has ended", () => {
    expect(isStillOn({ startTime: now - 120, endTime: now - 60 }, now)).toBe(
      false,
    );
  });

  it("falls back to the start when there is no end", () => {
    expect(isStillOn({ startTime: now + 1, endTime: null }, now)).toBe(true);
    expect(isStillOn({ startTime: now - 1, endTime: null }, now)).toBe(false);
  });

  it("keeps an event with no date yet", () => {
    expect(isStillOn({ startTime: null, endTime: null }, now)).toBe(true);
  });
});
